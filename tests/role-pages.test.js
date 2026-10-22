// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { inArray } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const rolePages = require("../services/rolePages.service");
const pfiRoles = require("../services/pfiRoles.service");
const { isViewOnlyPage } = require("../middleware/viewOnlyPages");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Standard pages per role, and roles given by PFI slots (migration 0096).
 *
 * What has to hold: a person's pages are everyone's plus their roles', with
 * their own ticks on top; admins are never narrowed; nothing changes while
 * the switch is off. Naming somebody in a slot gives them its role; emptying
 * the slot or closing the PFI takes it back; a role they hold in their own
 * right is never taken; Manage Users keeps the PFI roles when it saves their
 * own; and on a PFI already trading, who can open it follows its slots.
 */
const RUN = Date.now();
const created = [];

let superToken;
let officer;
let officerToken;
let other;

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  put: (url, body) => request(app).put(url).set("Authorization", `Bearer ${t}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${t}`).send(body),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${t}`).send(body),
});

const rolesOf = async (id) => (await client`SELECT roles FROM staff WHERE id = ${id}`)[0].roles;
const givenOf = async (id) => (await client`SELECT role FROM staff_pfi_roles WHERE staff_id = ${id} ORDER BY role`).map((r) => r.role);
const sees = async (staffId, pfiId) =>
  (await client`SELECT 1 FROM pfi_staff WHERE staff_id = ${staffId} AND pfi_id = ${pfiId}`).length > 0;

const activePfi = async (label, values = {}) => {
  const [row] = await db
    .insert(pfis)
    .values({ pfiNumber: `PFI/ROLES/${label}/${RUN}`, status: "active", startingQtyLitres: 1000, ...values })
    .returning();
  created.push(row.id);
  return row;
};

describe("role pages and roles from PFI slots", () => {
  before(async () => {
    superToken = await staffToken(request, app);
    const a = await staffTokenWithRoles(["finance"], `role-pages-a-${RUN}@soroman.test`);
    officer = a.staff;
    officerToken = a.accessToken;
    other = (await staffTokenWithRoles(["ticketing"], `role-pages-b-${RUN}@soroman.test`)).staff;
    await rolePages.setEnabled(true, null);
  });

  after(async () => {
    await rolePages.setEnabled(true, null);
    await pfiRoles.takeBackAll();
    await rolePages.setEnabled(false, null);
    await client`DELETE FROM pfi_staff WHERE staff_id IN (${officer.id}, ${other.id})`;
    if (created.length) await db.delete(pfis).where(inArray(pfis.id, created));
    await closeDb();
  });

  test("a person's pages are everyone's plus their roles', and full beats view only", () => {
    const sets = new Map([
      ["everyone", [{ routePath: "/overview", viewOnly: false }]],
      ["audit", [{ routePath: "/orders", viewOnly: true }, { routePath: "/pfi", viewOnly: true }]],
      ["finance", [{ routePath: "/orders", viewOnly: false }]],
    ]);
    assert.deepEqual(rolePages.pagesForRoles(sets, ["audit", "finance"]), [
      { routePath: "/orders", viewOnly: false },
      { routePath: "/overview", viewOnly: false },
      { routePath: "/pfi", viewOnly: true },
    ]);
  });

  test("admins are never narrowed, and nothing is decided while the switch is off", async () => {
    assert.equal(await rolePages.pagesFor(["admin", "finance"]), null);
    assert.equal(await rolePages.pagesFor(["super_admin"]), null);
    const finance = await rolePages.pagesFor(["finance"]);
    assert.ok(finance.some((p) => p.routePath === "/confirmed-payments"));
    assert.ok(finance.some((p) => p.routePath === "/overview"), "the everyone set comes with every role");

    await rolePages.setEnabled(false, null);
    try {
      assert.equal(await rolePages.pagesFor(["finance"]), null);
    } finally {
      await rolePages.setEnabled(true, null);
    }
  });

  test("naming somebody in a slot gives its role; emptying the slot takes it back", async () => {
    const res = await as(superToken).post("/api/pfis", {
      pfi_number: `PFI/ROLES/NEW/${RUN}`,
      starting_qty_litres: 1000,
      ticketing_officer: officer.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const pfi = res.body.data.pfi;
    created.push(pfi.id);
    assert.equal(pfi.ticketingOfficerId, officer.id);

    assert.deepEqual(await rolesOf(officer.id), ["finance", "ticketing"]);
    assert.deepEqual(await givenOf(officer.id), ["ticketing"]);

    const emptied = await as(superToken).patch(`/api/pfis/${pfi.id}`, { ticketing_officer: "" });
    assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
    assert.deepEqual(await rolesOf(officer.id), ["finance"]);
    assert.deepEqual(await givenOf(officer.id), []);
  });

  test("a role held in their own right is never taken back", async () => {
    const pfi = await activePfi("OWN", { ticketingOfficerId: other.id });
    await pfiRoles.recompute({ staffIds: [other.id] });
    assert.deepEqual(await rolesOf(other.id), ["ticketing"]);
    assert.deepEqual(await givenOf(other.id), []);

    await as(superToken).patch(`/api/pfis/${pfi.id}`, { ticketing_officer: "" });
    assert.deepEqual(await rolesOf(other.id), ["ticketing"]);
  });

  test("selling out keeps the role; closing the PFI takes it back", async () => {
    const pfi = await activePfi("CLOSE", { gateEntryOfficerId: officer.id });
    await pfiRoles.recompute({ staffIds: [officer.id] });
    assert.ok((await rolesOf(officer.id)).includes("security_entry"));

    // Sold out: finished, never closed — trucks may still be at the gate.
    await client`UPDATE pfis SET status = 'finished' WHERE id = ${pfi.id}`;
    await pfiRoles.recompute({ staffIds: [officer.id] });
    assert.ok((await rolesOf(officer.id)).includes("security_entry"));

    await client`UPDATE pfis SET status = 'active' WHERE id = ${pfi.id}`;
    const closed = await as(superToken).post(`/api/pfis/${pfi.id}/finish`, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(await rolesOf(officer.id), ["finance"]);
  });

  test("Manage Users saves their own roles and keeps the ones a PFI gives", async () => {
    const pfi = await activePfi("KEEP", { stockOfficerId: officer.id });
    await pfiRoles.recompute({ staffIds: [officer.id] });
    assert.deepEqual(await rolesOf(officer.id), ["finance", "stock_officer"]);

    // 2 finance, 8 audit (config/roleMapping.js) — the form sends their own only.
    const saved = await as(superToken).patch(`/api/admin/${officer.id}`, { roles: [2, 8] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(await rolesOf(officer.id), ["finance", "audit", "stock_officer"]);
    assert.deepEqual(await givenOf(officer.id), ["stock_officer"]);

    const shown = await as(superToken).get(`/api/admin/${officer.id}`);
    assert.deepEqual(shown.body.data.admin.pfiRoles, ["stock_officer"]);
    assert.ok(shown.body.data.admin.pfiSlots.some((s) => s.pfiId === pfi.id && s.label === "Stock Officer"));

    // Ticking the PFI's role as their own makes it theirs: emptying the slot leaves it.
    await as(superToken).patch(`/api/admin/${officer.id}`, { roles: [2, 45] });
    assert.deepEqual(await givenOf(officer.id), []);
    await as(superToken).patch(`/api/pfis/${pfi.id}`, { stock_officer: "" });
    assert.deepEqual(await rolesOf(officer.id), ["finance", "stock_officer"]);

    await as(superToken).patch(`/api/admin/${officer.id}`, { roles: [2] });
    assert.deepEqual(await rolesOf(officer.id), ["finance"]);
  });

  test("on a PFI already trading, who can open it follows its slots", async () => {
    const pfi = await activePfi("SIGHT");
    // `other` is given the PFI by hand in Manage Users.
    await as(superToken).patch(`/api/admin/${other.id}`, { can_view_all_locations: false, pfi_ids: [pfi.id] });
    assert.equal(await sees(other.id, pfi.id), true);

    await as(superToken).patch(`/api/pfis/${pfi.id}`, { ticketing_officer: officer.id });
    assert.equal(await sees(officer.id, pfi.id), true, "the new officer can open it");

    await as(superToken).patch(`/api/pfis/${pfi.id}`, { ticketing_officer: other.id });
    assert.equal(await sees(officer.id, pfi.id), false, "the officer replaced cannot");
    assert.equal(await sees(other.id, pfi.id), true);

    await as(superToken).patch(`/api/pfis/${pfi.id}`, { ticketing_officer: "" });
    assert.equal(await sees(other.id, pfi.id), true, "a PFI ticked in Manage Users stays theirs");

    const [log] = await client`
      SELECT source FROM pfi_assignment_log
       WHERE staff_id = ${officer.id} AND pfi_id = ${pfi.id} AND action = 'assigned' ORDER BY id DESC LIMIT 1`;
    assert.equal(log.source, "pfi_officers");
  });

  test("Manage Users cannot untick a PFI that names them", async () => {
    const pfi = await activePfi("NAMED");
    await as(superToken).patch(`/api/pfis/${pfi.id}`, { truck_sales_officer: officer.id });
    assert.equal(await sees(officer.id, pfi.id), true);

    await as(superToken).patch(`/api/admin/${officer.id}`, { can_view_all_locations: true, pfi_ids: [] });
    assert.equal(await sees(officer.id, pfi.id), true);

    await as(superToken).patch(`/api/pfis/${pfi.id}`, { truck_sales_officer: "" });
    assert.equal(await sees(officer.id, pfi.id), false);
  });

  test("a page a role opens as view only refuses writes, unless their own tick says full", () => {
    const user = { roles: ["audit"], pageOverrides: [], rolePages: [{ routePath: "/expenses", viewOnly: true }] };
    assert.equal(isViewOnlyPage(user, "/expenses"), true);
    assert.equal(isViewOnlyPage({ ...user, pageOverrides: [{ routePath: "/expenses", allowed: true, viewOnly: false }] }, "/expenses"), false);
    assert.equal(isViewOnlyPage({ ...user, rolePages: null }, "/expenses"), false);
  });

  test("the session carries the pages their roles open", async () => {
    const me = await as(officerToken).get("/api/auth/me");
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const paths = me.body.data.session.rolePages.map((p) => p.routePath);
    assert.ok(paths.includes("/confirmed-payments"));
    assert.ok(paths.includes("/overview"));
  });

  test("only admins change the sets, and pages with their own rule cannot be put in one", async () => {
    const read = await as(officerToken).get("/api/role-pages");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const before = read.body.data.sets.product_manager;
    assert.ok(read.body.data.slots.some((s) => s.key === "ticketingOfficerId" && s.role === "ticketing"));

    assert.equal((await as(officerToken).put("/api/role-pages/product_manager", { pages: [] })).status, 403);
    assert.equal((await as(officerToken).put("/api/role-pages/switch", { enabled: false })).status, 403);

    const own = await as(superToken).put("/api/role-pages/product_manager", { pages: [{ routePath: "/accounts/ledger" }] });
    assert.equal(own.status, 400, JSON.stringify(own.body));
    assert.equal((await as(superToken).put("/api/role-pages/admin", { pages: [] })).status, 400);

    try {
      const saved = await as(superToken).put("/api/role-pages/product_manager", {
        pages: [{ routePath: "/orders" }, { routePath: "/pfi", viewOnly: true }],
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body.data.pages, [
        { routePath: "/orders", viewOnly: false },
        { routePath: "/pfi", viewOnly: true },
      ]);
    } finally {
      await as(superToken).put("/api/role-pages/product_manager", { pages: before });
    }
  });

  test("turning the switch off takes every PFI role back, and on gives them again", async () => {
    await activePfi("SWITCH", { commissionOfficerId: officer.id });
    await pfiRoles.recompute({ staffIds: [officer.id] });
    assert.ok((await rolesOf(officer.id)).includes("commissions"));

    const preview = await as(superToken).get("/api/role-pages/preview");
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const row = preview.body.data.people.find((p) => p.id === officer.id);
    assert.deepEqual(row.ownRoles, ["finance"]);
    assert.ok(row.fromPfis.commissions.includes(`PFI/ROLES/SWITCH/${RUN}`));

    const off = await as(superToken).put("/api/role-pages/switch", { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.enabled, false);
    assert.deepEqual(await rolesOf(officer.id), ["finance"]);
    assert.deepEqual(await givenOf(officer.id), []);

    const on = await as(superToken).put("/api/role-pages/switch", { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.ok((await rolesOf(officer.id)).includes("commissions"));
  });
});
