require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { sql } = require("drizzle-orm");
const { staffToken, closeDb } = require("./helpers");

/**
 * The register's tax filter and its VAT / WHT totals.
 *
 * Finance reads VAT and WHT off this page to file them, so the two things held
 * down here are: the filter returns exactly the rows that carry each tax, and
 * the totals are in naira — a dollar invoice's VAT times its rate, and a dollar
 * invoice with no rate left out rather than counted as naira.
 *
 * Every assertion is scoped by a search term unique to this run, so rows
 * already in the database cannot move the figures.
 */

const EXPENSES = "/api/expenses";
const RUN = `TAXF${String(Date.now()).slice(-6)}`;
const rowsOf = (r) => r.rows ?? r;

let token;
let categoryId;
const created = [];

describe("expense tax filter", () => {
  before(async () => {
    token = await staffToken(request, app);
    const rows = rowsOf(
      await db.execute(sql`
        SELECT id FROM expense_categories
        WHERE gl_group = 'general' AND is_active IS NOT FALSE
        ORDER BY id LIMIT 1
      `)
    );
    categoryId = rows[0]?.id;
    if (!categoryId) return;

    const raise = async (body) => {
      const res = await request(app)
        .post(EXPENSES)
        .set("Authorization", `Bearer ${token}`)
        .send({ category_id: categoryId, description: `${RUN} ${body.label}`, ...body });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      created.push(res.body.data.expense.id);
    };

    await raise({ label: "vat only", amount: 107500, amount_ex_vat: 100000, vat_amount: 7500 });
    // VAT sent as 0: left out, the server charges 7.5% on any ex-VAT figure.
    await raise({ label: "wht only", amount: 95000, amount_ex_vat: 100000, vat_amount: 0, wht_rate: 5, wht_deduction: 5000 });
    await raise({ label: "both", amount: 197500, amount_ex_vat: 200000, vat_amount: 15000, wht_rate: 10, wht_deduction: 20000 });
    await raise({ label: "no tax", amount: 40000 });
    // $75 of VAT at 1,500 is ₦112,500 of VAT.
    await raise({ label: "usd vat", amount: 1075, currency: "USD", exchange_rate: 1500, amount_ex_vat: 1000, vat_amount: 75 });
    // No rate: it has VAT, but no naira value to add to a naira total.
    await raise({ label: "usd no rate", amount: 1075, currency: "USD", amount_ex_vat: 1000, vat_amount: 75 });
  });

  after(async () => {
    if (created.length) {
      await db.execute(
        sql`DELETE FROM pfi_expenses WHERE id IN (${sql.join(created.map((id) => sql`${id}`), sql`, `)})`
      );
    }
    await closeDb();
  });

  const list = async (tax) => {
    const res = await request(app)
      .get(EXPENSES)
      .query({ search: RUN, ...(tax ? { tax } : {}) })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { expenses, totals } = res.body.data;
    return { labels: expenses.map((e) => e.description.replace(`${RUN} `, "")).sort(), totals };
  };

  test("each option returns exactly the rows that carry that tax", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account in this database");

    assert.deepEqual((await list()).labels, ["both", "no tax", "usd no rate", "usd vat", "vat only", "wht only"]);
    assert.deepEqual((await list("vat")).labels, ["both", "usd no rate", "usd vat", "vat only"]);
    assert.deepEqual((await list("wht")).labels, ["both", "wht only"]);
    assert.deepEqual((await list("any")).labels, ["both", "usd no rate", "usd vat", "vat only", "wht only"]);
    assert.deepEqual((await list("none")).labels, ["no tax"]);
  });

  test("VAT and WHT are totalled in naira, and an unconverted invoice is left out", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account in this database");

    const { totals } = await list();
    // 7,500 + 15,000 + 75 × 1,500. The rate-less dollar invoice adds nothing.
    assert.equal(totals.vatTotal, 7500 + 15000 + 112500);
    assert.equal(totals.whtTotal, 5000 + 20000);
    // None of them is paid yet.
    assert.equal(totals.vatPaid, 0);
    assert.equal(totals.whtPaid, 0);
  });

  test("the totals follow the filter", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account in this database");

    const { totals } = await list("wht");
    assert.equal(totals.whtTotal, 25000);
    assert.equal(totals.vatTotal, 15000, "only the row with both taxes brings VAT into a WHT view");
  });
});
