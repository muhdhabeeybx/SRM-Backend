require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db, client } = require("../config/db");
const { and, eq } = require("drizzle-orm");
const { depots, products, depotProductPrices } = require("../db/schema");
const { customerRepo, orderRepo, bankAccountRepo } = require("../repositories");
const { staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * The controls the manual ticket is switched on with (2026-10-05).
 *
 * Raising an unpriced order or releasing one before payment stays open to any
 * member of staff — the owner's decision. What makes that safe is here:
 *
 *   - the board price is kept at raise, so a price agreed under it shows
 *   - finance or an admin prices, and never whoever raised or released it
 *   - no more before payment while an earlier lot is unsettled past 7 days,
 *     unless a super admin overrides with a reason
 *   - one paper ticket number is not quietly used for two trucks
 */

async function fixtures() {
  const [depot] = await db.select().from(depots).limit(1);
  const depotId = depot
    ? depot.id
    : (await db.insert(depots).values({
        name: "Controls Depot", code: "CTRL", address: "1 Test Rd", city: "Lagos", state: "Lagos",
        country: "NG", postcode: "100001", maxCapacity: 1000000, establishedYear: "2020",
      }).returning())[0].id;
  if ((await bankAccountRepo.findAll({ depotId, status: "Active" })).length === 0) {
    await bankAccountRepo.create({
      bankName: "Test Bank", accountName: "Controls Depot Account",
      accountNumber: `CTRLACC${depotId}`, depotIds: [depotId], status: "Active", isDefault: true,
    });
  }
  const [product] = await db.select().from(products).limit(1);
  const productId = product
    ? product.id
    : (await db.insert(products).values({ name: "Controls Product", sku: "CTRL-PRD", category: "PMS" }).returning())[0].id;

  const where = and(eq(depotProductPrices.depotId, depotId), eq(depotProductPrices.productId, productId));
  const [price] = await db.select().from(depotProductPrices).where(where).limit(1);
  // A board to measure against; restored in `after` so nothing else sees it.
  const previous = price ? price.currentPrice : null;
  if (price) await db.update(depotProductPrices).set({ currentPrice: "200.00" }).where(where);
  else await db.insert(depotProductPrices).values({ depotId, productId, currentPrice: "200.00" });
  return { depotId, productId, previous, where };
}

const RUN = Date.now();
let qty = 21000;
const nextQty = () => (qty += 100);

describe("manual ticket controls", () => {
  let fx;
  let customerId;
  let raiser;
  let finance;
  let ticketing;
  let superAdmin;

  before(async () => {
    fx = await fixtures();
    customerId = (await customerRepo.create({
      name: "Controls Customer", phone: `+23486${String(RUN).slice(-8)}`, status: "Active",
    })).id;
    // The desk raising it holds no finance role at all — any staff may.
    raiser = await staffTokenWithRoles(["sales"], `ctrl-raise-${RUN}@soroman.test`);
    finance = await staffTokenWithRoles(["finance"], `ctrl-fin-${RUN}@soroman.test`);
    ticketing = await staffTokenWithRoles(["ticketing"], `ctrl-tkt-${RUN}@soroman.test`);
    superAdmin = await staffTokenWithRoles(["super_admin"], `ctrl-super-${RUN}@soroman.test`);
  });

  after(async () => {
    if (fx.previous != null) await db.update(depotProductPrices).set({ currentPrice: fx.previous }).where(fx.where);
    else await db.delete(depotProductPrices).where(fx.where);
    await client`DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id IN (SELECT id FROM orders WHERE customer_id = ${customerId})`;
    await client`DELETE FROM order_trucks WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ${customerId})`;
    await client`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ${customerId})`;
    await closeDb();
  });

  const raise = (token, body = {}) =>
    request(app).post("/api/orders").set("Authorization", `Bearer ${token}`).send({
      customer: customerId, depot: fx.depotId, product: fx.productId, state: "Lagos",
      quantity: nextQty(), deliveryType: "pickup", companyName: "Controls Co",
      unpriced: { reason: "Handwritten ticket at the depot" },
      ...body,
    });
  const price = (token, orderId, body) =>
    request(app).post(`/api/orders/${orderId}/price`).set("Authorization", `Bearer ${token}`).send(body);

  test("an unpriced order keeps the board price it left at", async () => {
    const res = await raise(raiser.accessToken);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const order = await orderRepo.findByIdFull(res.body.data.order.id);
    assert.equal(order.pricingStatus, "pending");
    assert.equal(Number(order.boardPrice), 200, "read now — the board is zeroed at 23:59");
    assert.equal(Number(order.price), 0, "kept, never charged");
  });

  test("only finance or an admin can price, and never whoever raised it", async () => {
    const { body } = await raise(raiser.accessToken);
    const orderId = body.data.order.id;

    const desk = await price(ticketing.accessToken, orderId, { price: 210, reason: "agreed" });
    assert.equal(desk.status, 403, "the ticketing desk cannot type the price");

    // The raiser given a finance role is still the raiser.
    const raiserWithFinance = await staffTokenWithRoles(["sales", "finance"], `ctrl-raise-${RUN}@soroman.test`);
    const own = await price(raiserWithFinance.accessToken, orderId, { price: 210, reason: "agreed" });
    assert.equal(own.status, 403);
    assert.match(own.body.message, /somebody else has to price it/);
    await staffTokenWithRoles(["sales"], `ctrl-raise-${RUN}@soroman.test`);

    const other = await price(finance.accessToken, orderId, { price: 210, reason: "agreed" });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.data.belowBoard, null, "at or over the board is not flagged");
  });

  test("whoever released it on credit cannot price it either", async () => {
    const { body } = await raise(superAdmin.accessToken);
    const orderId = body.data.order.id;
    // Re-authorised by the finance user: they now let it load before payment.
    const credit = await request(app)
      .post(`/api/orders/${orderId}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 1000, reason: "trusted for part" });
    assert.equal(credit.status, 200, JSON.stringify(credit.body));
    const res = await price(finance.accessToken, orderId, { price: 220, reason: "agreed" });
    assert.equal(res.status, 403);
  });

  test("a super admin may raise and price the same order", async () => {
    const { body } = await raise(superAdmin.accessToken);
    const res = await price(superAdmin.accessToken, body.data.order.id, { price: 205, reason: "agreed" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("a price under the board goes through, and the gap is written down and listed", async () => {
    const { body } = await raise(raiser.accessToken);
    const orderId = body.data.order.id;
    const quantity = Number(body.data.order.quantity);

    const res = await price(finance.accessToken, orderId, { price: 185, reason: "loyal customer" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.belowBoard, { boardPrice: 200, perUnit: 15, gap: 15 * quantity });
    assert.match(res.body.message, /₦15 under the board of ₦200/);

    const [audit] = await client`
      SELECT metadata FROM audit_logs WHERE entity_type = 'order' AND entity_id = ${orderId} AND action = 'order.priced'`;
    assert.equal(audit.metadata.belowBoard.gap, 15 * quantity);

    const rec = await request(app)
      .get("/api/orders/receivables")
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);
    const row = rec.body.data.orders.find((o) => o.id === orderId);
    assert.equal(row.belowBoard, true);
    assert.equal(row.belowBoardGap, 15 * quantity);
    assert.ok(rec.body.data.summary.belowBoardGap >= 15 * quantity);
  });

  describe("the seven-day limit", () => {
    let overdueId;

    before(async () => {
      const { body } = await raise(raiser.accessToken);
      overdueId = body.data.order.id;
      await client`UPDATE orders SET credit_authorised_at = NOW() - interval '8 days' WHERE id = ${overdueId}`;
    });

    test("no new unpriced order while an earlier one is unsettled past it", async () => {
      const res = await raise(raiser.accessToken);
      assert.equal(res.status, 409);
      assert.equal(res.body.details.code, "CREDIT_LIMIT");
      assert.ok(res.body.details.orders.some((o) => o.id === overdueId));
      assert.equal(res.body.details.canOverride, false);
    });

    test("nor an early release of a priced order", async () => {
      const priced = await raise(raiser.accessToken, { unpriced: undefined });
      assert.equal(priced.status, 201, JSON.stringify(priced.body));
      const res = await request(app)
        .post(`/api/orders/${priced.body.data.order.id}/credit-release`)
        .set("Authorization", `Bearer ${finance.accessToken}`)
        .send({ quantity: 1000, reason: "trusted" });
      assert.equal(res.status, 409);
      assert.equal(res.body.details.code, "CREDIT_LIMIT");
    });

    test("an override from anyone but a super admin is not an override", async () => {
      const res = await raise(finance.accessToken, { limitOverride: { reason: "I said so" } });
      assert.equal(res.status, 409);
      assert.match(res.body.message, /Only a super admin/);
    });

    test("a super admin overrides with a reason, and it is written down", async () => {
      const res = await raise(superAdmin.accessToken, { limitOverride: { reason: "Paying Friday, agreed with MD" } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const [row] = await client`
        SELECT metadata FROM audit_logs
         WHERE entity_type = 'order' AND entity_id = ${res.body.data.order.id} AND action = 'order.credit_limit_overridden'`;
      assert.equal(row.metadata.reason, "Paying Friday, agreed with MD");
      assert.ok(row.metadata.overdueOrders.some((o) => o.id === overdueId));
    });

    test("once the old lot is settled, the customer is clear", async () => {
      await client`UPDATE orders SET status = 'Cancelled' WHERE id = ${overdueId}`;
      const res = await raise(raiser.accessToken);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });
  });

  describe("paper ticket numbers", () => {
    const paper = `BOOK-${RUN}`;
    const cut = (orderId, trucks, extra = {}) =>
      request(app)
        .post(`/api/orders/${orderId}/generate-tickets`)
        .set("Authorization", `Bearer ${ticketing.accessToken}`)
        .send({ trucks, ...extra });
    const truck = (plate, number) => ({
      quantity: 5000, truckNumber: plate, driverName: "Sani", driverPhone: "08010000002", manualTicketNumber: number,
    });

    test("a number used once at the depot is asked about the second time, then recorded if confirmed", async () => {
      const first = (await raise(superAdmin.accessToken)).body.data.order.id;
      assert.equal((await cut(first, [truck(`PA-${RUN}`, paper)])).status, 200);

      // The same truck again on the same order is a retry, not a second use.
      assert.equal((await cut(first, [truck(`PA-${RUN}`, paper)])).status, 200);

      const second = (await raise(superAdmin.accessToken)).body.data.order.id;
      const asked = await cut(second, [truck(`PB-${RUN}`, ` ${paper.toLowerCase()} `)]);
      assert.equal(asked.status, 409);
      assert.equal(asked.body.details.code, "MANUAL_TICKET_REUSED");
      assert.equal(asked.body.details.clashes[0].truckNumber, `PA-${RUN}`);

      const confirmed = await cut(second, [truck(`PB-${RUN}`, paper)], { manualTicketReuseConfirmed: true });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      const [row] = await client`
        SELECT metadata FROM audit_logs
         WHERE entity_type = 'order' AND entity_id = ${second} AND action = 'order.manual_ticket_reused'`;
      assert.equal(row.metadata.clashes[0].number, paper);
    });

    test("one number on two trucks in the same request is asked about too", async () => {
      const orderId = (await raise(superAdmin.accessToken)).body.data.order.id;
      const res = await cut(orderId, [truck(`PC-${RUN}`, `TWIN-${RUN}`), truck(`PD-${RUN}`, `TWIN-${RUN}`)]);
      assert.equal(res.status, 409);
      assert.equal(res.body.details.clashes[0].inThisBatch, true);
    });
  });
});
