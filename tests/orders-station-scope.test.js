// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");
const { confinedAwayFromOrders } = require("../lib/scopeFilter");

/**
 * Somebody confined to filling stations alone — no depot, no PFI — is shown
 * no depot orders (the owner, 26 Oct 2026). Before, scopeCondition read them
 * as "assigned nothing" and narrowed nothing, so David Andrew (the seven
 * stations, finance through a PFI slot) saw every depot's orders on Pending
 * Orders. Somebody assigned nothing at all still sees everything.
 */
const RUN = Date.now();
let admin;
let stationOnly;
let stationStaff;
let unassigned;
let station;

const get = (token, url) => request(app).get(url).set("Authorization", `Bearer ${token}`);
const rowsOf = (body) => {
  const d = body?.data;
  return Array.isArray(d) ? d : d?.orders ?? d?.payable ?? [];
};

describe("depot orders and people confined to stations", () => {
  before(async () => {
    admin = await staffToken(request, app);
    const s = await staffTokenWithRoles(["finance", "truck_sales"], `station-only-${RUN}@soroman.test`);
    stationOnly = s.accessToken;
    stationStaff = s.staff;
    unassigned = (await staffTokenWithRoles(["finance"], `no-scope-${RUN}@soroman.test`)).accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${stationStaff.id}`;
    [station] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`Scope Station ${RUN}`}, ${`0807${String(RUN).slice(-7)}`}) RETURNING id`;
    await client`INSERT INTO filling_station_staff (staff_id, delivery_customer_id) VALUES (${stationStaff.id}, ${station.id})`;
  });

  after(async () => {
    await client`DELETE FROM filling_station_staff WHERE delivery_customer_id = ${station.id}`;
    await client`DELETE FROM delivery_customers WHERE id = ${station.id}`;
    await client`DELETE FROM staff WHERE email IN (${`station-only-${RUN}@soroman.test`}, ${`no-scope-${RUN}@soroman.test`})`.catch(() => {});
    await closeDb();
  });

  test("the rule: stations or plants alone, no depot or PFI", () => {
    const user = (scope) => ({ canViewAllLocations: false, scope: { depotIds: [], pfiIds: [], lpgStationIds: [], fillingStationIds: [], ...scope } });
    assert.equal(confinedAwayFromOrders(user({ fillingStationIds: [1] })), true);
    assert.equal(confinedAwayFromOrders(user({ lpgStationIds: [1] })), true);
    assert.equal(confinedAwayFromOrders(user({ fillingStationIds: [1], pfiIds: [2] })), false, "a PFI is theirs");
    assert.equal(confinedAwayFromOrders(user({ fillingStationIds: [1], depotIds: [2] })), false, "a depot is theirs");
    assert.equal(confinedAwayFromOrders(user({})), false, "assigned nothing: not narrowed");
    assert.equal(confinedAwayFromOrders({ canViewAllLocations: true, scope: { fillingStationIds: [1] } }), false);
  });

  test("Pending Orders shows them no depot orders", async () => {
    const all = await get(admin, "/api/orders/payable");
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(rowsOf(all.body).length > 0, "the test database has orders awaiting payment");

    const theirs = await get(stationOnly, "/api/orders/payable");
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(rowsOf(theirs.body).length, 0);

    const open = await get(unassigned, "/api/orders/payable");
    assert.equal(rowsOf(open.body).length, rowsOf(all.body).length, "somebody assigned nothing still sees every order");
  });

  test("nor on the orders list, nor on their order badges", async () => {
    assert.ok(rowsOf((await get(admin, "/api/orders?limit=5")).body).length > 0);
    const list = await get(stationOnly, "/api/orders?limit=5");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(rowsOf(list.body).length, 0);

    const counts = async (token) => (await get(token, "/api/dashboard/work-queues")).body.data.counts;
    assert.ok((await counts(admin))["/payable-orders"] > 0);
    // Zero counts are left out of the reply.
    const theirs = await counts(stationOnly);
    assert.equal(theirs["/payable-orders"] ?? 0, 0);
    assert.equal(theirs["/ticket"] ?? 0, 0);
  });
});
