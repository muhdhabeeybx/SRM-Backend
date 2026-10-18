require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { sql } = require("drizzle-orm");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * Booking money that has already left the bank, end to end through the route.
 *
 * The gate itself is unit-tested in expense-amend-after-payment.test.js. What
 * is checked here is what the controller actually WRITES — that the row lands
 * at paid with its settlement attached, that the audit trail records the
 * bypass, and that an ordinary request is untouched by any of it.
 */

const EXPENSES = "/api/expenses";
const RUN = String(Date.now()).slice(-6);
const rowsOf = (r) => r.rows ?? r;

let token;
let weakToken;
let categoryId;

const created = [];

describe("recording an expense as already paid", () => {
  before(async () => {
    token = await staffToken(request, app);
    ({ accessToken: weakToken } = await staffTokenWithRoles(["expenditure_officer"]));

    // Any live general account will do — the booking rules are not what is
    // under test here.
    const rows = rowsOf(
      await db.execute(sql`
        SELECT id FROM expense_categories
        WHERE gl_group = 'general' AND is_active IS NOT FALSE
        ORDER BY id LIMIT 1
      `)
    );
    categoryId = rows[0]?.id;
  });

  after(async () => {
    if (created.length) {
      await db.execute(
        sql`DELETE FROM pfi_expenses WHERE id IN (${sql.join(created.map((id) => sql`${id}`), sql`, `)})`
      );
    }
    await closeDb();
  });

  test("a super admin lands the row at paid, with its settlement attached", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account in this database");

    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 250000,
        description: `Standing order ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith · 1013456789",
        payment_date: "2026-02-10",
        payment_method: "Bank Transfer",
        payment_reference: `REF-${RUN}`,
      });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const expense = res.body.data.expense;
    created.push(expense.id);

    assert.equal(expense.status, "paid", "it enters at the END of the chain, not the start");
    assert.equal(expense.bank_paid_from, "Zenith · 1013456789");
    assert.equal(Number(expense.amount_paid), 250000, "defaults to the amount asked for");
    // The stamps the chain would have written on the way past. Without them a
    // paid row has no payer, and "who paid this?" has no answer.
    assert.ok(expense.paid_by, "paid_by is stamped");
    assert.ok(expense.paid_at, "paid_at is stamped");
  });

  test("the audit trail records that approval was bypassed", async (t) => {
    if (!created.length) return t.skip("nothing was created");

    const rows = rowsOf(
      await db.execute(sql`
        SELECT action, changes FROM pfi_expense_audits
        WHERE expense_id = ${created[0]} ORDER BY id
      `)
    );

    // The one thing that is NOT skipped along with the chain and the
    // notifications. An untraceable expense is not what was asked for.
    const entry = rows.find((r) => r.action === "recorded_as_paid");
    assert.ok(entry, "the bypass must be named in the trail, not logged as an ordinary creation");
    assert.match(String(entry.changes?.note ?? ""), /bypassed/i);

    assert.ok(
      !rows.some((r) => r.action === "created"),
      "and it is not ALSO logged as an ordinary creation, which would read as two events"
    );
  });

  test("no notification is raised — there is no next actor to tell", async (t) => {
    if (!created.length) return t.skip("nothing was created");

    // notifyExpenseStage is what would have written these. A paid row has
    // nobody waiting on it, and telling the Expenditure Officer that a payment
    // they will never action is in their queue is worse than silence.
    const rows = rowsOf(
      await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM notifications
        WHERE entity_type = 'expense' AND entity_id = ${String(created[0])}
      `)
    );
    assert.equal(rows[0].n, 0);
  });

  test("a foreign invoice recorded as paid keeps its rate, and the rate it cleared at", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    // The dashboard sends the request's rate and, as the payment rate, the
    // same figure unless the desk typed another. The rate was refused as
    // missing — the check read it off a row that did not exist yet.
    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 1200,
        currency: "USD",
        exchange_rate: 1550,
        paid_exchange_rate: 1560,
        description: `Dollar invoice ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith Bank · 1013456789",
        payment_date: "2026-10-17",
        payment_method: "Bank Transfer",
        payment_reference: `USD-${RUN}`,
      });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const expense = res.body.data.expense;
    created.push(expense.id);
    assert.equal(expense.status, "paid");
    assert.equal(expense.currency, "USD");
    assert.equal(Number(expense.exchange_rate), 1550);
    assert.equal(Number(expense.paid_exchange_rate), 1560);
  });

  test("a payment rate on a foreign invoice raised with no rate is still refused", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 1200,
        currency: "USD",
        paid_exchange_rate: 1560,
        description: `Dollar invoice, no rate ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith Bank · 1013456789",
        payment_reference: `USD-NR-${RUN}`,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /no rate on it/i);
  });

  test("it is refused without saying which account the money left", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 1000,
        description: `No bank ${RUN}`,
        record_as_paid: true,
      });

    // Skipping the approval is the point; skipping the evidence is not.
    assert.equal(res.status, 400);
    assert.match(res.body.message, /which account/i);
  });

  test("a settlement that differs from the request needs a reason", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 100000,
        description: `Variance ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith · 1013456789",
        amount_paid: 96250,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.message, /differs/i);
  });

  test("anyone other than a super admin is refused", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${weakToken}`)
      .send({
        category_id: categoryId,
        amount: 5000,
        description: `Not allowed ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith · 1013456789",
      });

    assert.equal(res.status, 403);
    assert.match(res.body.message, /super admin/i);
  });

  test("a super admin can delete a paid expense, and its amount comes off", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const create = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 75000,
        description: `To delete ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith · 1013456789",
      });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const id = create.body.data.expense.id;
    created.push(id);

    const del = await request(app).delete(`${EXPENSES}/${id}`).set("Authorization", `Bearer ${token}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));

    // Soft-deleted, and therefore out of every sum that reads live rows.
    const rows = rowsOf(
      await db.execute(sql`SELECT deleted_at FROM pfi_expenses WHERE id = ${id}`)
    );
    assert.ok(rows[0].deleted_at, "the row is marked deleted");

    const audit = rowsOf(
      await db.execute(sql`SELECT action FROM pfi_expense_audits WHERE expense_id = ${id}`)
    );
    assert.ok(
      audit.some((a) => a.action === "deleted_after_payment"),
      "and the trail says it was a settled row, not an ordinary withdrawal"
    );
  });

  test("deleting a paid expense drops the PFI's total cost and landing cost", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    // A cargo account is needed for the expense to attach to a PFI at all.
    const pfiCat = rowsOf(
      await db.execute(sql`
        SELECT id FROM expense_categories
        WHERE gl_group = 'pfi_direct' AND is_active IS NOT FALSE ORDER BY id LIMIT 1
      `)
    )[0];
    if (!pfiCat) return t.skip("no seeded cargo expense account");

    const [pfi] = rowsOf(
      await db.execute(sql`
        INSERT INTO pfis (pfi_number, pfi_type, starting_qty_litres, bl_qty_litres, unit_price)
        VALUES (${`PFI-DEL-${RUN}`}, 'coastal', 1000000, 1000000, 300) RETURNING id
      `)
    );

    const before = await request(app).get(`/api/pfis/${pfi.id}`).set("Authorization", `Bearer ${token}`);
    const costBefore = before.body.data.pfi.financials.totalCost;
    const landingBefore = before.body.data.pfi.financials.landingCostPerLitre;

    const create = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: pfiCat.id,
        pfi_id: pfi.id,
        amount: 20_000_000,
        description: `Cargo cost ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith · 1013456789",
      });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const id = create.body.data.expense.id;
    created.push(id);

    const during = await request(app).get(`/api/pfis/${pfi.id}`).set("Authorization", `Bearer ${token}`);
    assert.equal(
      during.body.data.pfi.financials.totalCost,
      costBefore + 20_000_000,
      "a paid expense lands on the cargo immediately"
    );
    assert.ok(
      during.body.data.pfi.financials.landingCostPerLitre > landingBefore,
      "and pushes the landing cost up"
    );

    await request(app).delete(`${EXPENSES}/${id}`).set("Authorization", `Bearer ${token}`).expect(200);

    // The whole point: no manual deduction anywhere. The sum reads live rows
    // and the deleted one has simply stopped being one of them.
    const after = await request(app).get(`/api/pfis/${pfi.id}`).set("Authorization", `Bearer ${token}`);
    assert.equal(after.body.data.pfi.financials.totalCost, costBefore, "the amount comes back off");
    assert.equal(
      after.body.data.pfi.financials.landingCostPerLitre,
      landingBefore,
      "and the landing cost returns to where it was"
    );

    await db.execute(sql`DELETE FROM pfis WHERE id = ${pfi.id}`);
  });

  test("anyone other than a super admin still cannot delete a paid expense", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    const create = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 1500,
        description: `Protected ${RUN}`,
        record_as_paid: true,
        bank_paid_from: "Zenith · 1013456789",
      });
    const id = create.body.data.expense.id;
    created.push(id);

    const res = await request(app).delete(`${EXPENSES}/${id}`).set("Authorization", `Bearer ${weakToken}`);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /super admin/i);

    const rows = rowsOf(
      await db.execute(sql`SELECT deleted_at FROM pfi_expenses WHERE id = ${id}`)
    );
    assert.equal(rows[0].deleted_at, null, "and the row survives");
  });

  test("an ordinary request still enters the chain at the start", async (t) => {
    if (!categoryId) return t.skip("no seeded general expense account");

    // The whole feature must be opt-in. A flag nobody set must change nothing.
    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category_id: categoryId,
        amount: 4200,
        description: `Ordinary ${RUN}`,
      });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    created.push(res.body.data.expense.id);
    assert.equal(res.body.data.expense.status, "pending");
    assert.ok(!res.body.data.expense.paid_at, "and is not stamped as paid");
  });
});
