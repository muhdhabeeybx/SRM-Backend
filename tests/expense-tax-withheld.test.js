require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { sql } = require("drizzle-orm");
const { staffToken, closeDb } = require("./helpers");

/**
 * VAT withheld, untaxed invoice lines, and the tax report (migration 0066).
 *
 * The vendor is paid the amount before VAT, less WHT, plus any untaxed lines.
 * The VAT and the WHT are kept back and paid to the tax office, and the tax
 * report totals them for a period. Rows raised before 0066 paid the vendor the
 * VAT, so their VAT is shown apart and never counted as owed.
 *
 * The report is read over March 2019, a month no other fixture pays in.
 */

const EXPENSES = "/api/expenses";
const RUN = `TAXW${String(Date.now()).slice(-6)}`;
const rowsOf = (r) => r.rows ?? r;

let token;
let categoryId;
const created = [];

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

const raise = async (body) => {
  const res = await auth(request(app).post(EXPENSES)).send({ category_id: categoryId, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  for (const e of res.body.data.expenses) created.push(e.id);
  return res.body.data;
};

const paidIn2019 = (day) => ({
  record_as_paid: true,
  bank_paid_from: "Zenith · 1013456789",
  payment_date: `2019-03-${day}`,
  payment_method: "Bank Transfer",
});

describe("VAT withheld and untaxed items", () => {
  before(async () => {
    token = await staffToken(request, app);
    const rows = rowsOf(await db.execute(sql`
      SELECT id FROM expense_categories
      WHERE gl_group = 'general' AND is_active IS NOT FALSE AND NOT is_refund
      ORDER BY id LIMIT 1
    `));
    categoryId = rows[0]?.id;
  });

  after(async () => {
    if (created.length) {
      await db.execute(sql`DELETE FROM pfi_expenses WHERE id IN (${sql.join(created.map((id) => sql`${id}`), sql`, `)})`);
    }
    await closeDb();
  });

  test("untaxed lines are stored, summed and added to the invoice total", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    // ₦1,000,000 of service, ₦75,000 VAT, 5% WHT = ₦50,000, ₦200,000 + ₦30,000 untaxed.
    // The vendor gets 1,000,000 − 50,000 + 230,000 = 1,180,000.
    const { expense } = await raise({
      description: `${RUN} items`,
      amount: 1180000,
      amount_ex_vat: 1000000,
      wht_rate: 5,
      vat_withheld: true,
      untaxed_items: [
        { description: "Logistics", amount: 200000 },
        { description: "Loading", amount: "30000" },
        { description: "", amount: "" },
      ],
    });

    assert.equal(expense.vat_withheld, true);
    assert.equal(Number(expense.vat_amount), 75000);
    assert.equal(Number(expense.wht_deduction), 50000);
    assert.equal(Number(expense.untaxed_amount), 230000);
    assert.equal(Number(expense.invoice_amount), 1000000 + 75000 + 230000);
    assert.deepEqual(expense.untaxed_items, [
      { description: "Logistics", amount: 200000 },
      { description: "Loading", amount: 30000 },
    ]);
  });

  test("an untaxed line needs a usable amount", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const res = await auth(request(app).post(EXPENSES)).send({
      category_id: categoryId,
      description: `${RUN} bad`,
      amount: 1000,
      untaxed_items: [{ description: "Haulage", amount: -5 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Haulage/);
  });

  test("a row raised without the flag keeps the old rule", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const { expense } = await raise({ description: `${RUN} old`, amount: 107500, amount_ex_vat: 100000 });
    assert.equal(expense.vat_withheld, false);
    assert.equal(Number(expense.untaxed_amount), 0);
    assert.deepEqual(expense.untaxed_items, []);
  });

  test("an edit that replaces the lines re-works the invoice total", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const { expense } = await raise({
      description: `${RUN} edit`,
      amount: 95000 + 10000,
      amount_ex_vat: 100000,
      wht_rate: 5,
      vat_withheld: true,
      untaxed_items: [{ description: "Transport", amount: 10000 }],
    });

    const res = await auth(request(app).patch(`${EXPENSES}/${expense.id}`)).send({
      amount: 95000 + 25000,
      untaxed_items: [{ description: "Transport", amount: 25000 }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = res.body.data.expense;
    assert.equal(Number(after.untaxed_amount), 25000);
    assert.equal(Number(after.invoice_amount), 100000 + 7500 + 25000);
    // The rate is carried, so the deduction survives an edit that does not name it.
    assert.equal(Number(after.wht_deduction), 5000);
    assert.equal(after.vat_withheld, true);
  });

  test("a bill split between plants splits each untaxed line too", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");
    const plants = rowsOf(await db.execute(sql`SELECT id FROM lpg_stations ORDER BY id LIMIT 2`));
    if (plants.length < 2) return t.skip("needs two LPG plants");

    const { expenses } = await raise({
      description: `${RUN} split`,
      amount: 100001,
      amount_ex_vat: 90000,
      vat_withheld: true,
      untaxed_items: [{ description: "Logistics", amount: 10000.01 }],
      plant_ids: plants.map((p) => p.id),
    });
    assert.equal(expenses.length, 2);
    const shares = expenses.map((e) => e.untaxed_items[0].amount);
    assert.deepEqual(shares, [5000.01, 5000]);
    assert.equal(expenses.every((e) => e.vat_withheld), true);
  });

  test("the tax report totals what is owed for the period", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    // New rule: VAT 7,500 withheld, WHT 5,000.
    await raise({
      description: `${RUN} r1`, amount: 95000, amount_ex_vat: 100000, wht_rate: 5,
      vat_withheld: true, ...paidIn2019("05"),
    });
    // Old rule: VAT 15,000 went to the vendor; WHT 4,000 is still owed.
    await raise({
      description: `${RUN} r2`, amount: 211000, amount_ex_vat: 200000, wht_rate: 2, ...paidIn2019("20"),
    });
    // Outside the month.
    await raise({
      description: `${RUN} r3`, amount: 95000, amount_ex_vat: 100000, wht_rate: 5,
      vat_withheld: true, ...paidIn2019("05"), payment_date: "2019-04-02",
    });
    // No tax at all — not on the report.
    await raise({ description: `${RUN} r4`, amount: 5000, ...paidIn2019("10") });

    const res = await auth(request(app).get(`${EXPENSES}/tax-report`))
      .query({ from: "2019-03-01", to: "2019-03-31" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows, totals } = res.body.data;
    const mine = rows.filter((r) => r.description.startsWith(RUN));
    assert.deepEqual(mine.map((r) => r.description.replace(`${RUN} `, "")), ["r1", "r2"]);
    assert.equal(totals.vatWithheld, 7500);
    assert.equal(totals.vatPaidToVendor, 15000);
    assert.equal(totals.wht, 9000);
    assert.equal(totals.toRemit, 16500);
  });

  test("the tax report needs a whole period", async () => {
    const res = await auth(request(app).get(`${EXPENSES}/tax-report`)).query({ from: "2019-03-01" });
    assert.equal(res.status, 400);
  });
});
