require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const refundService = require("../services/orderRefund.service");
const orderPaymentService = require("../services/orderPayment.service");
const { staffToken, closeDb } = require("./helpers");
const { client } = require("../config/db");

/**
 * Overpayment goes back to the customer.
 *
 * The rules worth pinning are the ones about money: that a request alone
 * changes nothing, that paying clears the overpayment exactly, that nothing
 * can be refunded twice, and that a refund cannot be conjured out of the
 * migration-0021 duplicates.
 */
describe("overpayment refunds", () => {
  let orderId = null;
  let customerId = null;
  let accountId = null;
  let ready = false;

  const seedOrder = async (total, paid) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name)
      SELECT ${"RF" + Math.floor(Math.random() * 1e9)}, ${customerId}, 'Lagos', d.id, p.id, 1000,
             ${total / 1000}, ${total}, 'pickup', 'Refund Test Co'
        FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
      RETURNING id`;
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${o.id}, ${paid}, 'statement', now(), 'Test', 'seed', 'SEED')`;
    await client`UPDATE orders SET amount_paid = ${paid}, payment_status = 'Paid' WHERE id = ${o.id}`;
    return Number(o.id);
  };

  before(async () => {
    const [{ exists }] = await client`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_refunds') AS exists`;
    if (!exists) return;
    const c = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    const a = await client`SELECT id FROM bank_accounts ORDER BY id LIMIT 1`;
    const d = await client`SELECT id FROM depots LIMIT 1`;
    const p = await client`SELECT id FROM products LIMIT 1`;
    if (!c.length || !a.length || !d.length || !p.length) return;
    customerId = Number(c[0].id);
    accountId = Number(a[0].id);
    orderId = await seedOrder(1000000, 1250000); // ₦250,000 overpaid
    ready = true;
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM order_payments WHERE order_id = ${orderId}`;
      await client`DELETE FROM order_refunds WHERE order_id = ${orderId}`;
      await client`DELETE FROM orders WHERE id = ${orderId}`;
    }
    // The pool is closed once, by the LAST suite in this file — closing it
    // here would shut it before the HTTP suite below ever runs.
  });

  test("the overpayment is what the order holds beyond its value", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const s = await refundService.realSurplus(orderId);
    assert.equal(s.surplus, 250000);
    assert.equal(s.phantom, 0);
  });

  test("requesting changes NOTHING about the order", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const refund = await refundService.requestRefund({
      orderId,
      destinationBank: "GTBank", destinationName: "Bello Musa", destinationNumber: "0123456789",
      reason: "Paid twice",
    });
    assert.equal(Number(refund.amount), 250000);
    assert.equal(refund.status, "requested");

    // The money is still with us, so the order must still say so.
    const after = await refundService.realSurplus(orderId);
    assert.equal(after.surplus, 250000, "a request is not a payment");
    const [o] = await client`SELECT amount_paid::text AS paid FROM orders WHERE id = ${orderId}`;
    assert.equal(Number(o.paid), 1250000);
  });

  test("a second open request on the same order is refused", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    // Two would let the same overpayment be paid out twice.
    await assert.rejects(
      () => refundService.requestRefund({
        orderId, destinationBank: "X", destinationName: "Y", destinationNumber: "1",
      }),
      (e) => e.status === 409,
    );
  });

  test("marking it paid clears the overpayment exactly", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const [open] = await client`SELECT id FROM order_refunds WHERE order_id = ${orderId} AND status='requested'`;
    const result = await refundService.markRefunded({
      refundId: Number(open.id), paidFromAccountId: accountId, paymentReference: "REF-1",
    });
    assert.equal(result.refund.status, "refunded");

    const after = await refundService.realSurplus(orderId);
    assert.equal(after.surplus, 0, "the overpaid is now 0");
    assert.equal(after.received, 1000000, "the order holds exactly its own value");

    const [o] = await client`SELECT amount_paid::text AS paid, payment_status FROM orders WHERE id = ${orderId}`;
    assert.equal(Number(o.paid), 1000000);
    assert.equal(o.payment_status, "Paid", "settled, not part paid");

    // The money that left is recorded as its own negative row.
    const [row] = await client`
      SELECT amount::text AS amount, source, confirmation_basis FROM order_payments
       WHERE order_id = ${orderId} AND source = 'refund'`;
    assert.equal(Number(row.amount), -250000);
    assert.equal(row.confirmation_basis, "refund_desk");
  });

  test("a refund cannot be paid twice", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const [paid] = await client`SELECT id FROM order_refunds WHERE order_id = ${orderId} AND status='refunded'`;
    await assert.rejects(
      () => refundService.markRefunded({ refundId: Number(paid.id), paidFromAccountId: accountId }),
      (e) => e.status === 409,
    );
  });

  test("the refund row cannot be deleted as though it were a bank match", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const [row] = await client`SELECT id FROM order_payments WHERE order_id = ${orderId} AND source='refund'`;
    await assert.rejects(
      () => orderPaymentService.removePayment({ paymentId: Number(row.id) }),
      (e) => e.status === 400,
    );
  });

  test("a payment cannot be removed out from under a paid refund", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    // It would leave the order short by money already sent back — a shortfall
    // that reads as the customer's debt and is actually ours.
    const [row] = await client`SELECT id FROM order_payments WHERE order_id = ${orderId} AND source='statement'`;
    await assert.rejects(
      () => orderPaymentService.removePayment({ paymentId: Number(row.id) }),
      (e) => e.status === 409,
    );
  });

  test("undoing puts the request and the overpayment back", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const [paid] = await client`SELECT id FROM order_refunds WHERE order_id = ${orderId} AND status='refunded'`;
    await refundService.undoRefund({ refundId: Number(paid.id), reason: "marked paid by mistake" });

    const after = await refundService.realSurplus(orderId);
    assert.equal(after.surplus, 250000);
    const [r] = await client`SELECT status, paid_at FROM order_refunds WHERE id = ${paid.id}`;
    assert.equal(r.status, "requested");
    assert.equal(r.paid_at, null);
    const rows = await client`SELECT id FROM order_payments WHERE order_id = ${orderId} AND source='refund'`;
    assert.equal(rows.length, 0);

    await refundService.cancelRefund({ refundId: Number(paid.id), reason: "cleanup" });
  });

  test("an order holding nothing extra cannot raise a refund", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const square = await seedOrder(500000, 500000);
    try {
      await assert.rejects(
        () => refundService.requestRefund({
          orderId: square, destinationBank: "A", destinationName: "B", destinationNumber: "1",
        }),
        (e) => e.status === 409,
      );
    } finally {
      await client`DELETE FROM order_payments WHERE order_id = ${square}`;
      await client`DELETE FROM orders WHERE id = ${square}`;
    }
  });

  test("bank details are required — the payer works from them", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await assert.rejects(
      () => refundService.requestRefund({ orderId, destinationBank: "", destinationName: "", destinationNumber: "" }),
      (e) => e.status === 400,
    );
  });
});

describe("transfers between orders are switched off", () => {
  after(async () => { await closeDb(); });

  test("the endpoint answers 410 and names the replacement", async () => {
    const token = await staffToken(request, app);
    const [o] = await client`SELECT id FROM orders ORDER BY id DESC LIMIT 1`;
    const res = await request(app)
      .post(`/api/orders/${o.id}/payments/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ toOrderId: Number(o.id), amount: 1, reason: "should not work" });

    // 410, not 404: the route is gone on purpose and says what replaced it.
    assert.equal(res.status, 410, JSON.stringify(res.body));
    assert.match(res.body.message, /refund/i);
  });

  test("the refunds endpoints are reachable", async () => {
    const token = await staffToken(request, app);
    for (const url of ["/api/order-refunds", "/api/order-refunds/refundable"]) {
      const res = await request(app).get(url).set("Authorization", `Bearer ${token}`);
      // A new mount missing from config/apiPermissions is closed by default —
      // that failure is invisible until something calls it.
      assert.equal(res.status, 200, `${url} → ${res.status} ${JSON.stringify(res.body)}`);
    }
  });
});
