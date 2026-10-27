// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Somebody who runs stations sees what their own stations' trucks cost us
 * landed — so the station page can read a profit — and nothing else of the
 * trip costs (the owner, 26 Oct 2026, on David Andrew reading "Not costed").
 */
const RUN = Date.now();
const TAG = String(RUN % 1000000);
let runner;
let runnerStaff;
let outsider;
let station;
let other;
const trips = {};

const list = async (token) => {
  const res = await request(app).get("/api/delivery-inventory?limit=1000").set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.inventory;
};

describe("station runners see their own trucks' landed cost", () => {
  before(async () => {
    const r = await staffTokenWithRoles(["truck_sales"], `station-runner-${RUN}@soroman.test`);
    runner = r.accessToken;
    runnerStaff = r.staff;
    outsider = (await staffTokenWithRoles(["truck_sales"], `no-station-${RUN}@soroman.test`)).accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${runnerStaff.id}`;
    [station] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`Cost Station ${RUN}`}, ${`0806${String(RUN).slice(-7)}`}) RETURNING id`;
    [other] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`Other Station ${RUN}`}, ${`0805${String(RUN).slice(-7)}`}) RETURNING id`;
    await client`INSERT INTO filling_station_staff (staff_id, delivery_customer_id) VALUES (${runnerStaff.id}, ${station.id})`;
    const trip = async (plate, customerId) => {
      const [row] = await client`
        INSERT INTO delivery_inventory (truck_number, customer_id, date_allocated, quantity_allocated, rate, product_price, ago_litres, ago_price, feeding_allowance)
        VALUES (${plate}, ${customerId}, '2026-10-20', 30000, 1450, 1300, 400, 1000, 50000) RETURNING id`;
      return Number(row.id);
    };
    trips.mine = await trip(`SCA ${TAG}`, station.id);
    trips.theirs = await trip(`SCB${TAG}`, other.id);
    // Split onto the runner's station by a sale on the same plate and day, though filed under the other.
    trips.split = await trip(`SCC${TAG}`, other.id);
    await client`
      INSERT INTO delivery_sales (truck_number, date_loaded, customer_id, customer_name, quantity, rate, sales_value, book)
      VALUES (${`SCC ${TAG}`}, '2026-10-20', ${station.id}, ${`Cost Station ${RUN}`}, 10000, 1450, 14500000, 'station')`;
  });

  after(async () => {
    await client`DELETE FROM delivery_sales WHERE customer_id IN (${station.id}, ${other.id})`;
    await client`DELETE FROM delivery_inventory WHERE id = ANY(${Object.values(trips)}::int[])`;
    await client`DELETE FROM filling_station_staff WHERE delivery_customer_id = ${station.id}`;
    await client`DELETE FROM delivery_customers WHERE id IN (${station.id}, ${other.id})`;
    await closeDb();
  });

  test("their own station's truck: landed cost, product price, cost per litre — and nothing else of the costs", async () => {
    const rows = await list(runner);
    const mine = rows.find((r) => r.id === trips.mine);
    assert.ok(mine, "the truck is listed");
    assert.equal(Number(mine.productPrice), 1300);
    // (400 L × ₦1,000 + ₦50,000 feeding) ÷ 30,000 L + ₦1,300.
    assert.equal(Number(mine.landingCost), 1315);
    assert.equal(Number(mine.costPerLitre), 15);
    for (const f of ["agoLitres", "agoPrice", "feedingAllowance", "margin", "marginValue", "totalExpenses", "haulageAmount"]) {
      assert.equal(mine[f], undefined, `${f} stays with Delivery Costing`);
    }
  });

  test("a truck split onto their station by a sale on the same plate and day is theirs too", async () => {
    const split = (await list(runner)).find((r) => r.id === trips.split);
    assert.equal(Number(split.landingCost), 1315);
  });

  test("another station's truck, and anybody who runs no station: no costs at all", async () => {
    const theirs = (await list(runner)).find((r) => r.id === trips.theirs);
    if (theirs) {
      assert.equal(theirs.productPrice, undefined);
      assert.equal(theirs.landingCost, undefined);
    }
    const seen = (await list(outsider)).find((r) => r.id === trips.mine);
    assert.ok(seen);
    assert.equal(seen.landingCost, undefined);
    assert.equal(seen.productPrice, undefined);
  });

  test("the session says so, for the dashboard", async () => {
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${runner}`);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const user = me.body.data?.session;
    assert.equal(user.stationCosts, true);
    const them = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${outsider}`);
    const u2 = them.body.data?.session;
    assert.equal(Boolean(u2.stationCosts), false);
  });
});
