// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { eq, inArray, like } = require("drizzle-orm");

const { db } = require("../config/db");
const {
  customers,
  depots,
  products,
  orders,
  bankAccounts,
  bankStatements,
  bankStatementLines,
  orderPayments,
  commissions,
  orderTrucks,
  tickets,
  auditLogs,
} = require("../db/schema");
const orderService = require("../services/order.service");
const { closeDb } = require("./helpers");

/**
 * Correcting the money on an order after it has been delivered.
 *
 * Two guards used to make an order's payment record permanent the moment it
 * read as paid, and both fired on real work the desk was trying to do:
 *
 *   * "Order is already paid" — refused on `paymentStatus`, which is derived
 *     from `amount_paid`, a cached figure the 0021 backfill left OVERSTATING
 *     the payment rows on 36 orders by ₦1.11bn in total. VG11105 is carried as
 *     Paid on ₦139,896,000 with only ₦114,570,000 of rows behind it, and this
 *     guard blocked the desk from attaching the lines that would close the gap.
 *
 *   * "Cannot pay an order in Completed status" — money does not stop arriving
 *     when the last truck leaves, and an order whose lines were unmatched after
 *     delivery (they had been matched to the wrong order) could never be given
 *     the right ones.
 *
 * Underneath the second was a third failure, reachable only once the status
 * guard was lifted: an unmatched-after-delivery order has `amount_paid` back at
 * 0, so it looks like a first payment, and the first payment tries to move the
 * status to Paid — which is illegal from Completed and threw
 * "An order cannot move from Completed to Paid".
 *
 * What must NOT change: a cancelled or lapsed order still refuses money.
 */
describe("recording payment after delivery", () => {
  const suffix = Date.now().toString(36);
  const PRICE = 1000;
  const QUANTITY = 10000;
  const TOTAL = PRICE * QUANTITY; // ₦10,000,000

  let customer;
  let depot;
  let product;
  let bankAccount;
  let statement;
  let orderSeq = 0;
  let lineSeq = 0;

  const actor = { type: "system" };

  const makeOrder = async (over = {}) => {
    orderSeq += 1;
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `ORD-AFTERDEL-${suffix}-${orderSeq}`,
        customerId: customer.id,
        state: "Lagos",
        depotId: depot.id,
        productId: product.id,
        quantity: QUANTITY,
        price: String(PRICE),
        totalAmount: String(TOTAL),
        deliveryType: "pickup",
        ...over,
      })
      .returning();
    return order;
  };

  const makeLine = async (amount) => {
    lineSeq += 1;
    const key = `${suffix}-${lineSeq}`;
    const [line] = await db
      .insert(bankStatementLines)
      .values({
        statementId: statement.id,
        bankAccountId: bankAccount.id,
        // A `date` column, bound as a string — postgres.js refuses a Date here.
        txnDate: "2026-09-01",
        amount: String(amount),
        depositor: "AFTER DELIVERY FIXTURE",
        narration: `NIP/AFTER DELIVERY FIXTURE/${key}`,
        bankRef: `ADREF-${key}`,
        dedupKey: `ADDEDUP-${key}`,
        status: "UNMATCHED",
      })
      .returning();
    return line;
  };

  const pay = async (order, amount) => {
    const line = await makeLine(amount);
    return orderService.confirmOrderPayment({
      orderId: order.id,
      bankAccountId: bankAccount.id,
      lineIds: [line.id],
      actor,
      notifyWhatsApp: false,
    });
  };

  const reload = async (id) => {
    const [row] = await db.select().from(orders).where(eq(orders.id, id));
    return row;
  };

  before(async () => {
    [customer] = await db
      .insert(customers)
      .values({
        name: "After Delivery Test",
        phone: `+23481${String(Date.now()).slice(-8)}`,
        balance: "0",
      })
      .returning();

    [depot] = await db
      .insert(depots)
      .values({
        name: `After Del Depot ${suffix}`,
        code: `ADD-${suffix}`,
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
      .values({ name: `After Del Product ${suffix}`, sku: `ADP-${suffix}`, category: "PMS" })
      .returning();

    [bankAccount] = await db
      .insert(bankAccounts)
      .values({
        bankName: "Zenith Bank",
        accountName: "SOROMAN AFTER DELIVERY TEST",
        accountNumber: `13888${String(Date.now()).slice(-5)}`,
        status: "Active",
      })
      .returning();

    [statement] = await db
      .insert(bankStatements)
      .values({ bankAccountId: bankAccount.id, filename: `afterdel-${suffix}.csv` })
      .returning();
  });

  after(async () => {
    const mine = await db
      .select({ id: orders.id })
      .from(orders)
      .where(like(orders.orderNumber, `ORD-AFTERDEL-${suffix}-%`));
    const ids = mine.map((o) => o.id);
    if (ids.length) {
      // Confirming a payment runs runPostPaymentEffects, which writes tickets
      // and commission rows — both carry a foreign key back to the order, so
      // they have to go first.
      await db.delete(orderPayments).where(inArray(orderPayments.orderId, ids));
      await db.delete(tickets).where(inArray(tickets.orderId, ids));
      await db.delete(orderTrucks).where(inArray(orderTrucks.orderId, ids));
      await db.delete(commissions).where(inArray(commissions.orderId, ids));
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, ids));
      await db.delete(orders).where(inArray(orders.id, ids));
    }
    await db.delete(bankStatementLines).where(eq(bankStatementLines.statementId, statement.id));
    await db.delete(bankStatements).where(eq(bankStatements.id, statement.id));
    await db.delete(bankAccounts).where(eq(bankAccounts.id, bankAccount.id));
    await db.delete(products).where(eq(products.id, product.id));
    await db.delete(depots).where(eq(depots.id, depot.id));
    await db.delete(customers).where(eq(customers.id, customer.id));
    await closeDb();
  });

  test("a fully paid order still accepts another line, and holds it as surplus", async () => {
    const order = await makeOrder();
    await pay(order, TOTAL);
    assert.equal((await reload(order.id)).paymentStatus, "Paid");

    // The correction: another line the desk has in hand for this order.
    await pay(order, 250000);

    const rows = await db.select().from(orderPayments).where(eq(orderPayments.orderId, order.id));
    assert.equal(rows.length, 2, "the second line should have been recorded");

    const after = await reload(order.id);
    assert.equal(Number(after.amountPaid), TOTAL + 250000);
    assert.equal(after.paymentStatus, "Paid");
  });

  test("a delivered order takes its first payment without moving status", async () => {
    // The shape an order lands in after its lines are unmatched post-delivery:
    // gone through to Completed, but amountPaid back at zero.
    const order = await makeOrder({ status: "Completed", paymentStatus: "Unpaid" });

    await pay(order, TOTAL);

    const after = await reload(order.id);
    assert.equal(Number(after.amountPaid), TOTAL, "the payment must be recorded");
    assert.equal(after.paymentStatus, "Paid");
    // Delivery already happened; recording the money must not rewind or
    // advance the fulfilment status.
    assert.equal(after.status, "Completed");
  });

  test("a delivered order that already reads paid accepts a correcting line", async () => {
    // VG11105's shape: delivered, carried as Paid, and short of evidence.
    const order = await makeOrder({ status: "Completed" });
    await pay(order, TOTAL - 1000000);
    await db
      .update(orders)
      // The cached overstatement the 0021 backfill left behind.
      .set({ amountPaid: String(TOTAL), paymentStatus: "Paid" })
      .where(eq(orders.id, order.id));

    await pay(order, 1000000);

    const rows = await db.select().from(orderPayments).where(eq(orderPayments.orderId, order.id));
    assert.equal(rows.length, 2);
    // recomputeOrder rebuilds amountPaid from the rows, so the phantom figure
    // is replaced by one every row can account for.
    const after = await reload(order.id);
    assert.equal(Number(after.amountPaid), TOTAL);
    assert.equal(after.paymentStatus, "Paid");
    assert.equal(after.status, "Completed");
  });

  test("a cancelled order still refuses money", async () => {
    const order = await makeOrder({ status: "Cancelled" });
    await assert.rejects(
      () => pay(order, TOTAL),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /Cannot pay an order in Cancelled status/);
        return true;
      }
    );
  });

  test("an expired order still refuses money", async () => {
    const order = await makeOrder({ status: "Expired" });
    await assert.rejects(
      () => pay(order, TOTAL),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /expired/i);
        return true;
      }
    );
  });
});
