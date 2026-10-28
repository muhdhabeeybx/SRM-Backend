// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");
const { asOnPage, pagePfiIds } = require("../middleware/pagePfis");
const { isConfined, scopedPfiIds } = require("../lib/pfiScope");

/**
 * A page with a PFI list of its own (migration 0100). The owner (28 Oct 2026):
 * "someone can only see pending payments on only selected pfis and can see
 * other pfis on delivery inventory too".
 */
const RUN = Date.now();
const EMAIL = `page-pfis-${RUN}@soroman.test`;

const person = (over = {}) => ({
  roles: ["finance"],
  canViewAllLocations: false,
  scope: { depotIds: [7], lpgStationIds: [], fillingStationIds: [3], pfiIds: [1, 2] },
  pageOverrides: [{ routePath: "/payable-orders", allowed: true, viewOnly: false, pfiIds: [5] }],
  slotPfiIds: [],
  ...over,
});

describe("PFIs per page — the rule", () => {
  test("a page with a list answers with it; any other page with their own PFIs", () => {
    const user = person();
    assert.deepEqual(asOnPage(user, "/payable-orders").scope.pfiIds, [5]);
    assert.equal(asOnPage(user, "/delivery-operations"), user, "no list of its own: untouched");
    assert.equal(asOnPage(user, null), user);
  });

  test("PFIs that name them in a slot show on every page", () => {
    const user = person({ slotPfiIds: [9, 5] });
    assert.deepEqual(asOnPage(user, "/payable-orders").scope.pfiIds, [5, 9]);
  });

  test("rows with no PFI keep their own reach", () => {
    const picked = asOnPage(person(), "/payable-orders");
    assert.deepEqual(picked.scope.depotIds, [7], "narrowed to places: keeps them");
    assert.deepEqual(picked.scope.fillingStationIds, [3]);

    const everywhere = asOnPage(person({ canViewAllLocations: true }), "/payable-orders");
    assert.equal(everywhere.canViewAllLocations, false);
    assert.deepEqual(everywhere.scope.depotIds, [], "on Everything: no place narrows them");
    assert.deepEqual(everywhere.scope.fillingStationIds, []);
    assert.deepEqual(scopedPfiIds(everywhere), [5]);
  });

  test("who they are does not change: Everything is not confined to PFIs on that page", () => {
    const everywhere = asOnPage(person({ canViewAllLocations: true }), "/payable-orders");
    assert.equal(isConfined(everywhere), false);
    assert.equal(isConfined(asOnPage(person({ scope: { pfiIds: [1] } }), "/payable-orders")), true, "a PFI person stays one");
  });

  test("only an allowed row with PFIs counts, and never for a super admin", () => {
    const row = (o) => person({ pageOverrides: [{ routePath: "/payable-orders", allowed: true, viewOnly: false, pfiIds: [5], ...o }] });
    assert.equal(pagePfiIds(row({ allowed: false }), "/payable-orders"), null);
    assert.equal(pagePfiIds(row({ pfiIds: [] }), "/payable-orders"), null, "empty is their PFIs, never nothing");
    assert.equal(pagePfiIds(row({ pfiIds: null }), "/payable-orders"), null);
    assert.equal(pagePfiIds(person({ roles: ["super_admin"] }), "/payable-orders"), null);
    assert.equal(pagePfiIds(row({}), "/payable-orders/"), null, "exact page, like view only");
  });
});

describe("PFIs per page — through the API", () => {
  let admin;
  let finance;
  let staffId;
  let pickedPfi;
  let allPayable;

  const get = (token, url, page) => {
    const r = request(app).get(url).set("Authorization", `Bearer ${token}`);
    return page ? r.set("X-Dashboard-Page", page) : r;
  };
  const payable = (body) => {
    const d = body?.data;
    return Array.isArray(d) ? d : d?.orders ?? d?.payable ?? [];
  };

  before(async () => {
    admin = (await staffToken(request, app));
    const s = await staffTokenWithRoles(["finance", "admin"], EMAIL);
    finance = s.accessToken;
    staffId = s.staff.id;
    await client`UPDATE staff SET can_view_all_locations = true WHERE id = ${staffId}`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ${staffId}`;

    allPayable = payable((await get(admin, "/api/orders/payable")).body);
    const byPfi = new Map();
    for (const o of allPayable) if (o.pfiId != null) byPfi.set(Number(o.pfiId), (byPfi.get(Number(o.pfiId)) || 0) + 1);
    // A PFI holding some of the waiting orders but not all of them.
    pickedPfi = [...byPfi.entries()].find(([, n]) => n < allPayable.length)?.[0];
  });

  after(async () => {
    await client`DELETE FROM staff_page_overrides WHERE staff_id = ${staffId}`.catch(() => {});
    await client`DELETE FROM staff WHERE email = ${EMAIL}`.catch(() => {});
    await closeDb();
  });

  test("Manage Users keeps a page's PFIs, and an empty pick as their own", async () => {
    const save = (overrides) => request(app).patch(`/api/admin/${staffId}`).set("Authorization", `Bearer ${admin}`).send({ page_overrides: overrides });
    const res = await save([
      { route_path: "/payable-orders", allowed: true, pfi_ids: [pickedPfi ?? 1, String(pickedPfi ?? 1)] },
      { route_path: "/orders", allowed: true, pfi_ids: [] },
      { route_path: "/deposits", allowed: false, pfi_ids: [4] },
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await client`SELECT route_path, pfi_ids FROM staff_page_overrides WHERE staff_id = ${staffId} ORDER BY route_path`;
    const byPath = Object.fromEntries(rows.map((r) => [r.route_path, r.pfi_ids]));
    assert.deepEqual(byPath["/payable-orders"], [pickedPfi ?? 1]);
    assert.equal(byPath["/orders"], null);
    assert.equal(byPath["/deposits"], null, "a page they do not have keeps no list");

    const detail = await get(admin, `/api/admin/${staffId}`);
    const overrides = detail.body.data?.pageOverrides ?? detail.body.data?.admin?.pageOverrides ?? [];
    assert.deepEqual(overrides.find((o) => o.routePath === "/payable-orders")?.pfiIds, [pickedPfi ?? 1]);
  });

  test("Pending Payments shows the page's PFIs; other pages show everything", async (t) => {
    if (pickedPfi == null) return t.skip("the test database needs orders awaiting payment on two PFIs");

    const narrowed = await get(finance, "/api/orders/payable", "/payable-orders");
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    const rows = payable(narrowed.body);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((o) => Number(o.pfiId) === pickedPfi), "only the picked PFI");

    const elsewhere = await get(finance, "/api/orders/payable", "/delivery-operations");
    assert.equal(payable(elsewhere.body).length, allPayable.length, "a page with no list: everything, as before");

    // The menu count follows Pending Payments' own list from any page.
    const counts = (await get(finance, "/api/dashboard/work-queues", "/delivery-operations")).body.data.counts;
    assert.equal(counts["/payable-orders"], rows.length);
  });

  test("a non-PFI area is not refused from that page", async () => {
    const res = await get(finance, "/api/contacts?limit=1", "/payable-orders");
    assert.notEqual(res.status, 403, JSON.stringify(res.body));
  });
});
