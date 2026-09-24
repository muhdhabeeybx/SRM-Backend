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
});
