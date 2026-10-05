require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");
const { kindsOfRow, enterersFor } = require("../lib/stationEntry");

/**
 * Who enters a station's records — migration 0067, lib/stationEntry.js.
 *
 * A station's sales and expenses, and its deposits, can each be given to
 * named people, station-wide or on one PFI. Then only they (and admins) write,
 * change or delete a row of that kind there. Nobody named leaves it open.
 */
const RUN = `SE${Date.now()}`.slice(-10);
const DAY = "2026-09-20";

describe("who enters a station's records", () => {
  let admin;
  const people = {};
  let station;
  let customer;
  let pfi;
  let otherPfi;
  const plate = `${RUN}T1`;
  const otherPlate = `${RUN}T2`;

  const mkPerson = async (key, roles, first) => {
    const p = await staffTokenWithRoles(roles, `station-entry-${key}-${RUN}@soroman.test`);
    await client`UPDATE staff SET first_name = ${first}, surname = ${RUN} WHERE id = ${p.staff.id}`;
    people[key] = { id: Number(p.staff.id), token: p.accessToken, name: `${first} ${RUN}` };
  };

  before(async () => {
    admin = await staffToken(request, app);
    await mkPerson("sales", ["truck_sales"], "Sally");
    await mkPerson("deposits", ["finance"], "Dayo");
    await mkPerson("other", ["truck_sales"], "Obi");

    const [s, c] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`${RUN} Station`}, '0800000001'),
             ('customer', ${`${RUN} Buyer`}, '0800000002')
      RETURNING id`;
    station = Number(s.id);
    customer = Number(c.id);

    const pfis = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
      VALUES (${`SE/${RUN}/A`}, 'coastal', 'active', 1000, '300'),
             (${`SE/${RUN}/B`}, 'coastal', 'active', 1000, '300')
      RETURNING id`;
    pfi = Number(pfis[0].id);
    otherPfi = Number(pfis[1].id);

    await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, pfi_id, customer_id, quantity_allocated, loading_status, date_allocated)
      VALUES (${`SE-${RUN}-A`}, ${plate}, ${pfi}, ${station}, 33000, 'loaded', ${DAY}),
             (${`SE-${RUN}-B`}, ${otherPlate}, ${otherPfi}, ${station}, 33000, 'loaded', ${DAY})`;
  });

  after(async () => {
    await client`DELETE FROM delivery_sales WHERE customer_id = ANY(${[station, customer].filter(Boolean)}::int[])`;
    await client`DELETE FROM delivery_inventory WHERE truck_number = ANY(${[plate, otherPlate]})`;
    await client`DELETE FROM station_entry_staff WHERE delivery_customer_id = ${station}`;
    await client`DELETE FROM pfis WHERE id = ANY(${[pfi, otherPfi].filter(Boolean)}::int[])`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${[station, customer].filter(Boolean)}::int[])`;
    await closeDb();
  });

  const row = (kind, { truck = plate, at = station } = {}) => ({
    truckNumber: truck,
    dateLoaded: DAY,
    customerId: at,
    customerName: `${RUN} Station`,
    allocationCode: truck === plate ? `SE-${RUN}-A` : `SE-${RUN}-B`,
    dateOfPayment: DAY,
    ...(kind === "sale" ? { quantity: 100, rate: 900, salesValue: 90000, paymentAmount: 0 } : {}),
    ...(kind === "expense" ? { expensesAmount: 5000, paymentAmount: 0 } : {}),
    ...(kind === "deposit" ? { paymentAmount: 80000 } : {}),
  });
  const bulk = (token, rows) => request(app)
    .post("/api/delivery-sales/bulk").set("Authorization", `Bearer ${token}`).send({ sales: rows });
  const assign = (token, body) => request(app)
    .put("/api/station-entry-staff").set("Authorization", `Bearer ${token}`).send({ stationId: station, ...body });

  test("a row's kind: a sale or expense is sales, money in is a deposit", () => {
    assert.deepEqual([...kindsOfRow(row("sale"))], ["sales"]);
    assert.deepEqual([...kindsOfRow(row("expense"))], ["sales"]);
    assert.deepEqual([...kindsOfRow(row("deposit"))], ["deposits"]);
    assert.deepEqual([...kindsOfRow({ ...row("sale"), paymentAmount: 10 })].sort(), ["deposits", "sales"]);
    assert.equal(kindsOfRow({ truckNumber: "X" }).size, 0);
  });

  test("a PFI's own people stand in for the station's, per kind", () => {
    const a = [
      { stationId: 1, pfiId: null, kind: "sales", staffId: 10 },
      { stationId: 1, pfiId: null, kind: "deposits", staffId: 11 },
      { stationId: 1, pfiId: 7, kind: "deposits", staffId: 12 },
    ];
    assert.deepEqual(enterersFor(a, 1, 7, "deposits").map((x) => x.staffId), [12]);
    assert.deepEqual(enterersFor(a, 1, 7, "sales").map((x) => x.staffId), [10], "sales falls back to the station's");
    assert.deepEqual(enterersFor(a, 1, 8, "deposits").map((x) => x.staffId), [11]);
    assert.deepEqual(enterersFor(a, 2, null, "sales"), [], "another station has nobody");
  });

  test("with nobody named, anyone who can see the station enters anything", async () => {
    const res = await bulk(people.other.token, [row("sale"), row("deposit")]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test("only an admin may change who enters", async () => {
    const res = await assign(people.sales.token, { sales: [people.sales.id], deposits: [] });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  test("a plain customer cannot be given entry staff", async () => {
    const res = await request(app).put("/api/station-entry-staff").set("Authorization", `Bearer ${admin}`)
      .send({ stationId: customer, sales: [people.sales.id] });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  test("an admin names the people, and the station reads them back", async () => {
    const res = await assign(admin, { sales: [people.sales.id], deposits: [people.deposits.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const got = await request(app).get(`/api/station-entry-staff?station=${station}`)
      .set("Authorization", `Bearer ${people.other.token}`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const byKind = Object.fromEntries(["sales", "deposits"].map((k) => [
      k, got.body.data.assignments.filter((a) => a.kind === k).map((a) => a.staffId),
    ]));
    assert.deepEqual(byKind, { sales: [people.sales.id], deposits: [people.deposits.id] });
    assert.equal(got.body.data.you.mayAlwaysEnter, false);

    const [logged] = await client`
      SELECT metadata FROM audit_events
       WHERE action = 'station.entry_staff_changed' AND entity_id = ${String(station)}
       ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(logged.metadata.after, { sales: [people.sales.id], deposits: [people.deposits.id] });
  });

  test("each person enters only their own kind; the refusal names who does", async () => {
    assert.equal((await bulk(people.sales.token, [row("sale"), row("expense")])).status, 201);
    assert.equal((await bulk(people.deposits.token, [row("deposit")])).status, 201);

    const wrong = await bulk(people.sales.token, [row("deposit")]);
    assert.equal(wrong.status, 403);
    assert.match(wrong.body.message, /Deposits at .* are entered by Dayo/);

    assert.equal((await bulk(people.deposits.token, [row("sale")])).status, 403);
    assert.equal((await bulk(people.other.token, [row("expense")])).status, 403);
    // One row not theirs refuses the lot — nothing half-written.
    assert.equal((await bulk(people.sales.token, [row("sale"), row("deposit")])).status, 403);
  });

  test("the single-row route asks too", async () => {
    const res = await request(app).post("/api/delivery-sales")
      .set("Authorization", `Bearer ${people.sales.token}`).send(row("deposit"));
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  test("a PFI can name its own people for one kind", async () => {
    const res = await assign(admin, { pfiId: pfi, sales: [], deposits: [people.other.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // On that PFI's load, deposits are Obi's, not Dayo's…
    assert.equal((await bulk(people.other.token, [row("deposit")])).status, 201);
    const dayo = await bulk(people.deposits.token, [row("deposit")]);
    assert.equal(dayo.status, 403);
    assert.match(dayo.body.message, new RegExp(`on SE/${RUN}/A are entered by Obi`));
    // …sales there are still the station's…
    assert.equal((await bulk(people.sales.token, [row("sale")])).status, 201);
    // …and every other PFI keeps the station's people.
    assert.equal((await bulk(people.deposits.token, [row("deposit", { truck: otherPlate })])).status, 201);
    assert.equal((await bulk(people.other.token, [row("deposit", { truck: otherPlate })])).status, 403);
  });

  test("an edit cannot turn a row into somebody else's kind, nor touch theirs", async () => {
    const [sale] = await client`
      SELECT id FROM delivery_sales WHERE customer_id = ${station} AND sales_value::numeric > 0 ORDER BY id DESC LIMIT 1`;
    const patch = (token, body) => request(app)
      .patch(`/api/delivery-sales/${sale.id}`).set("Authorization", `Bearer ${token}`).send(body);

    assert.equal((await patch(people.sales.token, { rate: 950, salesValue: 95000 })).status, 200);
    assert.equal((await patch(people.sales.token, { paymentAmount: 1000 })).status, 403);
    assert.equal((await patch(people.deposits.token, { rate: 1 })).status, 403);
  });

  test("a delete is the enterer's — or an admin's", async () => {
    const [sale] = await client`
      SELECT id FROM delivery_sales WHERE customer_id = ${station} AND sales_value::numeric > 0 ORDER BY id DESC LIMIT 1`;
    const del = (token) => request(app).delete(`/api/delivery-sales/${sale.id}`).set("Authorization", `Bearer ${token}`);
    assert.equal((await del(people.deposits.token)).status, 403);
    assert.equal((await del(people.sales.token)).status, 200);
  });

  test("an admin enters anything, to correct", async () => {
    assert.equal((await bulk(admin, [row("sale"), row("deposit")])).status, 201);
  });

  test("clearing the PFI's people hands it back to the station's", async () => {
    assert.equal((await assign(admin, { pfiId: pfi, sales: [], deposits: [] })).status, 200);
    assert.equal((await bulk(people.deposits.token, [row("deposit")])).status, 201);
    assert.equal((await bulk(people.other.token, [row("deposit")])).status, 403);
  });

  test("rows for a plain customer are never guarded", async () => {
    const res = await bulk(people.other.token, [{ ...row("deposit"), customerId: customer, customerName: "Buyer" }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });
});
