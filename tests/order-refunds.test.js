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

  test("a transfer and a refund cannot spend the same surplus", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");

    /*
     * The one way two live routes out of surplus could go wrong: request a
     * refund, move the money to another order, then mark the refund paid —
     * paying out money the order no longer holds and leaving it short.
     *
     * Both read the same payment rows, and marking paid re-checks inside the
     * locked transaction rather than trusting the figure the request was
     * raised at.
     */
    const donor = await seedOrder(1000000, 1300000);   // ₦300,000 over
    const receiver = await seedOrder(1000000, 400000); // needs ₦600,000
    try {
      const refund = await refundService.requestRefund({
        orderId: donor,
        destinationBank: "GTBank", destinationName: "Test", destinationNumber: "0123456789",
      });
      assert.equal(Number(refund.amount), 300000);

      // The surplus leaves by the other route.
      await orderPaymentService.transferSurplus({
        fromOrderId: donor, toOrderId: receiver, amount: 300000, reason: "moved before the refund was paid",
      });
      assert.equal((await refundService.realSurplus(donor)).surplus, 0);

      await assert.rejects(
        () => refundService.markRefunded({ refundId: refund.id, paidFromAccountId: accountId }),
        (e) => e.status === 409,
        "paying this out would leave the order short by money that has already moved",
      );
    } finally {
      await client`DELETE FROM order_payments WHERE order_id IN (${donor}, ${receiver})`;
      await client`DELETE FROM order_payment_transfers WHERE from_order_id = ${donor}`;
      await client`DELETE FROM order_refunds WHERE order_id = ${donor}`;
      await client`DELETE FROM orders WHERE id IN (${donor}, ${receiver})`;
    }
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

describe("a payment somebody deleted does not come back as an overpayment", () => {
  /**
   * The defect this pins, in full.
   *
   * Migration 0021 backfills payments and treats "no such row" as "never
   * recorded" — but a row a person DELETED is also absent, and
   * apply-unjournaled-migrations re-runs every hand-written file on every run.
   * So each time migrations were applied, deleted payments came back.
   *
   * Order 11332 in production: four bank payments totalling exactly its
   * ₦62,400,000 value, plus a wallet-era duplicate for the whole ₦62,400,000
   * re-created after being deleted — a fully settled order reporting an
   * overpayment of its entire value. Deleted twice, back twice. Three orders
   * were affected, ₦147,669,000 between them, all of it on the refunds page.
   *
   * 0021 now refuses to re-create a payment a person removed. The rows it
   * already re-created stay — the finance report is audited and reads this
   * table — but they are not counted as money owed back.
   */
  let orderId = null;
  let ready = false;

  before(async () => {
    const [{ exists }] = await client`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_refunds') AS exists`;
    if (!exists) return;
    const c = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    const d = await client`SELECT id FROM depots LIMIT 1`;
    const p = await client`SELECT id FROM products LIMIT 1`;
    if (!c.length || !d.length || !p.length) return;
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name)
      SELECT ${"RS" + Math.floor(Math.random() * 1e9)}, ${Number(c[0].id)}, 'Lagos', d.id, p.id, 1000,
             1000, 1000000, 'pickup', 'Resurrect Test Co'
        FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
      RETURNING id`;
    orderId = Number(o.id);

    // The real money: the order is settled exactly.
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${orderId}, 1000000, 'statement', now(), 'Test', 'the real payment', ${"RS" + orderId})`;

    // …and a wallet-era duplicate of the same amount, which somebody then
    // removed. Written and deleted for real rather than invented, so the id
    // ordering the rule turns on is the ordering production actually had.
    const [dup] = await client`
      INSERT INTO order_payments (order_id, amount, source, note)
      VALUES (${orderId}, 1000000, 'legacy', 'the wallet duplicate')
      RETURNING id`;
    await client`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata)
      VALUES ('order', ${orderId}, 'order.payment_removed', 'system',
              ${JSON.stringify({ amount: "1000000.00", reason: "Wrong", paymentId: Number(dup.id) })}::jsonb)`;
    await client`DELETE FROM order_payments WHERE id = ${Number(dup.id)}`;

    // …and the backfill put it back, after the removal — a higher id, and its
    // own note naming the migration.
    await client`
      INSERT INTO order_payments (order_id, amount, source, note)
      VALUES (${orderId}, 1000000, 'legacy',
              'Backfilled from the wallet allocation ledger (migration 0021) — no bank statement line was ever recorded for this payment')`;
    ready = true;
  });

  after(async () => {
    if (!ready) return;
    await client`DELETE FROM audit_logs WHERE entity_type='order' AND entity_id=${orderId}`;
    await client`DELETE FROM order_payments WHERE order_id = ${orderId}`;
    await client`DELETE FROM order_refunds WHERE order_id = ${orderId}`;
    await client`DELETE FROM orders WHERE id = ${orderId}`;
  });

  test("the re-created row is not counted as money we hold", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const s = await refundService.realSurplus(orderId);
    assert.equal(s.received, 1000000, "the real payment, and only that");
    assert.equal(s.surplus, 0, "a settled order is settled");
    assert.equal(s.resurrected, 1000000, "stated, not silently dropped");
  });

  test("so the order is not on the refunds list at all", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const rows = await refundService.listRefundable({ limit: 1000 });
    assert.equal(rows.find((r) => r.orderId === orderId), undefined);
  });

  test("and nothing can be refunded from it", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await assert.rejects(
      () => refundService.requestRefund({
        orderId, destinationBank: "GTBank", destinationName: "Test", destinationNumber: "0123456789",
      }),
      (e) => e.status === 409,
    );
  });

  test("a genuine payment of the same amount entered BEFORE the removal still counts", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    /*
     * The trap the id ordering exists for: on order 11293 the real statement
     * rows carry the same ₦36,360,000 and ₦18,180,000 as the duplicates beside
     * them. Matching on amount alone would throw the real money away too.
     */
    const [{ received }] = await client`
      SELECT SUM(amount)::numeric AS received FROM order_payments
       WHERE order_id = ${orderId} AND source = 'statement'`;
    assert.equal(Number(received), 1000000);
    const s = await refundService.realSurplus(orderId);
    assert.equal(s.received, 1000000, "the older, person-entered row survives the rule");
  });
});

describe("surplus already moved away", () => {
  /**
   * What is left to refund is the BALANCE, not the gross overpayment.
   *
   * Transfers are a balanced pair of payment rows — positive onto the order
   * that received the money, negative off the one that lost it — so summing
   * the payments already nets them out. In production the two sides are 72
   * rows each and cancel to the naira, and order 11293 shows ₦54,540,000
   * rather than ₦54,665,000 for exactly this reason.
   *
   * Pinned because it is invisible when it breaks: change the sign convention,
   * or filter a source out of the sum, and every refund figure on the page
   * quietly becomes the amount BEFORE the money that already left. Somebody
   * would then send it a second time.
   */
  let orderId = null;
  let ready = false;

  before(async () => {
    const [{ exists }] = await client`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_refunds') AS exists`;
    if (!exists) return;
    const c = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    const d = await client`SELECT id FROM depots LIMIT 1`;
    const p = await client`SELECT id FROM products LIMIT 1`;
    if (!c.length || !d.length || !p.length) return;
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name)
      SELECT ${"TR" + Math.floor(Math.random() * 1e9)}, ${Number(c[0].id)}, 'Lagos', d.id, p.id, 1000,
             1000, 1000000, 'pickup', 'Transfer Test Co'
        FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
      RETURNING id`;
    orderId = Number(o.id);
    // ₦300,000 over, then ₦100,000 of it moved onto another order.
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${orderId}, 1300000, 'statement', now(), 'Test', 'seed', ${"TRF" + orderId})`;
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${orderId}, -100000, 'transfer_out', now(), 'Test', 'moved to another order', ${"TRFOUT" + orderId})`;
    await client`UPDATE orders SET amount_paid = 1200000, payment_status = 'Paid' WHERE id = ${orderId}`;
    ready = true;
  });

  after(async () => {
    if (!ready) return;
    await client`DELETE FROM order_payments WHERE order_id = ${orderId}`;
    await client`DELETE FROM order_refunds WHERE order_id = ${orderId}`;
    await client`DELETE FROM orders WHERE id = ${orderId}`;
  });

  test("what is left to refund is net of what already left", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const s = await refundService.realSurplus(orderId);
    // ₦1,300,000 in, ₦100,000 out, against a ₦1,000,000 order.
    assert.equal(s.received, 1200000);
    assert.equal(s.surplus, 200000, "not the ₦300,000 it held before the transfer");

    const rows = await refundService.listRefundable({ limit: 1000 });
    const row = rows.find((r) => r.orderId === orderId);
    assert.ok(row, "still owed something, so still listed");
    assert.equal(row.surplus, 200000);
    assert.equal(row.transferredOut, 100000, "stated, so the figure can be understood");
  });

  test("a refund cannot reach back past the transfer", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await assert.rejects(
      () => refundService.requestRefund({
        orderId, amount: 300000,
        destinationBank: "GTBank", destinationName: "Test", destinationNumber: "0123456789",
      }),
      (e) => e.status === 400,
      "the ₦100,000 already moved cannot be sent a second time",
    );

    const refund = await refundService.requestRefund({
      orderId,
      destinationBank: "GTBank", destinationName: "Test", destinationNumber: "0123456789",
    });
    assert.equal(Number(refund.amount), 200000, "the default is the balance");
  });
});

describe("setting an overpayment aside", () => {
  /**
   * The list has to be clearable or it stops being read.
   *
   * 179 orders hold surplus, 25 of them under ₦1,000 — less than the transfer
   * costs — and some of the larger ones were settled long ago by moving the
   * money to another order. Skipping records that decision without touching
   * the money, which is the part that matters: waiving a debt is not the same
   * as the debt not existing, and every report must go on saying so.
   */
  let orderId = null;
  let customerId = null;
  let ready = false;

  before(async () => {
    const [{ exists }] = await client`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='order_refunds') AS exists`;
    if (!exists) return;
    const c = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    const d = await client`SELECT id FROM depots LIMIT 1`;
    const p = await client`SELECT id FROM products LIMIT 1`;
    if (!c.length || !d.length || !p.length) return;
    customerId = Number(c[0].id);
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name)
      SELECT ${"SK" + Math.floor(Math.random() * 1e9)}, ${customerId}, 'Lagos', d.id, p.id, 1000,
             1000, 1000000, 'pickup', 'Skip Test Co'
        FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
      RETURNING id`;
    orderId = Number(o.id);
    // ₦400 overpaid: real money, and not worth a bank transfer.
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${orderId}, 1000400, 'statement', now(), 'Test', 'seed', ${"SKIP" + orderId})`;
    await client`UPDATE orders SET amount_paid = 1000400, payment_status = 'Paid' WHERE id = ${orderId}`;
    ready = true;
  });

  after(async () => {
    if (!ready) return;
    await client`DELETE FROM order_payments WHERE order_id = ${orderId}`;
    await client`DELETE FROM order_refunds WHERE order_id = ${orderId}`;
    await client`DELETE FROM orders WHERE id = ${orderId}`;
  });

  const listed = async () => {
    const rows = await refundService.listRefundable({ limit: 1000 });
    return rows.find((r) => r.orderId === orderId) || null;
  };

  test("the order is on the list, under the reference people can look up", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const row = await listed();
    assert.ok(row, "an order holding ₦400 beyond its value is refundable");
    assert.equal(row.surplus, 400);
    // "SK12345", built from the company initials and the id — never the raw
    // ORD-… column, which names an order no screen can find.
    assert.match(row.orderNumber, /^ST\d+$/, `got ${row.orderNumber}`);
    assert.ok(!row.orderNumber.startsWith("ORD-"));
  });

  test("a reason is required — the note is the whole point", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await assert.rejects(
      () => refundService.skipOrder({ orderId, reason: "   " }),
      (e) => e.status === 400,
    );
  });

  test("setting it aside takes it off the list and touches nothing", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const skip = await refundService.skipOrder({
      orderId, reason: "₦400 — costs more to send than it is worth",
    });
    assert.equal(skip.status, "skipped");
    assert.equal(Number(skip.amount), 400);

    assert.equal(await listed(), null, "it is off the refund list");

    // The money is untouched: still received, still surplus, still on the order.
    const after = await refundService.realSurplus(orderId);
    assert.equal(after.surplus, 400, "setting aside is a decision, not a correction");
    const [o] = await client`SELECT amount_paid::text AS paid FROM orders WHERE id = ${orderId}`;
    assert.equal(Number(o.paid), 1000400);
  });

  test("it cannot be set aside twice", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await assert.rejects(
      () => refundService.skipOrder({ orderId, reason: "again" }),
      (e) => e.status === 409,
    );
  });

  test("more money since means the decision no longer covers it, so it returns", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${orderId}, 500000, 'statement', now(), 'Test', 'more', ${"SKIP2" + orderId})`;

    const row = await listed();
    assert.ok(row, "₦500,400 is not the ₦400 somebody waived");
    assert.equal(row.surplus, 500400);
    assert.deepEqual(row.previouslySkipped && row.previouslySkipped.amount, 400);

    await client`DELETE FROM order_payments WHERE bank_ref = ${"SKIP2" + orderId}`;
  });

  test("lifting the skip keeps the decision on the record", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const [skip] = await client`
      SELECT id FROM order_refunds WHERE order_id = ${orderId} AND status = 'skipped'`;
    const restored = await refundService.restoreSkipped({ refundId: Number(skip.id) });
    assert.equal(restored.status, "cancelled");
    assert.ok(restored.cancelledAt, "who and when are kept");

    const row = await listed();
    assert.ok(row, "back on the list");
    assert.equal(row.previouslySkipped, null);

    // And it can be set aside again — the index only counts live ones.
    const again = await refundService.skipOrder({ orderId, reason: "still not worth it" });
    assert.equal(again.status, "skipped");
  });
});

describe("transfers and refunds run side by side", () => {
  after(async () => { await closeDb(); });

  test("moving surplus between orders still works", async () => {
    /*
     * Both destinations for surplus are live: onto another order, or back to
     * the customer. This pins that adding refunds did not retire transfers —
     * the endpoint was briefly switched off and is deliberately back.
     */
    const token = await staffToken(request, app);
    const [o] = await client`SELECT id FROM orders ORDER BY id DESC LIMIT 1`;
    const res = await request(app)
      .post(`/api/orders/${o.id}/payments/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ toOrderId: Number(o.id), amount: 1, reason: "same order on purpose" });

    // Reachable, and refused on its own merits — an order cannot transfer to
    // itself — rather than with the 410 that meant the route was gone.
    assert.notEqual(res.status, 410, "the transfer endpoint must not be retired");
    assert.ok(res.status === 400 || res.status === 409, `expected a validation refusal, got ${res.status}`);
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
