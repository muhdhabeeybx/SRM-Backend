require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffScopeRepo } = require("../repositories");
const expenseRepo = require("../repositories/pfiExpense.repository");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * Staff assigned filling stations see those stations and nothing else of the
 * kind: the station list, a station opened by id, its truck sales and its
 * expenses. Somebody with no stations assigned is not narrowed at all.
 */
const RUN = `SS${Date.now()}`.slice(-10);

describe("filling-station scope", () => {
  let admin;
  let scoped;
  let staffId;
  let mine;
  let other;
  const saleIds = [];
  const expenseIds = [];

  before(async () => {
    admin = await staffToken(request, app);
    const [a, b] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`${RUN} Mine`}, '0800000001'),
             ('filling_station', ${`${RUN} Other`}, '0800000002')
      RETURNING id`;
    mine = Number(a.id);
    other = Number(b.id);

    const sales = await client`
      INSERT INTO delivery_sales (customer_id, customer_name, truck_number)
      VALUES (${mine}, ${`${RUN} Mine`}, ${`${RUN}-T1`}), (${other}, ${`${RUN} Other`}, ${`${RUN}-T2`})
      RETURNING id`;
    saleIds.push(...sales.map((s) => Number(s.id)));

    const [cat] = await client`SELECT id FROM expense_categories ORDER BY id LIMIT 1`;
    const exps = await client`
      INSERT INTO pfi_expenses (category_id, amount, exchange_rate, description, delivery_customer_id)
      VALUES (${cat.id}, 100, 1, ${`${RUN} mine`}, ${mine}), (${cat.id}, 200, 1, ${`${RUN} other`}, ${other})
      RETURNING id`;
    expenseIds.push(...exps.map((e) => Number(e.id)));

    const weak = await staffTokenWithRoles(["admin"], `station-scope-${RUN}@soroman.test`);
    staffId = weak.staff.id;
    scoped = weak.accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${staffId}`;
    await staffScopeRepo.setScope(staffId, { fillingStationIds: [mine] });
  });

  after(async () => {
    await client`DELETE FROM pfi_expenses WHERE id = ANY(${expenseIds})`;
    await client`DELETE FROM delivery_sales WHERE id = ANY(${saleIds})`;
    if (staffId) {
      await client`DELETE FROM filling_station_staff WHERE staff_id = ${staffId}`;
    }
    await client`DELETE FROM delivery_customers WHERE id = ANY(${[mine, other].filter(Boolean)})`;
    await closeDb();
  });

  const get = (token, url) => request(app).get(url).set("Authorization", `Bearer ${token}`);

  test("the station list shows only the assigned station", async () => {
    const res = await get(scoped, `/api/filing-stations?search=${RUN}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.stations.map((s) => Number(s.id)), [mine]);

    const all = await get(admin, `/api/filing-stations?search=${RUN}`);
    assert.equal(all.body.data.stations.length, 2, "a full-access user is not narrowed");
  });

  test("an unassigned station opened by id is not found", async () => {
    assert.equal((await get(scoped, `/api/filing-stations/${mine}`)).status, 200);
    assert.equal((await get(scoped, `/api/filing-stations/${other}`)).status, 404);
  });

  test("truck sales are only the assigned station's", async () => {
    const res = await get(scoped, `/api/delivery-sales?search=${RUN}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.data.sales ?? res.body.data.rows ?? res.body.data;
    assert.deepEqual(rows.map((r) => Number(r.customerId)), [mine]);
    assert.equal((await get(scoped, `/api/delivery-sales/${saleIds[1]}`)).status, 404);
  });

  test("a sale cannot be recorded for a station that is not theirs", async () => {
    const res = await request(app)
      .post("/api/delivery-sales")
      .set("Authorization", `Bearer ${scoped}`)
      .send({ customerId: other, customerName: "x", truckNumber: `${RUN}-T3` });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  test("station expenses are only the assigned station's; no assignment narrows nothing", async () => {
    const narrowed = await expenseRepo.listExpenses({
      search: RUN,
      scopeUser: { canViewAllLocations: false, scope: { fillingStationIds: [mine] } },
    });
    assert.deepEqual(narrowed.expenses.map((e) => Number(e.id)), [expenseIds[0]]);

    const open = await expenseRepo.listExpenses({
      search: RUN,
      scopeUser: { canViewAllLocations: false, scope: { fillingStationIds: [] } },
    });
    assert.equal(open.expenses.length, 2);
  });

  test("the staff API saves and returns the assignment", async () => {
    const res = await request(app)
      .patch(`/api/admin/${staffId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ filling_station_ids: [mine, other] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const detail = await get(admin, `/api/admin/${staffId}`);
    const a = detail.body.data.admin;
    assert.deepEqual([...a.fillingStationIds].sort(), [mine, other].sort());
    assert.equal(a.fillingStationNames.length, 2);
  });
});
