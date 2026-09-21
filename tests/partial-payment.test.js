// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { eq, inArray } = require("drizzle-orm");

const { db } = require("../config/db");
const {
  customers,
  depots,
  products,
  orders,
  walletHolds,
  deposits,
  orderDepositAllocations,
  commissions,
  orderTrucks,
  tickets,
  auditLogs,
  bankAccounts,
  bankStatements,
  bankStatementLines,
  orderPayments,
} = require("../db/schema");
const orderService = require("../services/order.service");
const orderPaymentService = require("../services/orderPayment.service");
const { closeDb } = require("./helpers");

/**
 * Paying for part of an order.
 *
 * The desk's case: 100,000 litres ordered, the customer pays for 50,000 now.
 * That payment has to be confirmable, the order has to become ticketable for
 * 50,000 litres and no more, the balance has to read as still expected, and
 * paying the rest later has to unlock the remainder — with the money never
 * once double-counted along the way.
 */
describe("part payment", () => {
  const suffix = Date.now().toString(36);
  const PRICE = 241; //  ₦/litre
  const QUANTITY = 100000; //  litres
  const TOTAL = PRICE * QUANTITY; //  ₦24,100,000
  const HALF = TOTAL / 2; //  ₦12,050,000 — exactly 50,000 litres

  let customer;
  let depot;
  let product;
  let bankAccount;
  let statement;
  let orderSeq = 0;

  const makeOrder = async (quantity = QUANTITY) => {
    orderSeq += 1;
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `ORD-PARTPAY-${suffix}-${orderSeq}`,
        customerId: customer.id,
        state: "Lagos",
        depotId: depot.id,
        productId: product.id,
        quantity,
        price: String(PRICE),
        totalAmount: String(PRICE * quantity),
        deliveryType: "pickup",
      })
      .returning();
    return order;
  };

  /**
   * Pay `amount` against the order, the only way an order can now be paid: an
   * unmatched bank statement line for exactly that figure, recorded on it.
   *
   * This replaced a `fund(amount)` helper that credited the customer's wallet
   * and let payOrder draw the order's total back out of it. The distinction
   * matters to what these tests can still prove — under the old helper an
   * order could be marked paid with no bank row anywhere behind it, which is
   * the state the finance desk could not audit.
   */
  let lineSeq = 0;
  const pay = async (order, amount) => {
    lineSeq += 1;
    const key = `${suffix}-${lineSeq}`;
    const [line] = await db
      .insert(bankStatementLines)
      .values({
        statementId: statement.id,
        bankAccountId: bankAccount.id,
        // A `date` column, bound as a string — postgres.js refuses a Date here.
        txnDate: "2026-08-20",
        amount: String(amount),
        depositor: "PART PAY FIXTURE",
        narration: `NIP/PART PAY FIXTURE/${key}`,
        bankRef: `PPREF-${key}`,
        dedupKey: `PPDEDUP-${key}`,
        status: "UNMATCHED",
      })
      .returning();

    return orderService.confirmOrderPayment({
      orderId: order.id,
      bankAccountId: bankAccount.id,
      lineIds: [line.id],
      actor: staffActor,
      notifyWhatsApp: false,
    });
  };

  const paymentsFor = (orderId) =>
    db
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.orderId, orderId))
      .orderBy(orderPayments.id);

  const reload = async (id) => {
    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    return row;
  };

  // A system actor rather than a staff one: the audit log requires a real
  // staffId for a staff actor, and who pressed the button is not what any of
  // these tests are about.
  const staffActor = { type: "system" };

  before(async () => {
    [customer] = await db
      .insert(customers)
      .values({
        name: "Part Payment Test",
        phone: `+23482${String(Date.now()).slice(-8)}`,
        balance: "0",
      })
      .returning();

    [depot] = await db
      .insert(depots)
      .values({
        name: `Part Pay Depot ${suffix}`,
        code: `PPD-${suffix}`,
        address: "1 Test Road",
        city: "Lagos",
        state: "Lagos",
        country: "Nigeria",
        postcode: "100001",
        maxCapacity: 10000000,
        establishedYear: "2020",
      })
      .returning();

    [product] = await db
      .insert(products)
      .values({
        name: `Part Pay Product ${suffix}`,
        sku: `PPP-${suffix}`,
        category: "PMS",
      })
      .returning();

    [bankAccount] = await db
      .insert(bankAccounts)
      .values({
        bankName: "Zenith Bank",
        accountName: "SOROMAN PART PAY TEST",
        accountNumber: `13777${String(Date.now()).slice(-5)}`,
        status: "Active",
      })
      .returning();

    [statement] = await db
      .insert(bankStatements)
      .values({ bankAccountId: bankAccount.id, filename: `partpay-${suffix}.csv` })
      .returning();
  });

  after(async () => {
    const orderIds = (
      await db.select({ id: orders.id }).from(orders).where(eq(orders.customerId, customer.id))
    ).map((r) => r.id);
    if (orderIds.length) {
      await db.delete(orderPayments).where(inArray(orderPayments.orderId, orderIds));
      await db.delete(orderDepositAllocations).where(inArray(orderDepositAllocations.orderId, orderIds));
      await db.delete(tickets).where(inArray(tickets.orderId, orderIds));
      await db.delete(orderTrucks).where(inArray(orderTrucks.orderId, orderIds));
      await db.delete(commissions).where(inArray(commissions.orderId, orderIds));
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, orderIds));
    }
    await db.delete(walletHolds).where(eq(walletHolds.customerId, customer.id));
    await db.delete(deposits).where(eq(deposits.customerId, customer.id));
    await db.delete(orders).where(eq(orders.customerId, customer.id));
    await db.delete(customers).where(eq(customers.id, customer.id));
    await db.delete(bankStatementLines).where(eq(bankStatementLines.statementId, statement.id));
    await db.delete(bankStatements).where(eq(bankStatements.id, statement.id));
    await db.delete(bankAccounts).where(eq(bankAccounts.id, bankAccount.id));
    await db.delete(products).where(eq(products.id, product.id));
    await db.delete(depots).where(eq(depots.id, depot.id));
    await closeDb();
  });

  // ── The releasable-quantity rule, in isolation ──────────────────────────

  test("releasable quantity is what the money paid actually covers", () => {
    const order = { quantity: QUANTITY, price: String(PRICE), totalAmount: String(TOTAL) };

    assert.equal(orderService.releasableQuantity({ ...order, amountPaid: "0" }), 0);
    assert.equal(orderService.releasableQuantity({ ...order, amountPaid: String(HALF) }), 50000);
    assert.equal(orderService.releasableQuantity({ ...order, amountPaid: String(TOTAL) }), QUANTITY);
  });

  test("a fully-paid order releases its whole quantity, never a hair less", () => {
    // A total that does not divide cleanly by the price: the division lands
    // fractionally under the ordered quantity, and returning that would leave
    // the last few litres of a PAID order permanently unticketable.
    const awkward = {
      quantity: 33333,
      price: "241.37",
      totalAmount: "8046000.00", // deliberately not 33333 × 241.37
      amountPaid: "8046000.00",
    };
    assert.equal(orderService.releasableQuantity(awkward), 33333);
  });

  test("an order marked Paid releases in full even if amount_paid was never set", () => {
    // The regression this exists for: releasableQuantity originally read only
    // the arithmetic, so any writer that marks an order Paid WITHOUT also
    // setting amount_paid produced a ceiling of zero — a fully-paid order that
    // could not be ticketed at all. The settlement sweep in payment.service.js
    // was exactly that writer, and it would have bricked the ticketing desk for
    // every order it settled.
    const order = {
      quantity: QUANTITY,
      price: String(PRICE),
      totalAmount: String(TOTAL),
      amountPaid: "0",
      paymentStatus: "Paid",
    };
    assert.equal(orderService.releasableQuantity(order), QUANTITY);
  });

  test("part-paid litres are floored, never rounded up", () => {
    // ₦12,000,000 at ₦241/litre is 49,792.531... litres. Rounding up would
    // authorise a litre nobody paid for.
    const order = {
      quantity: QUANTITY,
      price: String(PRICE),
      totalAmount: String(TOTAL),
      amountPaid: "12000000",
    };
    assert.equal(orderService.releasableQuantity(order), 49792.53);
  });

  // ── The payment flow ────────────────────────────────────────────────────

  test("paying half marks the order Part Paid and records only that half", async () => {
    const order = await makeOrder();

    const paid = await pay(order, HALF);

    assert.equal(paid.paymentStatus, "Part Paid");
    assert.equal(Number(paid.amountPaid), HALF);

    const row = await reload(order.id);
    assert.equal(row.paymentStatus, "Part Paid");
    assert.equal(Number(row.amountPaid), HALF);
    // The pipeline opens on the first instalment, exactly as a full payment
    // does — otherwise the order could never reach the ticketing desk.
    assert.equal(row.status, "Released");
    assert.ok(row.paymentConfirmedAt, "payment confirmed timestamp is stamped");

    // One payment row, carrying the bank line that paid it.
    const rows = await paymentsFor(order.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "statement");
    assert.equal(Number(rows[0].amount), HALF);

    const summary = await orderPaymentService.summarizeOrder(order.id);
    assert.equal(summary.shortfall, TOTAL - HALF, "the balance is reported, not covered");
    assert.equal(summary.surplus, 0);

    assert.equal(orderService.releasableQuantity(row), 50000);
  });

  test("paying more than the order owes leaves the surplus ON the order", async () => {
    // The inversion. This used to be refused outright ("more than this order
    // still owes"), because the amount was a figure somebody typed and could
    // therefore be checked before the money moved. It is now the amount on a
    // bank statement line — money that has already arrived — so refusing it
    // would mean refusing to record a payment the bank has already taken.
    //
    // It lands on the order, in full, and shows as surplus. Moving it is an
    // explicit transfer to another order, which is the whole point.
    const order = await makeOrder();
    await pay(order, HALF);
    const after = await pay(order, HALF + 1000);

    assert.equal(after.paymentStatus, "Paid");
    assert.equal(Number(after.amountPaid), TOTAL + 1000);

    const summary = await orderPaymentService.summarizeOrder(order.id);
    assert.equal(summary.received, TOTAL + 1000);
    assert.equal(summary.applied, TOTAL, "the order's value is settled, and no more");
    assert.equal(summary.surplus, 1000, "the extra ₦1,000 sits here until somebody moves it");
  });

  test("paying the balance settles the order, as a second payment row", async () => {
    const order = await makeOrder();

    await pay(order, HALF);
    const settled = await pay(order, HALF);

    assert.equal(settled.paymentStatus, "Paid");

    const row = await reload(order.id);
    assert.equal(row.paymentStatus, "Paid");
    assert.equal(Number(row.amountPaid), TOTAL);
    assert.equal(orderService.releasableQuantity(row), QUANTITY);

    // Two instalments, two rows, each traceable to its own bank line. The old
    // model grew a single wallet hold instead, which is why an instalment left
    // nothing behind saying which transfer it was.
    const rows = await paymentsFor(order.id);
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((s, r) => s + Number(r.amount), 0), TOTAL);
    assert.equal(new Set(rows.map((r) => r.statementLineId)).size, 2, "two distinct bank lines");
  });

  /**
   * This used to assert the opposite — that a fully-paid order refuses further
   * payment with a 409.
   *
   * That guard read as a safeguard and worked as a trap. An order is "paid"
   * according to `amount_paid`, a cached figure the 0021 backfill left
   * overstating the payment rows on 36 orders by ₦1.11bn between them: every
   * one of those is carried as Paid on evidence that does not add up, and the
   * guard blocked the desk from attaching the very lines that would reconcile
   * it. It was also asymmetric — removePayment has never cared about an
   * order's status, so money could be taken off an order and never put back.
   *
   * The order is not harmed by the extra money: it lands as surplus, which the
   * response names and which can be transferred to the order it belongs to.
   * What still refuses payment is a cancelled or lapsed order — see
   * tests/payment-after-delivery.test.js.
   */
  test("a fully-paid order accepts a correcting line, and holds it as surplus", async () => {
    const order = await makeOrder();
    await pay(order, TOTAL);

    await pay(order, 1000);

    const rows = await paymentsFor(order.id);
    assert.equal(rows.length, 2, "the correcting line should be recorded");
    const row = await reload(order.id);
    assert.equal(Number(row.amountPaid), TOTAL + 1000);
    assert.equal(row.paymentStatus, "Paid");
  });

  test("one line covering the whole total settles the order outright", async () => {
    const order = await makeOrder();

    const paid = await pay(order, TOTAL);

    assert.equal(paid.paymentStatus, "Paid");
    const row = await reload(order.id);
    assert.equal(Number(row.amountPaid), TOTAL);
    assert.equal(row.status, "Released");
    assert.equal((await paymentsFor(order.id)).length, 1);
  });

  test("a second line for the remainder settles a part-paid order", async () => {
    const order = await makeOrder();
    await pay(order, HALF);

    await pay(order, HALF);

    const row = await reload(order.id);
    assert.equal(row.paymentStatus, "Paid");
    assert.equal(Number(row.amountPaid), TOTAL);
  });

  // ── Consequences ────────────────────────────────────────────────────────

  test("a part-paid order cannot lapse", async () => {
    const order = await makeOrder();
    await pay(order, HALF);

    const row = await reload(order.id);
    // Backdated well past any expiry window: an unfunded order this old would
    // lapse. This one has money against it and must not.
    const ancient = { ...row, status: "Pending", createdAt: new Date("2020-01-01") };
    assert.equal(
      orderService.isOrderExpired(ancient),
      false,
      "a Part Paid order has been funded and must never expire",
    );

    const stillUnpaid = { ...ancient, paymentStatus: "Unpaid" };
    assert.equal(orderService.isOrderExpired(stillUnpaid), true, "an Unpaid one still lapses");
  });

  test("commission is pro-rata, and grows as the balance is paid", async () => {
    const commissionService = require("../services/commission.service");
    const order = await makeOrder();

    await pay(order, HALF);
    await commissionService.createForOrder(order.id);

    const [half] = await db.select().from(commissions).where(eq(commissions.orderId, order.id));
    assert.ok(half, "a part payment creates a commission");
    assert.equal(Number(half.quantity), 50000, "commission is due on the litres paid for, not the order");

    await pay(order, HALF);
    await commissionService.createForOrder(order.id);

    const [full] = await db.select().from(commissions).where(eq(commissions.orderId, order.id));
    assert.equal(Number(full.quantity), QUANTITY, "settling the balance enlarges it to the whole order");

    const rows = await db.select().from(commissions).where(eq(commissions.orderId, order.id));
    assert.equal(rows.length, 1, "one commission row per order, re-snapshotted — not one per instalment");
  });

  test("the finance report shows sales value, what was received, and the gap", async () => {
    const { orderRepo } = require("../repositories");
    const order = await makeOrder();
    await pay(order, HALF);

    // Searched by the fixture's own unique order number, not by id. An id
    // search also runs an ILIKE '%<id>%' over every order number, so under the
    // full suite it pulls in unrelated orders and the totals below stop
    // describing this one — the assertions passed alone and failed in a full
    // run, which is the least useful way for a test to fail.
    const report = await orderRepo.findFinanceReport({ search: order.orderNumber });
    const row = report.orders.find((r) => r.id === order.id);

    assert.ok(row, "a part-paid order appears on the report by default, not only once fully paid");
    assert.equal(Number(row.totalAmount), TOTAL, "sales value");
    // Amount Paid is the bank statement's own figure, never netted by a
    // transfer made later — see amountPaidIn in order.repository.
    assert.equal(row.amountPaidIn, HALF, "the bank statement figure");
    assert.equal(row.differential, TOTAL - HALF, "against the bank, before any transfer");
    assert.equal(row.netTransfers, 0);
    assert.equal(row.balance, TOTAL - HALF, "nothing moved, so balance equals differential");
    assert.equal(row.received, HALF, "what actually arrived");
    assert.equal(row.applied, HALF);
    assert.equal(row.shortfall, TOTAL - HALF, "still expected");
    assert.equal(row.surplus, 0);
    assert.equal(row.reconciled, true, "a bank statement line stands behind it");

    // Every figure on the row comes off a payment row the reader can check.
    assert.equal(row.payments.length, 1);
    assert.equal(row.payments[0].source, "statement");
    assert.equal(row.payments[0].depositor, "PART PAY FIXTURE");
    assert.ok(row.payments[0].bankRef, "the teller reference is on the report");

    assert.equal(report.totals.totalAmountPaidIn, HALF, "the bank statement total");
    assert.equal(report.totals.totalDifferential, TOTAL - HALF);
    assert.equal(report.totals.totalNetTransfers, 0);
    assert.equal(report.totals.totalBalance, TOTAL - HALF);
    assert.equal(report.totals.totalReceived, HALF);
    assert.equal(report.totals.totalShortfall, TOTAL - HALF);
    assert.equal(report.totals.totalSurplus, 0);
    assert.equal(report.totals.partPaidCount, 1);
    assert.equal(report.totals.reconciledCount, 1);
    assert.equal(report.totals.unreconciledCount, 0);
  });

  test("the report can be filtered to only what an auditor can verify", async () => {
    const { orderRepo } = require("../repositories");

    // An order marked paid with no bank evidence at all — the shape all 5,741
    // pre-cutover orders have after migration 0021's backfill.
    const legacy = await makeOrder();
    await db
      .update(orders)
      .set({
        paymentStatus: "Paid",
        amountPaid: String(TOTAL),
        paymentConfirmedAt: new Date(),
      })
      .where(eq(orders.id, legacy.id));
    await db.insert(orderPayments).values({
      orderId: legacy.id,
      amount: String(TOTAL),
      source: "legacy",
      note: "no bank record",
    });

    const reconciled = await orderRepo.findFinanceReport({
      search: legacy.orderNumber,
      reconciliation: "reconciled",
    });
    assert.equal(reconciled.orders.length, 0, "no statement line, so it is not verifiable");

    const unreconciled = await orderRepo.findFinanceReport({
      search: legacy.orderNumber,
      reconciliation: "unreconciled",
    });
    const row = unreconciled.orders.find((r) => r.id === legacy.id);
    assert.ok(row, "and it is findable, as exactly that");
    assert.equal(row.reconciled, false);
    assert.equal(row.payments[0].bankRef, "", "no bank reference is invented for it");
    assert.equal(row.payments[0].depositor, "");
  });
});
