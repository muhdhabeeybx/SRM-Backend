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
const { chargedFee, productValue } = require("../lib/orderDelivery");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Delivery money found in a paid order's surplus (migration 0080).
 *
 * What has to hold: finance or an admin records part of a delivery order's
 * surplus as delivery, never more than the surplus and never on a pickup
 * order; the order's total and delivery charge take it in, so the surplus
 * shrinks everywhere while the product value (PFI sales) does not move; the
 * Finance Report's row keeps the figures it printed before and lists the
 * entry in its own block; a recompute from the rate keeps it; and taking it
 * back puts everything as it was.
 */
const RUN = Date.now();
const PRICE = 900;

let admin;
let finance;
let ticketing;
let depot;
let product;
let pfi;
let account;
let customer;
const orderIds = [];

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${t}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${t}`).send(body),
});

const place = (opts = {}) =>
  orderService.placeOrder({
    customerId: customer.id,
    state: "Cross River",
    depotId: depot.id,
    productId: product.id,
    quantity: 1000,
    deliveryType: "delivery",
    deliveryAddress: "12 Marian Road, Calabar",
    actor: { type: "staff", staffId: finance.id },
    quiet: true,
    ...opts,
  }).then(({ order }) => {
    orderIds.push(Number(order.id));
    return order;
  });

const row = async (id) => (await client`
  SELECT quantity, price, total_amount, delivery_rate, delivery_fee, delivery_from_surplus, payment_status, amount_paid
    FROM orders WHERE id = ${id}`)[0];

const pay = async (id, extra = 0) => {
  const [o] = await client`SELECT total_amount FROM orders WHERE id = ${id}`;
  const [statement] = await db.insert(bankStatements)
    .values({ bankAccountId: account.id, filename: `surplusdl-${RUN}-${id}.csv` }).returning();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const [line] = await db.insert(bankStatementLines).values({
    statementId: statement.id, bankAccountId: account.id, txnDate: day, amount: (Number(o.total_amount) + extra).toFixed(2),
    depositor: "DELIVERY TEST", narration: `order ${id}`, bankRef: `SDL-${RUN}-${id}`,
    dedupKey: `SDL-${RUN}-${id}`, status: "UNMATCHED",
  }).returning();
  return orderService.confirmOrderPayment({
    orderId: id, bankAccountId: account.id, lineIds: [line.id],
    actor: { type: "staff", staffId: finance.id }, notifyWhatsApp: false,
  });
};

describe("Surplus recorded as delivery", () => {
  before(async () => {
    admin = await staffToken(request, app);
    const f = await staffTokenWithRoles(["finance"], `surplusdl-fin-${RUN}@soroman.test`);
    finance = { id: Number(f.staff.id), token: f.accessToken };
    const t = await staffTokenWithRoles(["ticketing"], `surplusdl-tkt-${RUN}@soroman.test`);
    ticketing = { id: Number(t.staff.id), token: t.accessToken };

    [depot] = await db.insert(depots).values({
      name: `Surplus Delivery Depot ${RUN}`, code: `SD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `AGO ${RUN}`, sku: `SDL${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    await db.insert(depotProductPrices).values({ depotId: depot.id, productId: product.id, currentPrice: String(PRICE) });
    [pfi] = await db.insert(pfis).values({
      pfiNumber: `PFI/SDL/${RUN}`, status: "active", locationId: depot.id, locationName: depot.name,
      productId: product.id, productName: product.name, startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `SURPLUS DELIVERY TEST ${RUN}`, accountNumber: `7${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [pfi.id],
    }).returning();
    customer = await customerRepo.create({
      name: `Surplus Buyer ${RUN}`, phone: `+234815${String(RUN).slice(-7)}`, companyName: `Surplus Buyer ${RUN}`,
    });
  });

  after(async () => {
    try {
      if (orderIds.length) {
        await client`DELETE FROM order_surplus_deliveries WHERE order_id = ANY(${orderIds})`;
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
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  test("only finance or an admin, only a delivery order, never more than the surplus", async () => {
    const o = await place({ quantity: 1000 });
    await pay(o.id, 50000);
    const url = `/api/orders/${o.id}/delivery-from-surplus`;
    assert.equal((await as(ticketing.token).post(url, { amount: 1000 })).status, 403);
    assert.equal((await as(finance.token).post(url, { amount: 60000 })).status, 400, "more than the surplus");
    assert.equal((await as(finance.token).post(url, { amount: 0 })).status, 400);

    const pickup = await place({ quantity: 1100, deliveryType: "pickup" });
    await pay(pickup.id, 20000);
    assert.equal((await as(finance.token).post(`/api/orders/${pickup.id}/delivery-from-surplus`, { amount: 1000 })).status, 400);
  });

  test("it joins the total and the charge; the surplus shrinks, the product value does not", async () => {
    const o = await place({ quantity: 1300 });
    await pay(o.id, 40000);
    const before = await row(o.id);
    const productBefore = Number(before.total_amount);

    const res = await as(finance.token).post(`/api/orders/${o.id}/delivery-from-surplus`, { amount: 30000, note: "Trip to Calabar" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const r = await row(o.id);
    assert.equal(Number(r.delivery_fee), 30000);
    assert.equal(Number(r.delivery_from_surplus), 30000);
    assert.equal(Number(r.total_amount), productBefore + 30000);
    assert.equal(Number(r.amount_paid) - Number(r.total_amount), 10000, "surplus left");
    assert.equal(r.payment_status, "Paid");
    assert.equal(productValue({ totalAmount: r.total_amount, deliveryFee: r.delivery_fee }), productBefore);

    const [audit] = await client`
      SELECT metadata FROM audit_logs WHERE entity_type = 'order' AND entity_id = ${Number(o.id)}
         AND action = 'order.delivery_from_surplus'`;
    assert.equal(audit.metadata.amount, 30000);
  });

  test("the Finance Report keeps its row as printed and lists the entry on its own", async () => {
    const res = await as(admin).get(`/api/finance-report?pfiId=${pfi.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entry = res.body.data.surplusDeliveries.find((e) => e.amount === 30000);
    assert.ok(entry, "listed in its own block");
    assert.equal(entry.note, "Trip to Calabar");
    const orderRow = res.body.data.orders.find((o) => Number(o.id) === Number(entry.orderId));
    assert.equal(Number(orderRow.totalAmount), 1300 * PRICE, "the row's value is the product, as before");
    assert.equal(Number(orderRow.deliveryFee), 0);
    assert.equal(Number(orderRow.differential), 1300 * PRICE - (1300 * PRICE + 40000));

    const mine = res.body.data.customerDifferentials.find((c) => Number(c.customerId) === Number(customer.id));
    assert.equal(mine.deliveryFromSurplus, 30000);
  });

  test("a recompute from the rate keeps it", () => {
    assert.equal(chargedFee({ deliveryFromSurplus: "30000.00" }, 10, 1000), 40000);
    assert.equal(chargedFee({}, 10, 1000), 10000);
  });

  test("taken back, everything is as it was", async () => {
    const [entry] = await client`
      SELECT e.id, e.order_id FROM order_surplus_deliveries e
       WHERE e.order_id = ANY(${orderIds}) AND e.voided_at IS NULL LIMIT 1`;
    const before = await row(entry.order_id);
    const res = await as(finance.token).post(`/api/orders/${entry.order_id}/delivery-from-surplus/${entry.id}/void`, { reason: "wrong order" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = await row(entry.order_id);
    assert.equal(Number(r.delivery_fee), 0);
    assert.equal(Number(r.delivery_from_surplus), 0);
    assert.equal(Number(r.total_amount), Number(before.total_amount) - 30000);
    const again = await as(finance.token).post(`/api/orders/${entry.order_id}/delivery-from-surplus/${entry.id}/void`, {});
    assert.equal(again.status, 404);
  });
});
