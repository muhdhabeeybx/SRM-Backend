require("dotenv").config();

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { and, eq } = require("drizzle-orm");
const { depots, products, depotProductPrices } = require("../db/schema");
const { customerRepo, orderRepo, orderTruckRepo, bankAccountRepo } = require("../repositories");
const { staffTokenWithRoles, closeDb } = require("./helpers");
const { releasableQuantity } = require("../services/order.service");

/**
 * An order raised with no agreed price — the manually written ticket.
 *
 * The claim under test is narrow and load-bearing: an unpriced order must never
 * read as a FREE one. Zero is the value the schema has to store, and zero is
 * also what "we gave it away" looks like, so every assertion here is really
 * asking the same question — does the system still know the difference?
 *
 * The sharpest of them is the receivables case. findReceivables filters on an
 * outstanding balance, and an unpriced order has none to show; if it falls off
 * that list, the business has given away fuel the system says nobody owes for.
 */

async function depotFixture() {
  const [existing] = await db.select().from(depots).limit(1);
  const depotId = existing
    ? existing.id
    : (
        await db
          .insert(depots)
          .values({
            name: "Unpriced Depot", code: "UNPR", address: "1 Test Rd", city: "Lagos",
            state: "Lagos", country: "NG", postcode: "100001", maxCapacity: 1000000,
            establishedYear: "2020",
          })
          .returning()
      )[0].id;

  const linked = await bankAccountRepo.findAll({ depotId, status: "Active" });
  if (linked.length === 0) {
    await bankAccountRepo.create({
      bankName: "Test Bank", accountName: "Unpriced Depot Account",
      accountNumber: `UNPRACC${depotId}`, depotIds: [depotId], status: "Active", isDefault: true,
    });
  }
  return depotId;
}

async function productFixture() {
  const [existing] = await db.select().from(products).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(products)
    .values({ name: "Unpriced Product", sku: "UNPR-PRD", category: "PMS" })
    .returning();
  return row.id;
}

/**
 * The depot must actually sell this product for a price, or the CONTROL case —
 * an ordinary priced order — cannot be created at all. The unpriced path does
 * not need it, which is the whole point, so its absence would hide the one
 * assertion proving normal orders still behave.
 */
async function priceFixture(depotId, productId) {
  const existing = await db
    .select()
    .from(depotProductPrices)
    .where(
      and(eq(depotProductPrices.depotId, depotId), eq(depotProductPrices.productId, productId)),
    )
    .limit(1);
  if (existing.length) return;
  await db
    .insert(depotProductPrices)
    .values({ depotId, productId, currentPrice: "200.00" });
}

const RUN = Date.now();

describe("an order raised with no price", () => {
  let depotId;
  let productId;
  let customerId;
  let finance;
  let ticketing;
  let entry;
  let exit;

  before(async () => {
    depotId = await depotFixture();
    productId = await productFixture();
    await priceFixture(depotId, productId);
    const customer = await customerRepo.create({
      name: "Unpriced Customer",
      phone: `+23485${String(RUN).slice(-8)}`,
      status: "Active",
    });
    customerId = customer.id;
    finance = await staffTokenWithRoles(["finance"], `test-unpriced-fin-${RUN}@soroman.test`);
    ticketing = await staffTokenWithRoles(["ticketing"], `test-unpriced-tkt-${RUN}@soroman.test`);
    entry = await staffTokenWithRoles(["security_entry"], `test-unpriced-in-${RUN}@soroman.test`);
    exit = await staffTokenWithRoles(["security_exit"], `test-unpriced-out-${RUN}@soroman.test`);
  });

  const raise = (token, body = {}) =>
    request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customer: customerId,
        depot: depotId,
        product: productId,
        state: "Lagos",
        quantity: 30000, // overridden per test — see the de-duplication note
        deliveryType: "pickup",
        companyName: "Unpriced Co",
        ...body,
      });

  test("raising one needs a reason", async () => {
    const res = await raise(finance.accessToken, { unpriced: {} });
    assert.equal(res.status, 400);
  });

  test("it is created pending, and authorised to load in the same act", async () => {
    const res = await raise(finance.accessToken, {
      quantity: 30000,
      unpriced: { reason: "Paper ticket written at the depot, price to follow" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const order = await orderRepo.findByIdFull(res.body.data.order.id);
    assert.equal(order.pricingStatus, "pending");
    assert.equal(Number(order.price), 0);
    assert.equal(Number(order.totalAmount), 0);
    // The one act covers both halves — no second request to forget.
    assert.equal(Number(order.creditQty), 30000, "authorised to load its full quantity");
    assert.ok(order.creditAuthorisedBy, "with a name against it");
    assert.equal(
      releasableQuantity(order),
      30000,
      "and it can actually be ticketed, despite having no price to divide by",
    );
  });

  /**
   * The trap this whole design exists to avoid. An unpriced order owes an
   * amount nobody has computed, so it cannot satisfy an outstanding-balance
   * test — and it is precisely the order most likely to be forgotten.
   */
  test("it appears in receivables even though it owes a computed nothing", async () => {
    const created = await raise(finance.accessToken, {
      quantity: 31000,
      unpriced: { reason: "Receivables coverage" },
    });
    const orderId = created.body.data.order.id;

    const res = await request(app)
      .get("/api/orders/receivables")
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);

    const mine = res.body.data.orders.find((o) => o.id === orderId);
    assert.ok(mine, "an unpriced order is NOT allowed to fall off this list");
    assert.equal(mine.awaitingPrice, true);
    assert.equal(Number(mine.outstanding), 0, "its balance really is zero — that is the danger");
    assert.ok(
      res.body.data.summary.awaitingPrice >= 1,
      "counted separately, because a naira total cannot describe it",
    );
  });

  test("its zero is kept out of the naira totals", async () => {
    const res = await request(app)
      .get("/api/orders/receivables")
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);

    const unpricedRows = res.body.data.orders.filter((o) => o.awaitingPrice);
    const pricedTotal = res.body.data.orders
      .filter((o) => !o.awaitingPrice)
      .reduce((sum, o) => sum + Number(o.outstanding), 0);

    assert.ok(unpricedRows.length > 0, "there are unpriced rows in this fixture");
    assert.equal(
      Number(res.body.data.summary.outstanding),
      pricedTotal,
      "the headline figure describes only orders somebody has actually priced",
    );
  });

  test("no payment can be taken against it before it is priced", async () => {
    const created = await raise(finance.accessToken, {
      quantity: 32000,
      unpriced: { reason: "Payment guard" },
    });
    const res = await request(app)
      .post(`/api/orders/${created.body.data.order.id}/payments`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ bankAccountId: 1, lineIds: [1] });

    assert.equal(res.status, 409, "otherwise the money lands as surplus on a free order");
  });

  test("the full run: ticket on paper, in, out, priced afterwards, then invoiceable", async () => {
    const created = await raise(finance.accessToken, {
      quantity: 33000,
      unpriced: { reason: "Walk-in, price agreed after loading" },
    });
    const orderId = created.body.data.order.id;

    // It loads with no price at all.
    const cut = await request(app)
      .post(`/api/orders/${orderId}/generate-tickets`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({
        trucks: [{
          quantity: 33000,
          truckNumber: `UNPR-${RUN}`,
          driverName: "Sani",
          driverPhone: "08010000002",
          manualTicketNumber: "DEPOT-BOOK-0099",
        }],
      });
    assert.equal(cut.status, 200, JSON.stringify(cut.body));

    const [load] = await orderTruckRepo.findByOrder(orderId);
    assert.equal(load.manualTicketNumber, "DEPOT-BOOK-0099");

    await request(app)
      .post(`/api/orders/${orderId}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: load.id })
      .expect(200);

    await request(app)
      .post(`/api/orders/${orderId}/trucks/${load.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({})
      .expect(200);

    const gone = await orderRepo.findByIdFull(orderId);
    assert.equal(gone.status, "Completed", "the product left");
    assert.equal(gone.pricingStatus, "pending", "and nobody has priced it yet");

    // Now the invoice conversation happens.
    const priced = await request(app)
      .post(`/api/orders/${orderId}/price`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ price: 250, reason: "Agreed with the customer on the phone" });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));

    const after = await orderRepo.findByIdFull(orderId);
    assert.equal(after.pricingStatus, "priced");
    assert.equal(Number(after.price), 250);
    assert.equal(Number(after.totalAmount), 250 * 33000, "the invoice figure is computed, not typed");
    assert.equal(after.paymentStatus, "Unpaid", "pricing is not paying");
    assert.ok(after.pricedBy, "and it is recorded who agreed it");

    // Pricing does not clear the exposure — the money still has not arrived.
    const rec = await request(app)
      .get("/api/orders/receivables")
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);
    const row = rec.body.data.orders.find((o) => o.id === orderId);
    assert.ok(row, "still owed, so still listed");
    assert.equal(row.awaitingPrice, false);
    assert.equal(Number(row.outstanding), 250 * 33000, "now with a real figure against it");
  });

  test("an order cannot be priced twice", async () => {
    const created = await raise(finance.accessToken, {
      quantity: 34000,
      unpriced: { reason: "Reprice guard" },
    });
    const orderId = created.body.data.order.id;

    await request(app)
      .post(`/api/orders/${orderId}/price`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ price: 200, reason: "first" })
      .expect(200);

    const again = await request(app)
      .post(`/api/orders/${orderId}/price`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ price: 999, reason: "second" });

    assert.equal(again.status, 409, "repricing is a different act with its own trail");
  });

  test("an ordinary order is completely unaffected", async () => {
    // A distinct quantity: placeOrder de-duplicates recent identical orders, so
    // reusing 30000 here returns one of the unpriced orders above instead of
    // creating a priced one. (That guard working is its own small reassurance.)
    const res = await raise(finance.accessToken, { quantity: 27500 });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const order = await orderRepo.findByIdFull(res.body.data.order.id);
    assert.equal(order.pricingStatus, "priced", "the default, for every order that came before");
    assert.ok(Number(order.price) > 0, "priced from the depot, server-side, as always");
    assert.equal(Number(order.creditQty), 0, "and authorised for nothing");
    assert.equal(releasableQuantity(order), 0, "so an unpaid one still releases nothing");
  });

  test("after (close db)", async () => {
    await closeDb();
  });
});
