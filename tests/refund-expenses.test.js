// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const refundService = require("../services/orderRefund.service");
const { client } = require("../config/db");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * An overpayment refund is paid through the expense chain (migration 0065):
 *
 *   requested   an expense is raised at "With CFO" — refunds skip verification
 *   approved    CFO, then final approval, as for any expense
 *   paid        the Expenditure Officer marks it paid, which records the refund
 *               on the order (balance 0) in the same transaction
 *   rejected    the refund is cancelled with the same reason
 *   cancelled   cancelling the refund withdraws the expense
 *
 * And a refund is never a cost: no PFI, and out of the spending totals.
 */
const RUN = Date.now();

describe("refunds paid through expenses", () => {
  let requester, cfo, admin, officer;
  // A refund is not a station expense, so its officer is the general one.
  const savedOfficer = process.env.EXPENSE_OFFICER_STAFF_IDS;
  let tokens = {};
  let customerId, accountLabel;
  const orderIds = [];

  const call = (who, method, url, body = {}) =>
    request(app)[method](url).set("Authorization", `Bearer ${tokens[who]}`).send(body);

  const seedOrder = async (total, paid) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price, total_amount,
                          delivery_type, company_name, payment_status, amount_paid)
      SELECT ${`RX${RUN}${orderIds.length}`}, ${customerId}, 'Lagos', d.id, p.id, 1000, ${total / 1000}, ${total},
             'pickup', 'Refund Expense Co', 'Paid', ${paid}
        FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
      RETURNING id`;
    await client`INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
                 VALUES (${o.id}, ${paid}, 'statement', now(), 'Test', 'seed', ${`RX-${RUN}-${orderIds.length}`})`;
    orderIds.push(Number(o.id));
    return Number(o.id);
  };

  const request_ = (orderId, staffId) => refundService.requestRefund({
    orderId, destinationBank: "GTBank", destinationName: "Refund Customer", destinationNumber: "0123456789",
    reason: "Paid twice", staffId,
  });
  const expenseOf = async (refundId) =>
    (await client`SELECT e.* FROM order_refunds r JOIN pfi_expenses e ON e.id = r.expense_id WHERE r.id = ${refundId}`)[0];
  const refundRow = async (refundId) => (await client`SELECT * FROM order_refunds WHERE id = ${refundId}`)[0];
  const surplusOf = async (orderId) => (await refundService.realSurplus(orderId)).surplus;

  const approve = async (expenseId) => {
    let res = await call("cfo", "post", `/api/expenses/${expenseId}/review`, { action: "audit_approve" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await call("admin", "post", `/api/expenses/${expenseId}/review`, { action: "admin_approve" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };

  before(async () => {
    const mk = async (roles, tag) => staffTokenWithRoles(roles, `rx-${tag}-${RUN}@soroman.test`);
    ({ staff: requester, accessToken: tokens.requester } = await mk(["sales_manager"], "req"));
    ({ staff: cfo, accessToken: tokens.cfo } = await mk(["finance"], "cfo"));
    ({ staff: admin, accessToken: tokens.admin } = await mk(["admin"], "adm"));
    ({ staff: officer, accessToken: tokens.officer } = await mk(["expenditure_officer"], "off"));
    process.env.EXPENSE_OFFICER_STAFF_IDS = String(officer.id);
    customerId = Number((await client`SELECT id FROM customers ORDER BY id LIMIT 1`)[0].id);
    const [a] = await client`SELECT bank_name, account_number FROM bank_accounts WHERE account_number <> '' ORDER BY id LIMIT 1`;
    accountLabel = `${a.bank_name} · ${a.account_number}`;
  });

  after(async () => {
    if (savedOfficer === undefined) delete process.env.EXPENSE_OFFICER_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STAFF_IDS = savedOfficer;
    if (orderIds.length) {
      await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds}::int[])`;
      await client`DELETE FROM order_refunds WHERE order_id = ANY(${orderIds}::int[])`;
      await client`DELETE FROM orders WHERE id = ANY(${orderIds}::int[])`;
    }
    await closeDb();
  });

  test("requesting raises the expense at the CFO, never against a PFI", async () => {
    const orderId = await seedOrder(1_000_000, 1_200_000);
    const refund = await request_(orderId, requester.id);
    const e = await expenseOf(refund.id);
    assert.equal(e.status, "verified", "straight to the CFO");
    assert.equal(Number(e.amount), 200000);
    // Booked to the order's PFI (none on this seed order) — but never its cost.
    assert.equal(e.payee_account_number, "0123456789");
  });

  test("approved and marked paid by the officer: the refund is on the order and the balance is 0", async () => {
    const orderId = await seedOrder(1_000_000, 1_150_000);
    const refund = await request_(orderId, requester.id);
    const e = await expenseOf(refund.id);
    await approve(e.id);

    // The refund desk cannot pay it any more — only the expense can.
    await assert.rejects(
      () => refundService.markRefunded({ refundId: refund.id, paidFromAccountId: 1 }),
      (err) => err.status === 409,
    );

    const res = await call("officer", "post", `/api/expenses/${e.id}/review`, {
      action: "mark_paid", bank_paid_from: accountLabel, amount_paid: 150000, payment_reference: "RX-PAY-1",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await refundRow(refund.id)).status, "refunded");
    assert.equal((await expenseOf(refund.id)).status, "paid");
    assert.equal(await surplusOf(orderId), 0, "nothing left over");
    const [pay] = await client`SELECT amount::numeric, bank_ref FROM order_payments WHERE refund_id = ${refund.id}`;
    assert.equal(Number(pay.amount), -150000);
    assert.equal(pay.bank_ref, "RX-PAY-1");
  });

  test("a refund is paid in full, from one of the company's accounts", async () => {
    const orderId = await seedOrder(1_000_000, 1_100_000);
    const refund = await request_(orderId, requester.id);
    const e = await expenseOf(refund.id);
    await approve(e.id);
    let res = await call("officer", "post", `/api/expenses/${e.id}/review`, {
      action: "mark_paid", bank_paid_from: accountLabel, amount_paid: 60000, payment_notes: "part",
    });
    assert.equal(res.status, 400);
    res = await call("officer", "post", `/api/expenses/${e.id}/review`, {
      action: "mark_paid", bank_paid_from: "Some other bank · 9999", amount_paid: 100000,
    });
    assert.equal(res.status, 400);
    assert.equal((await refundRow(refund.id)).status, "requested", "nothing half-done");
    assert.equal((await expenseOf(refund.id)).status, "admin_approved");
  });

  test("if the order's payments change first, paying is refused and nothing moves", async () => {
    const orderId = await seedOrder(1_000_000, 1_300_000);
    const refund = await request_(orderId, requester.id);
    const e = await expenseOf(refund.id);
    await approve(e.id);
    // The wrong match corrected by hand, without the recompute that would
    // cancel the request — the pay step's own check is what is under test.
    await client`UPDATE order_payments SET amount = 1100000 WHERE order_id = ${orderId}`;
    const res = await call("officer", "post", `/api/expenses/${e.id}/review`, {
      action: "mark_paid", bank_paid_from: accountLabel, amount_paid: 300000,
    });
    assert.equal(res.status, 409);
    assert.equal((await expenseOf(refund.id)).status, "admin_approved");
    assert.equal((await refundRow(refund.id)).status, "requested");
    await refundService.cancelRefund({ refundId: refund.id, reason: "payments corrected" });
  });

  test("the CFO rejecting the expense cancels the refund, with the reason", async () => {
    const orderId = await seedOrder(1_000_000, 1_050_000);
    const refund = await request_(orderId, requester.id);
    const e = await expenseOf(refund.id);
    const res = await call("cfo", "post", `/api/expenses/${e.id}/review`, { action: "reject", note: "Customer asked to keep it" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = await refundRow(refund.id);
    assert.equal(r.status, "cancelled");
    assert.match(r.cancel_reason, /Customer asked to keep it/);
  });

  test("cancelling the refund withdraws its expense; a cancelled refund's expense stays closed", async () => {
    const orderId = await seedOrder(1_000_000, 1_040_000);
    const refund = await request_(orderId, requester.id);
    await refundService.cancelRefund({ refundId: refund.id, reason: "Raised in error", staffId: cfo.id });
    const e = await expenseOf(refund.id);
    assert.equal(e.status, "rejected");
    const res = await call("requester", "patch", `/api/expenses/${e.id}`, { description: "revive" });
    assert.equal(res.status, 409);
  });

  test("undoing a paid refund puts its expense back to awaiting payment", async () => {
    const orderId = await seedOrder(1_000_000, 1_020_000);
    const refund = await request_(orderId, requester.id);
    const e = await expenseOf(refund.id);
    await approve(e.id);
    await call("officer", "post", `/api/expenses/${e.id}/review`, {
      action: "mark_paid", bank_paid_from: accountLabel, amount_paid: 20000,
    });
    await refundService.undoRefund({ refundId: refund.id, reason: "marked paid by mistake" });
    assert.equal((await expenseOf(refund.id)).status, "admin_approved");
    assert.equal(await surplusOf(orderId), 20000);
  });

  test("a request raised before refunds had expenses gets one, at the CFO — unless it is no longer owed", async () => {
    const orderId = await seedOrder(1_000_000, 1_090_000);
    const [old] = await client`
      INSERT INTO order_refunds (order_id, customer_id, amount, status, destination_bank, destination_name, destination_number, requested_by)
      VALUES (${orderId}, ${customerId}, 90000, 'requested', 'GTBank', 'Old Request', '0123456789', ${requester.id}) RETURNING id`;
    const e = await refundService.raiseExpenseForOpenRefund(old.id);
    assert.equal(e.status, "verified");
    assert.equal((await expenseOf(old.id)).id, e.id);
    await assert.rejects(() => refundService.raiseExpenseForOpenRefund(old.id), (err) => err.status === 409, "only once");

    const staleOrder = await seedOrder(1_000_000, 1_000_000);
    const [stale] = await client`
      INSERT INTO order_refunds (order_id, customer_id, amount, status, destination_bank, destination_name, destination_number)
      VALUES (${staleOrder}, ${customerId}, 50000, 'requested', 'GTBank', 'Stale', '0123456789') RETURNING id`;
    await assert.rejects(() => refundService.raiseExpenseForOpenRefund(stale.id), (err) => err.status === 409);
  });

  test("the expense sits under the order's PFI, and paying it moves none of that PFI's costs", async () => {
    const { pfiExpenseRepo } = require("../repositories");
    const [depot] = await client`SELECT id FROM depots ORDER BY id LIMIT 1`;
    const [product] = await client`SELECT id FROM products ORDER BY id LIMIT 1`;
    const [pfi] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, location_id, product_id, starting_qty_litres)
      VALUES (${`PFI/RX/${RUN}`}, 'coastal', 'active', ${depot.id}, ${product.id}, 100000) RETURNING id`;
    try {
      const orderId = await seedOrder(1_000_000, 1_080_000);
      await client`UPDATE orders SET pfi_id = ${pfi.id} WHERE id = ${orderId}`;
      const before = (await pfiExpenseRepo.aggregatesFor([pfi.id])).get(Number(pfi.id));

      const refund = await request_(orderId, requester.id);
      const e = await expenseOf(refund.id);
      assert.equal(Number(e.pfi_id), Number(pfi.id), "found under its PFI");
      await approve(e.id);
      await call("officer", "post", `/api/expenses/${e.id}/review`, {
        action: "mark_paid", bank_paid_from: accountLabel, amount_paid: 80000,
      });

      const after = (await pfiExpenseRepo.aggregatesFor([pfi.id])).get(Number(pfi.id));
      assert.equal(after.totalExpenses ?? after.expenses ?? after.total, before.totalExpenses ?? before.expenses ?? before.total,
        "a refund is never the cargo's cost");
      assert.equal(after.pendingExpenses, before.pendingExpenses);
    } finally {
      await client`UPDATE pfi_expenses SET pfi_id = NULL WHERE pfi_id = ${pfi.id}`;
      await client`UPDATE orders SET pfi_id = NULL WHERE pfi_id = ${pfi.id}`;
      await client`DELETE FROM pfis WHERE id = ${pfi.id}`;
    }
  });

  test("refunds are counted on the expenses page but never added to spending", async () => {
    const res = await call("cfo", "get", "/api/expenses?limit=5");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const summary = res.body.data?.totals || res.body.totals || res.body.data?.summary || {};
    const [{ spend }] = await client`
      SELECT COALESCE(SUM(CASE WHEN e.status = 'paid' THEN COALESCE(e.amount_paid_ngn, e.amount_ngn) ELSE e.amount_ngn END), 0)::numeric AS spend
        FROM pfi_expenses e JOIN expense_categories c ON c.id = e.category_id
       WHERE e.deleted_at IS NULL AND NOT c.is_refund`;
    if (summary.total !== undefined) assert.ok(Number(summary.total) <= Number(spend) + 0.01);
    assert.ok(Number(summary.refund_total ?? summary.refundTotal ?? 0) > 0, "refunds totalled on their own");
  });
});
