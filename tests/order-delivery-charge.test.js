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
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * A delivery order's delivery charge — the owner's rule of 13 Oct 2026
 * (migration 0078).
 *
 * What has to hold: the desk enters a rate per litre on a delivery order; the
 * charge is rate x litres and the order's total is the product plus the
 * charge, with the price per unit untouched; only staff can set it, and only
 * on a delivery order; finance or an admin can change it until a payment is
 * recorded, and a change of quantity carries the charge with it; payment is
 * settled against the whole total; and the PFI's revenue is the product
 * alone.
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
  SELECT quantity, price, total_amount, delivery_rate, delivery_fee, payment_status, amount_paid
    FROM orders WHERE id = ${id}`)[0];

const pay = async (id) => {
  const [o] = await client`SELECT total_amount FROM orders WHERE id = ${id}`;
  const [statement] = await db.insert(bankStatements)
    .values({ bankAccountId: account.id, filename: `delivery-${RUN}-${id}.csv` }).returning();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const [line] = await db.insert(bankStatementLines).values({
    statementId: statement.id, bankAccountId: account.id, txnDate: day, amount: String(o.total_amount),
    depositor: "DELIVERY TEST", narration: `order ${id}`, bankRef: `DL-${RUN}-${id}`,
    dedupKey: `DL-${RUN}-${id}`, status: "UNMATCHED",
  }).returning();
  return orderService.confirmOrderPayment({
    orderId: id, bankAccountId: account.id, lineIds: [line.id],
    actor: { type: "staff", staffId: finance.id }, notifyWhatsApp: false,
  });
};

describe("Delivery charge on an order", () => {
  before(async () => {
    admin = await staffToken(request, app);
    const f = await staffTokenWithRoles(["finance"], `delivery-fin-${RUN}@soroman.test`);
    finance = { id: Number(f.staff.id), token: f.accessToken };
    const t = await staffTokenWithRoles(["ticketing"], `delivery-tkt-${RUN}@soroman.test`);
    ticketing = { id: Number(t.staff.id), token: t.accessToken };

    [depot] = await db.insert(depots).values({
      name: `Delivery Depot ${RUN}`, code: `DD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `AGO ${RUN}`, sku: `DL${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    await db.insert(depotProductPrices).values({ depotId: depot.id, productId: product.id, currentPrice: String(PRICE) });
    [pfi] = await db.insert(pfis).values({
      pfiNumber: `PFI/DL/${RUN}`, status: "active", locationId: depot.id, locationName: depot.name,
      productId: product.id, productName: product.name, startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `DELIVERY TEST ${RUN}`, accountNumber: `8${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [pfi.id],
    }).returning();
    customer = await customerRepo.create({
      name: `Delivery Buyer ${RUN}`, phone: `+234814${String(RUN).slice(-7)}`, companyName: `Delivery Buyer ${RUN}`,
    });
  });

  after(async () => {
    try {
      if (orderIds.length) {
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

  test("the total is the product plus rate x litres; the price per unit is untouched", async () => {
    const o = await place({ deliveryRate: 12.5 });
    const r = await row(o.id);
    assert.equal(Number(r.price), PRICE);
    assert.equal(Number(r.delivery_rate), 12.5);
    assert.equal(Number(r.delivery_fee), 12500);
    assert.equal(Number(r.total_amount), 912500);
  });

  test("a pickup order, or a customer, cannot carry a delivery charge", async () => {
    await assert.rejects(place({ deliveryType: "pickup", deliveryRate: 10 }), (e) => e.status === 400);
    await assert.rejects(place({ deliveryRate: 10, actor: { type: "customer", customerId: customer.id } }), (e) => e.status === 403);
    const plain = await place({ deliveryType: "pickup" });
    assert.equal(Number((await row(plain.id)).delivery_fee), 0);
  });

  test("finance can change the rate before payment; anyone else cannot; quantity carries the charge", async () => {
    // Quantities differ test to test: an identical order placed moments after
    // another returns the first (the double-tap guard in placeOrder).
    const o = await place({ quantity: 1200, deliveryRate: 10 });
    const url = `/api/orders/${o.id}`;

    const refused = await as(ticketing.token).patch(url, { deliveryRate: 15 });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));

    const ok = await as(finance.token).patch(url, { deliveryRate: 15 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    let r = await row(o.id);
    assert.equal(Number(r.delivery_fee), 18000);
    assert.equal(Number(r.total_amount), 1098000);

    const more = await as(admin).patch(url, { quantity: 2000 });
    assert.equal(more.status, 200, JSON.stringify(more.body));
    r = await row(o.id);
    assert.equal(Number(r.delivery_fee), 30000);
    assert.equal(Number(r.total_amount), 1830000);

    // The order's own audit row names the change.
    const [audit] = await client`
      SELECT metadata FROM audit_logs WHERE entity_type = 'order' AND entity_id = ${String(o.id)}
         AND action = 'order.updated' ORDER BY id LIMIT 1`;
    assert.deepEqual(audit.metadata.changes.deliveryRate, ["10.00", "15.00"]);
  });

  test("paying the whole total settles it; then the rate can no longer change", async () => {
    const o = await place({ quantity: 1500, deliveryRate: 20 });
    await pay(o.id);
    const r = await row(o.id);
    assert.equal(r.payment_status, "Paid", "product + delivery paid = fully paid, not overpaid");
    assert.equal(Number(r.amount_paid), 1380000);

    const late = await as(finance.token).patch(`/api/orders/${o.id}`, { deliveryRate: 5 });
    assert.equal(late.status, 409);
    assert.match(late.body.message, /payment is already recorded/);
  });

  test("the PFI's revenue is the product alone", async () => {
    const res = await as(admin).get(`/api/pfis/${pfi.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.data.pfi ?? res.body.data;
    // One paid order: 1,500 L at ₦900 with ₦30,000 of delivery.
    assert.equal(Number(p.financials.revenue), 1350000);
  });
});
