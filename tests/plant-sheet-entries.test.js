require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, closeDb } = require("./helpers");

/**
 * An LPG plant's own daily sheet, written through the bulk route — migration
 * 0068 and the truckless rule.
 *
 * The sheet is imported before the plant's deliveries are on the register, so
 * its entries name no truck. That is allowed for a plant and for nothing else,
 * and each sale line says whether an end user or a dealer bought it.
 */
const RUN = `PS${Date.now()}`.slice(-10);

describe("LPG plant sheet entries", () => {
  let admin;
  let plantId;
  let stationId;

  const bulk = (sales) =>
    request(app).post("/api/delivery-sales/bulk").set("Authorization", `Bearer ${admin}`).send({ sales });

  before(async () => {
    admin = await staffToken(request, app);
    const [plant] = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code)
      VALUES (${`${RUN} Maiduguri LPG`}, 'lpg_plant', '0800000101', ${`LPG-${RUN}`})
      RETURNING id`;
    const [station] = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code)
      VALUES (${`${RUN} Kano Fuel`}, 'filling_station', '0800000102', ${`STN-${RUN}`})
      RETURNING id`;
    plantId = Number(plant.id);
    stationId = Number(station.id);
  });

  after(async () => {
    await client`DELETE FROM delivery_sales WHERE customer_id = ANY(${[plantId, stationId]})`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${[plantId, stationId]})`;
    await closeDb();
  });

  test("a plant's day goes in with no truck, each sale line naming its buyer", async () => {
    const base = { customerId: plantId, customerName: `${RUN} Maiduguri LPG`, dateOfPayment: "2026-07-01" };
    const res = await bulk([
      { ...base, quantity: 41, rate: 1650, salesValue: 67650, buyerClass: "end_user" },
      { ...base, quantity: 950, rate: 1500, salesValue: 1425000, buyerClass: "dealer" },
      { ...base, paymentAmount: 1492650, depositChannel: "pos", payerName: "ACTION ENERGY MAIDUGURI" },
      { ...base, expensesAmount: 640, remarks: "POS charges" },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const rows = await client`
      SELECT truck_number, buyer_class, quantity, rate FROM delivery_sales
       WHERE customer_id = ${plantId} ORDER BY id`;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.truck_number === ""), "no load yet, and nothing invented for one");
    assert.deepEqual(rows.map((r) => r.buyer_class), ["end_user", "dealer", null, null]);
  });

  test("anything but a plant still has to name its truck — and the whole upload is refused", async () => {
    const res = await bulk([
      { customerId: plantId, quantity: 10, rate: 1650, salesValue: 16500, buyerClass: "end_user" },
      { customerId: stationId, quantity: 2500, rate: 1370, salesValue: 3425000 },
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.body.errors[0].path, "sales.1.truckNumber");

    const [{ n }] = await client`
      SELECT count(*)::int AS n FROM delivery_sales WHERE customer_id = ${plantId} AND quantity = 10`;
    assert.equal(n, 0, "the plant's row in the same upload is not written either");
  });

  test("a row with no customer at all cannot go in truckless", async () => {
    const res = await bulk([{ paymentAmount: 5000, depositChannel: "pos" }]);
    assert.equal(res.status, 400);
  });

  test("the database refuses a buyer that is neither", async () => {
    await assert.rejects(
      client`INSERT INTO delivery_sales (customer_id, buyer_class) VALUES (${plantId}, 'wholesale')`,
      /delivery_sales_buyer_class_check/,
    );
  });
});
