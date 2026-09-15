// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const { sql } = require("drizzle-orm");

const { db } = require("../config/db");
const { generateOrderReference } = require("../utils/helpers");
const { orderReferenceSql } = require("../lib/orderReferenceSql");
const { closeDb } = require("./helpers");

/**
 * The SQL reference expression must agree with the JS one, on every order.
 *
 * Two implementations of one rule exist on purpose — Drizzle and postgres.js
 * queries cannot share a fragment, and decorating every raw row in JS is what
 * callers kept forgetting to do, which is how "ORD-A8CD77B2F8AC" reached the
 * gate queue, the desk backlogs and the daily report in the first place.
 *
 * The cost of that choice is drift, and this is the thing that stops it being
 * silent. It runs against the real table rather than a fixture list because the
 * interesting cases are the ones nobody would think to write down: a company
 * called "7-Eleven", one with a leading space, one with a single letter, one
 * with none at all.
 */
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

describe("order reference: SQL matches JS", () => {
  after(closeDb);

  test("every order in the database resolves identically", async () => {
    const rows = rowsOf(await db.execute(sql`
      SELECT o.id,
             o.company_name AS oc,
             c.company_name AS cc,
             ${orderReferenceSql("o", "c")} AS sqlref
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
    `));

    assert.ok(rows.length > 0, "no orders to check — the assertion would be vacuous");

    const mismatches = [];
    for (const r of rows) {
      // formatOrderRow's precedence: the order's own company, then the
      // customer's. An empty string falls through, as `||` does in JS.
      const company = r.oc || r.cc || "";
      const js = generateOrderReference(company, r.id);
      if (js !== r.sqlref) {
        mismatches.push({ id: r.id, company, js, sql: r.sqlref });
      }
    }

    assert.deepEqual(
      mismatches.slice(0, 10),
      [],
      `${mismatches.length} of ${rows.length} orders disagree between the SQL and JS reference`,
    );
  });

  test("no order resolves to the raw ORD- form", async () => {
    const [{ n }] = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE ${orderReferenceSql("o", "c")} LIKE 'ORD-%'
    `));
    assert.equal(Number(n), 0, "the computed reference must never be the internal ORD- value");
  });
});
