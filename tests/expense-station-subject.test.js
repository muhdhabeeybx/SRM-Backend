require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { sql } = require("drizzle-orm");
const { staffToken, closeDb } = require("./helpers");

/**
 * An expense raised for a filling station or an LPG plant.
 *
 * What is being held down here is the difference between the three things an
 * expense can now be against, none of which is stored as a type:
 *
 *   a station  — delivery_customer_id set
 *   a plant    — lpg_station_id set
 *   a cargo    — pfi_id set and neither of the above
 *   an overhead— none of the three
 *
 * And the one rule the database also carries: never a station AND a plant.
 *
 * Note what is NOT here. delivery_sales.expenses_amount is the station's own
 * spending out of pump takings and is a debit against the station; these rows
 * are money Soroman pays a vendor on a station's behalf and never touch the
 * station's balance. Two stores on purpose — see migration 0055.
 */

const EXPENSES = "/api/expenses";
const RUN = String(Date.now()).slice(-6);
const rowsOf = (r) => r.rows ?? r;

let token;
let categoryId;
let stationId;
let plantId;
const created = [];
let station2 = null;
/** Set when this file had to make its own station, so it can remove it. */
let madeStation = null;

const subjectOf = async (id) => {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT pfi_id, delivery_customer_id, lpg_station_id
      FROM pfi_expenses WHERE id = ${id}
    `)
  );
  return rows[0];
};

describe("an expense against a station or a plant", () => {
  before(async () => {
    token = await staffToken(request, app);
    categoryId = rowsOf(await db.execute(sql`
      SELECT id FROM expense_categories
      WHERE gl_group = 'general' AND is_active IS NOT FALSE ORDER BY id LIMIT 1
    `))[0]?.id;
    stationId = rowsOf(await db.execute(sql`
      SELECT id FROM delivery_customers WHERE customer_type = 'filling_station' ORDER BY id LIMIT 1
    `))[0]?.id;
    // A database with no filling station in it would skip the half of this
    // file that matters, so one is made and taken away again.
    if (!stationId) {
      stationId = rowsOf(await db.execute(sql`
        INSERT INTO delivery_customers (customer_type, name, phone_number)
        VALUES ('filling_station', ${`Test Station ${RUN}`}, ${`0800${RUN}`})
        RETURNING id
      `))[0]?.id;
      madeStation = stationId;
    }
    // A second station, so a bill can be split across two.
    station2 = rowsOf(await db.execute(sql`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`Test Station B ${RUN}`}, ${`0801${RUN}`})
      RETURNING id
    `))[0]?.id;
    plantId = rowsOf(await db.execute(sql`
      SELECT id FROM lpg_stations ORDER BY id LIMIT 1
    `))[0]?.id;
  });

  after(async () => {
    if (created.length) {
      await db.execute(
        sql`DELETE FROM pfi_expenses WHERE id IN (${sql.join(created.map((id) => sql`${id}`), sql`, `)})`
      );
    }
    if (madeStation) {
      await db.execute(sql`DELETE FROM delivery_customers WHERE id = ${madeStation}`);
    }
    if (station2) {
      await db.execute(sql`DELETE FROM delivery_customers WHERE id = ${station2}`);
    }
    await closeDb();
  });

  const raise = async (body) => {
    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({ category_id: categoryId, amount: 45000, description: `Station ${RUN}`, ...body });
    if (res.body?.data?.expense?.id) created.push(res.body.data.expense.id);
    return res;
  };

  test("a station expense stores its station and nothing else", async (t) => {
    if (!categoryId || !stationId) return t.skip("no seeded category or filling station here");

    const res = await raise({ station_id: stationId });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = await subjectOf(res.body.data.expense.id);
    assert.equal(Number(row.delivery_customer_id), Number(stationId));
    assert.equal(row.lpg_station_id, null);
  });

  test("a plant expense stores its plant", async (t) => {
    if (!categoryId || !plantId) return t.skip("no seeded category or LPG plant here");

    const res = await raise({ plant_id: plantId });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = await subjectOf(res.body.data.expense.id);
    assert.equal(Number(row.lpg_station_id), Number(plantId));
    assert.equal(row.delivery_customer_id, null);
  });

  test("a station and a plant at once is refused", async (t) => {
    if (!categoryId || !stationId || !plantId) return t.skip("no seeded subjects here");

    const res = await raise({ station_id: stationId, plant_id: plantId });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /not both/i);
  });

  test("a station that does not exist is refused, not ignored", async (t) => {
    if (!categoryId) return t.skip("no seeded category here");

    const res = await raise({ station_id: 99999999 });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Station not found/i);
  });

  test("an ordinary overhead still carries no subject at all", async (t) => {
    if (!categoryId) return t.skip("no seeded category here");

    const res = await raise({});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = await subjectOf(res.body.data.expense.id);
    assert.equal(row.delivery_customer_id, null);
    assert.equal(row.lpg_station_id, null);
    assert.equal(row.pfi_id, null);
  });

  test("an edit that does not mention the subject leaves it alone", async (t) => {
    if (!categoryId || !stationId) return t.skip("no seeded category or filling station here");

    const raised = await raise({ station_id: stationId });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const id = raised.body.data.expense.id;

    // Changing the amount must not quietly unhook the station.
    const res = await request(app)
      .patch(`${EXPENSES}/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 51000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await subjectOf(id);
    assert.equal(Number(row.delivery_customer_id), Number(stationId));
  });

  test("naming the station empty is how it is removed", async (t) => {
    if (!categoryId || !stationId) return t.skip("no seeded category or filling station here");

    const made = await raise({ station_id: stationId });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.data.expense.id;

    const res = await request(app)
      .patch(`${EXPENSES}/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ station_id: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await subjectOf(id);
    assert.equal(row.delivery_customer_id, null);
  });

/**
 * One bill, several stations.
 *
 * A servicing round or a year's insurance covers six stations on one invoice.
 * Raising it six times is six chances for the figures to drift apart, so it
 * is entered once and divided — and the division has to add back up to the
 * bill exactly, which is the whole of what these hold down.
 */
describe("a bill split across stations", () => {
  let token2;
  let category2;
  let a;
  let b;
  const made = [];

  before(async () => {
    token2 = await staffToken(request, app);
    category2 = rowsOf(await db.execute(sql`
      SELECT id FROM expense_categories
      WHERE gl_group = 'general' AND is_active IS NOT FALSE ORDER BY id LIMIT 1
    `))[0]?.id;
    const stations = rowsOf(await db.execute(sql`
      SELECT id FROM delivery_customers WHERE customer_type = 'filling_station' ORDER BY id DESC LIMIT 2
    `));
    a = stations[0]?.id;
    b = stations[1]?.id;
  });

  after(async () => {
    if (made.length) {
      await db.execute(
        sql`DELETE FROM pfi_expenses WHERE id IN (${sql.join(made.map((id) => sql`${id}`), sql`, `)})`
      );
    }
  });

  const raiseFor = async (ids, body = {}) => {
    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token2}`)
      .send({ category_id: category2, description: `Split ${RUN}`, station_ids: ids, ...body });
    for (const e of res.body?.data?.expenses || []) made.push(e.id);
    return res;
  };

  test("two stations, one bill, half each", async (t) => {
    if (!category2 || !a || !b) return t.skip("no seeded category or two stations here");

    const res = await raiseFor([a, b], { amount: 100000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.expenses.length, 2);

    const amounts = res.body.data.expenses.map((e) => Number(e.amount));
    assert.deepEqual(amounts, [50000, 50000]);
    // Each row names its own station, and only its own.
    const subjects = res.body.data.expenses.map((e) => Number(e.delivery_customer_id));
    assert.deepEqual([...subjects].sort(), [a, b].sort());
  });

  test("an odd split still adds back up to the bill", async (t) => {
    if (!category2 || !a || !b) return t.skip("no seeded category or two stations here");

    // A third of this does not divide into kobo.
    const res = await raiseFor([a, b], { amount: 100000.01 });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const amounts = res.body.data.expenses.map((e) => Number(e.amount));
    const sum = amounts.reduce((x, y) => x + y, 0);
    assert.equal(Math.round(sum * 100), Math.round(100000.01 * 100));
    // The odd kobo goes to the first share, never lost.
    assert.deepEqual(amounts, [50000.01, 50000]);
  });

  test("the same station twice takes one share, not two", async (t) => {
    if (!category2 || !a) return t.skip("no seeded category or station here");

    const res = await raiseFor([a, a], { amount: 90000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.expenses.length, 1);
    assert.equal(Number(res.body.data.expenses[0].amount), 90000);
  });

  test("one station in a list behaves exactly as one station", async (t) => {
    if (!category2 || !a) return t.skip("no seeded category or station here");

    const res = await raiseFor([a], { amount: 45000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.expenses.length, 1);
    assert.equal(Number(res.body.data.expenses[0].amount), 45000);
    // `expense` stays the first row, so callers that never split still work.
    assert.equal(res.body.data.expense.id, res.body.data.expenses[0].id);
  });

  test("a split ex-VAT keeps each row's own arithmetic", async (t) => {
    if (!category2 || !a || !b) return t.skip("no seeded category or two stations here");

    const res = await raiseFor([a, b], { amount: 107500, amount_ex_vat: 100000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    for (const e of res.body.data.expenses) {
      const exVat = Number(e.amount_ex_vat);
      const vat = Number(e.vat_amount);
      const invoice = Number(e.invoice_amount);
      assert.equal(exVat, 50000);
      // Derived per row, so the row still adds up on its own.
      assert.equal(Math.round((exVat + vat) * 100), Math.round(invoice * 100));
    }
  });

  test("stations and plants in one request is refused", async (t) => {
    if (!category2 || !a || !plantId) return t.skip("no seeded subjects here");

    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token2}`)
      .send({ category_id: category2, amount: 1000, station_ids: [a], plant_ids: [plantId] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not both/i);
  });
});
});
