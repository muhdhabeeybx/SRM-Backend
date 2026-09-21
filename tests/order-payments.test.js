// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { eq, inArray } = require("drizzle-orm");

const { db } = require("../config/db");
const {
  customers, depots, products, orders, bankAccounts, bankStatements,
  bankStatementLines, orderPayments, orderPaymentTransfers,
} = require("../db/schema");
const orderPaymentService = require("../services/orderPayment.service");
const { closeDb } = require("./helpers");

/**
 * Money received against an ORDER, and nothing else.
 *
 * The property every test here defends: what an order was paid with is what
 * the bank statement says, recorded against that order, and no balance
 * anywhere is ever drawn on to make an order look settled.
 *
 * This replaced order-payment-attribution.test.js, which tested the same
 * intent under the wallet model — including one case ("a shortfall is drawn
 * from wallet balance and marked as such") whose expected behaviour is now
 * exactly the bug. That case is inverted below.
 *
 * Order 11453 in production is what the whole area exists for. Staff matched
 * an ₦18,075,000 credit from TETRIS ENERGY to it; the report showed ₦250,000
 * from a stranger, ₦250,000 from an internal transfer, and ₦9,724,500 of the
 * credit actually chosen. Every figure unfindable on a bank statement, on a
 * report whose only purpose is to agree with one.
 */

const suffix = Date.now().toString(36);
const money = (v) => Number(v || 0);

describe("order payments", () => {
  let customer;
  let depot;
  let product;
  let bankAccount;
  let statement;
  let orderSeq = 0;
  let lineSeq = 0;

  const makeOrder = async (totalAmount) => {
    orderSeq += 1;
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `ORD-PAY-${suffix}-${orderSeq}`,
        customerId: customer.id,
        state: "Lagos",
        depotId: depot.id,
        productId: product.id,
        quantity: 100,
        price: "1.00",
        totalAmount: String(totalAmount),
        deliveryType: "pickup",
      })
      .returning();
    return order;
  };

  /** An unmatched statement line, as an upload would leave it. */
  const makeLine = async (amount, depositor) => {
    lineSeq += 1;
    const [line] = await db
      .insert(bankStatementLines)
      .values({
        statementId: statement.id,
        bankAccountId: bankAccount.id,
        // A `date` column, bound as a string. This used to be the instant
        // 2026-08-20T23:00Z — already the 21st in Lagos, which is the banking
        // day it stood for — and postgres.js refused the Date object outright.
        txnDate: "2026-08-21",
        amount: String(amount),
        depositor,
        narration: `NIP/${depositor}`,
        bankRef: `REF-${suffix}-${lineSeq}`,
        dedupKey: `DEDUP-${suffix}-${lineSeq}`,
        status: "UNMATCHED",
      })
      .returning();
    return line;
  };

  const confirm = (order, lineIds, note = "") =>
    orderPaymentService.recordFromStatementLines({
      orderId: order.id,
      bankAccountId: bankAccount.id,
      lineIds,
      staffId: null,
      note,
    });

  const paymentsFor = (orderId) =>
    db
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.orderId, orderId))
      .orderBy(orderPayments.id);

  const orderRow = async (id) => {
    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    return row;
  };

  before(async () => {
    [customer] = await db
      .insert(customers)
      .values({
        name: "Order Payment Test",
        phone: `+23481${String(Date.now()).slice(-8)}`,
        balance: "0",
      })
      .returning();

    [depot] = await db
      .insert(depots)
      .values({
        name: `Payment Depot ${suffix}`,
        code: `PDT-${suffix}`,
        address: "1 Test Road",
        city: "Lagos",
        state: "Lagos",
        country: "Nigeria",
        postcode: "100001",
        maxCapacity: 1000000,
        establishedYear: "2020",
      })
      .returning();

    [product] = await db
      .insert(products)
      .values({ name: `Payment Product ${suffix}`, sku: `PPR-${suffix}`, category: "PMS" })
      .returning();

    [bankAccount] = await db
      .insert(bankAccounts)
      .values({
        bankName: "Zenith Bank",
        accountName: "SOROMAN TEST",
        accountNumber: `13119${String(Date.now()).slice(-5)}`,
        status: "Active",
      })
      .returning();

    [statement] = await db
      .insert(bankStatements)
      .values({
        bankAccountId: bankAccount.id,
        filename: `payments-${suffix}.csv`,
        periodStart: new Date("2026-08-01"),
        periodEnd: new Date("2026-08-31"),
      })
      .returning();
  });

  after(async () => {
    const orderIds = (
      await db.select({ id: orders.id }).from(orders).where(eq(orders.customerId, customer.id))
    ).map((r) => r.id);
    if (orderIds.length) {
      await db.delete(orderPayments).where(inArray(orderPayments.orderId, orderIds));
      await db.delete(orderPaymentTransfers).where(inArray(orderPaymentTransfers.fromOrderId, orderIds));
    }
    await db.delete(bankStatementLines).where(eq(bankStatementLines.statementId, statement.id));
    await db.delete(bankStatements).where(eq(bankStatements.id, statement.id));
    if (orderIds.length) await db.delete(orders).where(inArray(orders.id, orderIds));
    await db.delete(customers).where(eq(customers.id, customer.id));
    await db.delete(bankAccounts).where(eq(bankAccounts.id, bankAccount.id));
    await db.delete(products).where(eq(products.id, product.id));
    await db.delete(depots).where(eq(depots.id, depot.id));
    await closeDb();
  });

  test("the payment IS the statement line — its own amount, date, payer and reference", async () => {
    // Older, unrelated money paid against another order. Under the old model
    // this is precisely what the oldest-first walk would have spent first.
    const stale = await makeLine(250000, "SOMEONE ELSE");
    const staleOrder = await makeOrder(100000);
    await confirm(staleOrder, [stale.id]);

    const line = await makeLine(18075000, "TETRIS ENERGY LIMITED");
    const order = await makeOrder(10224500);
    const { summary } = await confirm(order, [line.id]);

    const rows = await paymentsFor(order.id);
    assert.equal(rows.length, 1, "one line was matched, so one payment belongs on the order");
    assert.equal(rows[0].source, "statement");
    assert.equal(money(rows[0].amount), 18075000, "the statement's own figure, at face value");
    assert.equal(rows[0].bankRef, line.bankRef);
    assert.equal(rows[0].depositor, "TETRIS ENERGY LIMITED");
    assert.equal(rows[0].statementLineId, line.id);
    assert.equal(rows[0].bankName, "Zenith Bank", "the account it was paid into, snapshotted");
    assert.equal(
      new Date(rows[0].txnDate).toISOString(),
      new Date(line.txnDate).toISOString(),
      "the banking date, not the day it was keyed in",
    );

    // The surplus is ON the order, not swept into a balance somewhere.
    assert.equal(summary.received, 18075000);
    assert.equal(summary.applied, 10224500, "capped at what the order was worth");
    assert.equal(summary.surplus, 18075000 - 10224500);
    assert.equal(summary.shortfall, 0);

    // And the other order's payment was left entirely alone.
    const staleRows = await paymentsFor(staleOrder.id);
    assert.equal(staleRows.length, 1);
    assert.equal(money(staleRows[0].amount), 250000);
  });

  test("a shortfall is NOT drawn from anywhere — the order simply stays short", async () => {
    // This is the inversion. The old model covered a shortfall out of whatever
    // balance the customer happened to have, which is how an order came to be
    // "paid" by a stranger's transfer from three weeks earlier. There is
    // ₦7,850,500 of surplus sitting on another of this customer's orders right
    // now, and none of it may move on its own.
    const line = await makeLine(400000, "PART PAYER");
    const order = await makeOrder(500000);
    const { summary } = await confirm(order, [line.id]);

    const rows = await paymentsFor(order.id);
    assert.equal(rows.length, 1, "only the money that actually arrived");
    assert.equal(rows[0].source, "statement");
    assert.equal(money(rows[0].amount), 400000);

    assert.equal(summary.received, 400000);
    assert.equal(summary.shortfall, 100000, "the gap is reported, not filled in");
    assert.equal(summary.surplus, 0);

    const row = await orderRow(order.id);
    assert.equal(row.paymentStatus, "Part Paid");
    assert.equal(money(row.amountPaid), 400000, "amount_paid is a cache of the payment rows");
  });

  test("several lines on one order all land at face value", async () => {
    const a = await makeLine(20000000, "TRANCHE ONE");
    const b = await makeLine(15000000, "TRANCHE TWO");
    const order = await makeOrder(30000000);
    const { summary } = await confirm(order, [a.id, b.id]);

    const rows = await paymentsFor(order.id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.source === "statement"));
    assert.equal(rows.reduce((s, r) => s + money(r.amount), 0), 35000000, "both lines, in full");
    assert.equal(summary.applied, 30000000, "the order consumed only its own value");
    assert.equal(summary.surplus, 5000000);
  });

  test("a statement line can only ever be matched to one order", async () => {
    const line = await makeLine(1000000, "ONLY ONCE");
    const first = await makeOrder(1000000);
    const second = await makeOrder(1000000);

    await confirm(first, [line.id]);
    await assert.rejects(
      () => confirm(second, [line.id]),
      /already matched to another order/i,
      "the second claim is refused rather than splitting the line across two orders",
    );

    // And the refusal left nothing behind on the order that lost.
    assert.equal((await paymentsFor(second.id)).length, 0);
    const [after] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, line.id));
    assert.equal(after.status, "MATCHED");
    assert.equal(after.matchedOrderId, first.id);
  });

  test("surplus moves between orders as an explicit, two-legged transfer", async () => {
    const line = await makeLine(9000000, "OVERPAYER");
    const from = await makeOrder(6000000);
    const to = await makeOrder(4000000);
    await confirm(from, [line.id]);

    const result = await orderPaymentService.transferSurplus({
      fromOrderId: from.id,
      toOrderId: to.id,
      amount: 3000000,
      reason: "Customer asked for the balance to go on their next load",
      staffId: null,
    });

    assert.equal(result.from.received, 6000000, "the source nets down to what it kept");
    assert.equal(result.from.surplus, 0);
    assert.equal(result.to.received, 3000000);
    assert.equal(result.to.shortfall, 1000000, "the destination is still short, and says so");

    const fromRows = await paymentsFor(from.id);
    const out = fromRows.find((r) => r.source === "transfer_out");
    assert.ok(out, "the order that gave the money away carries a leg saying so");
    assert.equal(money(out.amount), -3000000, "negative, so a plain SUM nets it out");

    const toRows = await paymentsFor(to.id);
    const incoming = toRows.find((r) => r.source === "transfer_in");
    assert.ok(incoming);
    assert.equal(money(incoming.amount), 3000000);
    assert.equal(out.transferId, incoming.transferId, "both legs name the same movement");

    // The order that received it is Part Paid, on money that never touched a
    // wallet and can still be traced to a bank line via the source order.
    const toRow = await orderRow(to.id);
    assert.equal(toRow.paymentStatus, "Part Paid");
    assert.equal(money(toRow.amountPaid), 3000000);
  });

  test("an order cannot give away money it needs for its own value", async () => {
    const line = await makeLine(5000000, "EXACT PAYER");
    const from = await makeOrder(5000000);
    const to = await makeOrder(1000000);
    await confirm(from, [line.id]);

    await assert.rejects(
      () =>
        orderPaymentService.transferSurplus({
          fromOrderId: from.id,
          toOrderId: to.id,
          amount: 1000000,
          reason: "should not be allowed",
          staffId: null,
        }),
      /only has ₦0 of surplus to move/i,
    );

    assert.equal((await orderPaymentService.summarizeOrder(from.id)).received, 5000000);
    assert.equal((await paymentsFor(to.id)).length, 0);
  });

  test("reversing a transfer is refused while the destination is relying on it", async () => {
    const line = await makeLine(10000000, "BIG PAYER");
    const from = await makeOrder(4000000);
    const to = await makeOrder(6000000);
    await confirm(from, [line.id]);

    const { transfer } = await orderPaymentService.transferSurplus({
      fromOrderId: from.id,
      toOrderId: to.id,
      amount: 6000000,
      reason: "covering the second order in full",
      staffId: null,
    });
    assert.equal((await orderRow(to.id)).paymentStatus, "Paid");

    await assert.rejects(
      () => orderPaymentService.reverseTransfer({ transferId: transfer.id, staffId: null }),
      /relying on this/i,
      "taking it back would leave that order short, so it is refused rather than half-done",
    );

    // Still exactly as it was — a refused reversal moves nothing.
    assert.equal((await orderPaymentService.summarizeOrder(to.id)).received, 6000000);
    assert.equal((await orderPaymentService.summarizeOrder(from.id)).received, 4000000);
  });

  test("removing a payment returns its line to the pool and re-derives the order", async () => {
    const line = await makeLine(2500000, "WRONG ORDER");
    const order = await makeOrder(2500000);
    const { payments } = await confirm(order, [line.id]);
    assert.equal((await orderRow(order.id)).paymentStatus, "Paid");

    const { summary } = await orderPaymentService.removePayment({
      paymentId: payments[0].id,
      staffId: null,
      reason: "matched to the wrong order",
    });

    assert.equal(summary.received, 0);
    assert.equal(summary.shortfall, 2500000);
    assert.equal((await paymentsFor(order.id)).length, 0);

    const row = await orderRow(order.id);
    assert.equal(row.paymentStatus, "Unpaid");
    assert.equal(money(row.amountPaid), 0);
    assert.equal(row.paymentConfirmedAt, null, "the confirmation date goes with the last payment");

    // The line is free, so it can be recorded against the order it belongs to.
    const [freed] = await db.select().from(bankStatementLines).where(eq(bankStatementLines.id, line.id));
    assert.equal(freed.status, "UNMATCHED");
    assert.equal(freed.matchedOrderId, null);

    const rightOrder = await makeOrder(2500000);
    const again = await confirm(rightOrder, [line.id]);
    assert.equal(again.summary.received, 2500000);
  });

  test("unmatched then re-matched funds the order once, not twice", async () => {
    /**
     * Order 11562 in production. Three statement lines were matched to it,
     * unmatched, then re-matched — and confirming it afterwards wrote SIX
     * allocation rows: the three real credits and three reversed husks, which
     * still matched because unmatching cleared a credit's reference but left
     * `paystack_details->>'orderId'` pointing at the order. Both trios carried
     * their face value, so the report showed ₦48.2m against a ₦24.1m order and
     * called the difference an overpayment — out of one payment, made once.
     *
     * It cannot recur: removing a payment deletes the row rather than leaving a
     * reversed husk behind, and a statement line is uniquely indexed to one
     * order. This pins that shut.
     */
    const a = await makeLine(8000000, "TRANCHE A");
    const b = await makeLine(8000000, "TRANCHE B");
    const c = await makeLine(8100000, "TRANCHE C");
    const order = await makeOrder(24100000);

    const first = await confirm(order, [a.id, b.id, c.id]);
    assert.equal(first.summary.received, 24100000);

    for (const payment of first.payments) {
      await orderPaymentService.removePayment({
        paymentId: payment.id,
        staffId: null,
        reason: "unmatching to re-match cleanly",
      });
    }
    assert.equal((await paymentsFor(order.id)).length, 0, "nothing is left behind to match again");

    const again = await confirm(order, [a.id, b.id, c.id]);
    assert.equal((await paymentsFor(order.id)).length, 3, "three lines, three rows — not six");
    assert.equal(again.summary.received, 24100000);
    assert.equal(again.summary.surplus, 0, "no overpayment is invented out of one payment");

    const row = await orderRow(order.id);
    assert.equal(row.paymentStatus, "Paid");
    assert.equal(money(row.amountPaid), 24100000);
  });

  test("a transfer leg cannot be removed on its own", async () => {
    const line = await makeLine(8000000, "TRANSFER SOURCE");
    const from = await makeOrder(5000000);
    const to = await makeOrder(5000000);
    await confirm(from, [line.id]);
    await orderPaymentService.transferSurplus({
      fromOrderId: from.id,
      toOrderId: to.id,
      amount: 3000000,
      reason: "part of the next order",
      staffId: null,
    });

    const leg = (await paymentsFor(to.id)).find((r) => r.source === "transfer_in");
    await assert.rejects(
      () => orderPaymentService.removePayment({ paymentId: leg.id, staffId: null, reason: "no" }),
      /Reverse the transfer instead/i,
      "the two legs must never come apart",
    );
  });

  test("Amount Paid stays the bank figure after a transfer; Balance absorbs it", async () => {
    /**
     * The rule the finance desk asked for: what the report calls Amount Paid
     * must be what the bank statement says, whatever happened afterwards.
     *
     * It used to be netted — an order that received a line and later moved
     * part of it away displayed the remainder, a figure printed on no
     * statement anywhere. The transfer is a separate, later event and belongs
     * in its own column, with Balance holding the two together.
     */
    const { orderRepo } = require("../repositories");
    const line = await makeLine(12000000, "BANK FIGURE PAYER");
    const from = await makeOrder(9000000);
    const to = await makeOrder(3000000);
    await confirm(from, [line.id]);
    await orderPaymentService.transferSurplus({
      fromOrderId: from.id,
      toOrderId: to.id,
      amount: 3000000,
      reason: "the rest was for the next load",
      staffId: null,
    });

    const report = await orderRepo.findFinanceReport({ paymentStatus: "all" });
    const src = report.orders.find((r) => r.id === from.id);
    const dst = report.orders.find((r) => r.id === to.id);

    // Source: the statement line at face value, untouched by the transfer.
    assert.equal(src.amountPaidIn, 12000000, "the bank line, not what was left of it");
    assert.equal(src.differential, 9000000 - 12000000, "against the bank, before the transfer");
    assert.equal(src.netTransfers, -3000000);
    assert.equal(src.balance, 0, "bank figure and transfer together settle it");

    // Destination: no bank money of its own, and it says so.
    assert.equal(dst.amountPaidIn, 0, "no statement line was matched to this order");
    assert.equal(dst.differential, 3000000, "short against the bank, which is true");
    assert.equal(dst.netTransfers, 3000000);
    assert.equal(dst.balance, 0);

    // And the three identities hold on both rows.
    for (const r of [src, dst]) {
      assert.equal(Number(r.totalAmount) - r.amountPaidIn, r.differential);
      assert.equal(r.differential - r.netTransfers, r.balance);
    }
  });

  test("the report dates an order by when it was PLACED, not when it was confirmed", async () => {
    /**
     * The finance report and the sales report have to be layable side by side.
     * salesSummary filters on orders.createdAt; this used to filter on
     * payment_confirmed_at, so an order placed in August and confirmed in
     * September counted towards August's sales and September's finance —
     * same order, same money, two different months.
     *
     * It contradicted itself too: the Date column always showed createdAt, so
     * an order could print "24 Aug" and only be findable by filtering to the
     * day somebody happened to confirm it.
     */
    const { orderRepo } = require("../repositories");
    const placedOn = new Date("2026-08-24T12:00:00.000Z");

    const line = await makeLine(4200000, "BACKDATED PAYER");
    const order = await makeOrder(4200000);
    await db.update(orders).set({ createdAt: placedOn }).where(eq(orders.id, order.id));
    // Confirmed now — days after it was placed, which is the whole point.
    await confirm(order, [line.id]);

    const onPlacedDate = await orderRepo.findFinanceReport({
      dateFrom: "2026-08-24",
      dateTo: "2026-08-24",
    });
    assert.ok(
      onPlacedDate.orders.some((r) => r.id === order.id),
      "an order placed on 24 August belongs in the 24 August report",
    );

    // And it must NOT also show up on the day it was confirmed.
    const today = new Date().toISOString().slice(0, 10);
    if (today !== "2026-08-24") {
      const onConfirmDate = await orderRepo.findFinanceReport({
        dateFrom: today,
        dateTo: today,
      });
      assert.ok(
        !onConfirmDate.orders.some((r) => r.id === order.id),
        "and not in the report for the day it was confirmed",
      );
    }

    // The confirmation date is not lost — it is still on the row, and each
    // payment still carries the bank's own value date.
    const row = onPlacedDate.orders.find((r) => r.id === order.id);
    assert.ok(row.paymentConfirmedAt, "when finance confirmed it is still recorded");
    assert.ok(row.payments[0].txnDate, "and the bank's value date is untouched");
  });

  test("every order's amount_paid equals the sum of its payment rows", async () => {
    // The invariant the finance report and every order screen both rely on.
    const rows = await db.execute(`
      SELECT o.id, o.amount_paid::numeric AS cached,
             COALESCE((SELECT SUM(p.amount) FROM order_payments p WHERE p.order_id = o.id), 0) AS summed
      FROM orders o
      WHERE o.customer_id = ${customer.id}
    `);
    for (const r of rows.rows ?? rows) {
      assert.equal(
        money(r.cached),
        money(r.summed),
        `order ${r.id}: amount_paid drifted from its payment rows`,
      );
    }
  });
});
