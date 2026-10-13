// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const {
  pfis, depots, products, depotProductPrices, bankAccounts, bankStatements, bankStatementLines,
} = require("../db/schema");
const { customerRepo } = require("../repositories");
const orderService = require("../services/order.service");
const { closeDb, staffToken } = require("./helpers");

/**
 * A customer's money on their profile, live from their orders' payments
 * (GET /api/customers/:id/payments).
 *
 * The profile read the wallet, which order-first payments stopped writing to
 * on 1 Sep 2026. What has to hold: a bank line matched to one of the
 * customer's orders shows at once, newest first, with its order and bank
 * reference; and the figures — ordered, received, from the bank, still to
 * pay, surplus — come from the orders themselves.
 */
const RUN = Date.now();
const PRICE = 900;

let admin;
let depot;
let product;
let pfi;
let account;
let customer;
const orderIds = [];

const place = (quantity) =>
  orderService.placeOrder({
    customerId: customer.id,
    state: "Cross River",
    depotId: depot.id,
    productId: product.id,
    quantity,
    deliveryType: "pickup",
    actor: { type: "system" },
    quiet: true,
  }).then(({ order }) => {
    orderIds.push(Number(order.id));
    return order;
  });

const pay = async (id, amount, ref) => {
  const [statement] = await db.insert(bankStatements)
    .values({ bankAccountId: account.id, filename: `custpay-${RUN}-${id}.csv` }).returning();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const [line] = await db.insert(bankStatementLines).values({
    statementId: statement.id, bankAccountId: account.id, txnDate: day, amount: amount.toFixed(2),
    depositor: "CUSTOMER PAYMENTS TEST", narration: `order ${id}`, bankRef: ref,
    dedupKey: ref, status: "UNMATCHED",
  }).returning();
  return orderService.confirmOrderPayment({
    orderId: id, bankAccountId: account.id, lineIds: [line.id],
    actor: { type: "system" }, notifyWhatsApp: false,
  });
};

const money = async () => {
  const res = await request(app)
    .get(`/api/customers/${customer.id}/payments`)
    .set("Authorization", `Bearer ${admin}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

describe("A customer's payments, live", () => {
  before(async () => {
    admin = await staffToken(request, app);
    [depot] = await db.insert(depots).values({
      name: `Customer Payments Depot ${RUN}`, code: `CP${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS ${RUN}`, sku: `CPY${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    await db.insert(depotProductPrices).values({ depotId: depot.id, productId: product.id, currentPrice: String(PRICE) });
    [pfi] = await db.insert(pfis).values({
      pfiNumber: `PFI/CPY/${RUN}`, status: "active", locationId: depot.id, locationName: depot.name,
      productId: product.id, productName: product.name, startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `CUSTOMER PAYMENTS TEST ${RUN}`, accountNumber: `6${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [pfi.id],
    }).returning();
    customer = await customerRepo.create({
      name: `Payments Buyer ${RUN}`, phone: `+234816${String(RUN).slice(-7)}`, companyName: `Payments Buyer ${RUN}`,
    });
  });

  after(async () => {
    try {
      if (orderIds.length) {
        await client`DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY(${orderIds})`.catch(() => {});
        await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds})`;
        await client`DELETE FROM pfi_movements WHERE order_id = ANY(${orderIds})`;
        await client`DELETE FROM order_pfi_allocations WHERE order_id = ANY(${orderIds})`;
        await client`DELETE FROM commissions WHERE order_id = ANY(${orderIds})`.catch(() => {});
        await client`DELETE FROM tickets WHERE order_id = ANY(${orderIds})`.catch(() => {});
        await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
      }
      await client`DELETE FROM bank_statement_lines WHERE bank_account_id = ${account.id}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${account.id}`;
      await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
      await client`DELETE FROM expense_categories WHERE pfi_id = ${pfi.id}`.catch(() => {});
      await db.delete(pfis).where(eq(pfis.id, pfi.id));
      await client`DELETE FROM depot_product_prices WHERE depot_id = ${depot.id}`;
      await db.delete(depots).where(eq(depots.id, depot.id));
      await db.delete(products).where(eq(products.id, product.id));
      await client`DELETE FROM customers WHERE id = ${customer.id}`.catch(() => {});
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  test("a customer with no payments reads nothing, not an error", async () => {
    const { summary, payments } = await money();
    assert.deepEqual(payments, []);
    assert.equal(summary.received, 0);
    assert.equal(summary.lastBankPayment, null);
  });

  test("a matched bank line shows at once, with its order, and the figures follow the orders", async () => {
    const paid = await place(1000);
    const over = await place(2000);
    const unpaid = await place(500);
    await pay(paid.id, 1000 * PRICE, `CPY-${RUN}-A`);
    await pay(over.id, 2000 * PRICE + 50000, `CPY-${RUN}-B`);

    const { summary, payments } = await money();
    assert.equal(payments.length, 2);
    assert.deepEqual(new Set(payments.map((p) => p.bankRef)), new Set([`CPY-${RUN}-A`, `CPY-${RUN}-B`]));
    for (const p of payments) {
      assert.equal(p.source, "statement");
      assert.ok(p.orderNumber.endsWith(String(p.orderId)), p.orderNumber);
      assert.ok(p.date, "every payment carries the day the money moved");
      assert.equal(p.accountNumber, account.accountNumber);
    }

    assert.equal(summary.orders, 3);
    assert.equal(summary.ordered, 3500 * PRICE);
    assert.equal(summary.received, 3000 * PRICE + 50000);
    assert.equal(summary.fromBank, summary.received);
    assert.equal(summary.toPay, 500 * PRICE, "only the unpaid order is still to pay");
    assert.equal(summary.surplus, 50000);
    assert.ok(summary.lastBankPayment);
    assert.ok(unpaid.id);
  });
});
