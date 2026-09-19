// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq } = require("drizzle-orm");

const app = require("../app");
const { db } = require("../config/db");
const { depots, products, depotProductPrices, depotPriceChanges } = require("../db/schema");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * A price is what an order is billed at.
 *
 * order.service.js reads current_price as the server price and refuses the
 * client's, so a number typed on the pricing page used to reach every customer
 * the instant it saved. Everything the gate claims is asserted here: that
 * setting a price does not move the live one, that only an admin can release
 * it, that releasing it is what moves it, and that a refused price leaves the
 * old one exactly where it was.
 */
const API = "/api/depots";
const RUN = Date.now();

let finance;   // may set a price
let admin;     // may release one
let depot;
let product;

describe("depot price approval — set, then a second person releases", () => {
  before(async () => {
    finance = await staffTokenWithRoles(["finance"], `price-fin-${RUN}@soroman.test`);
    admin = await staffTokenWithRoles(["admin"], `price-adm-${RUN}@soroman.test`);

    [depot] = await db.insert(depots).values({
      name: `Price Depot ${RUN}`, code: `PD${RUN}`.slice(-12), address: "1 Rd",
      city: "Lagos", state: "Lagos", country: "NG", postcode: "100001",
      maxCapacity: 1000, establishedYear: "2020",
    }).returning();

    [product] = await db.insert(products).values({
      name: `PMS ${RUN}`, sku: `SKU${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
  });

  after(async () => {
    await db.delete(depotPriceChanges).where(eq(depotPriceChanges.depotId, depot.id));
    await db.delete(depotProductPrices).where(eq(depotProductPrices.depotId, depot.id));
    await db.delete(depots).where(eq(depots.id, depot.id));
    await db.delete(products).where(eq(products.id, product.id));
    await closeDb();
  });

  const setPrice = (price) =>
    request(app)
      .patch(`${API}/${depot.id}/product-price`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ productId: product.id, price });

  test("setting a price does not make it live", async () => {
    const res = await setPrice(900);
    assert.equal(res.status, 200);
    assert.match(res.body.message, /approval/i);

    const live = await db
      .select()
      .from(depotProductPrices)
      .where(eq(depotProductPrices.depotId, depot.id));
    assert.equal(live.length, 0, "nothing is sellable until it is approved");

    const [change] = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.depotId, depot.id));
    assert.equal(change.status, "pending");
    assert.equal(change.previousPrice, null, "a first price is not a change from zero");
    assert.equal(Number(change.requestedBy), finance.staff.id);
  });

  /**
   * The route says super_admin and admin; the middleware currently says
   * everyone.
   *
   * requireRole is deliberately a no-op across this whole app — see
   * verifyStaff.js: "every authenticated member of staff holds every role's
   * rights", kept only so the route files still document who a route was FOR.
   * So the second check here is the second ACT, not the second role: a price
   * cannot go live without somebody separately approving it, and the trail
   * names who did.
   *
   * Pinned as a test rather than left as a surprise: if authorisation is ever
   * reinstated this fails, and whoever reinstates it is told that this
   * endpoint expected to be gated.
   */
  test("the role gate is declarative today — approval is open to any staff", async () => {
    const [change] = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.depotId, depot.id));
    const res = await request(app)
      .post(`${API}/price-changes/${change.id}/reject`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ note: "wrong figure" });
    assert.equal(res.status, 200, "requireRole does not refuse anybody at present");

    const live = await db
      .select()
      .from(depotProductPrices)
      .where(eq(depotProductPrices.depotId, depot.id));
    assert.equal(live.length, 0, "and rejecting still never touches the live price");
  });

  test("an admin releasing it is what puts it in front of customers", async () => {
    await setPrice(900);
    const [change] = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.status, "pending"));
    const res = await request(app)
      .post(`${API}/price-changes/${change.id}/approve`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ note: "checked against the board" });
    assert.equal(res.status, 200);

    const [live] = await db
      .select()
      .from(depotProductPrices)
      .where(eq(depotProductPrices.depotId, depot.id));
    assert.equal(Number(live.currentPrice), 900);

    const [after] = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.id, change.id));
    assert.equal(after.status, "approved");
    assert.equal(Number(after.reviewedBy), admin.staff.id);
    assert.ok(after.reviewedAt);
    assert.equal(after.reviewNote, "checked against the board");
  });

  test("a rejected price leaves the live one exactly where it was", async () => {
    await setPrice(1500);
    const [pending] = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.status, "pending"));

    const res = await request(app)
      .post(`${API}/price-changes/${pending.id}/reject`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ note: "too high" });
    assert.equal(res.status, 200);

    const [live] = await db
      .select()
      .from(depotProductPrices)
      .where(eq(depotProductPrices.depotId, depot.id));
    assert.equal(Number(live.currentPrice), 900, "still the approved price");
  });

  test("a second proposal supersedes the one still waiting", async () => {
    await setPrice(950);
    await setPrice(975);
    const rows = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.depotId, depot.id));
    const pending = rows.filter((r) => r.status === "pending");
    assert.equal(pending.length, 1, "two prices waiting for one product answers nothing");
    assert.equal(Number(pending[0].proposedPrice), 975, "the later one is what is meant");
    assert.ok(rows.some((r) => r.status === "superseded" && Number(r.proposedPrice) === 950));
  });

  /**
   * The pricing page saves through PATCH /depots/:id, not through
   * /:id/product-price — so a gate on only the latter would guard a door with
   * no wall beside it. This is the path the screen actually uses.
   */
  test("editing a depot proposes prices too, rather than going round the gate", async () => {
    const before = await db
      .select()
      .from(depotProductPrices)
      .where(eq(depotProductPrices.depotId, depot.id));
    const livePrice = Number(before[0].currentPrice);

    const res = await request(app)
      .patch(`${API}/${depot.id}`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ productPrices: [{ product: product.id, currentPrice: 1234 }] });
    assert.equal(res.status, 200);

    const [after] = await db
      .select()
      .from(depotProductPrices)
      .where(eq(depotProductPrices.depotId, depot.id));
    assert.equal(
      Number(after.currentPrice),
      livePrice,
      "editing the depot must not move the live price either",
    );

    const proposed = await db
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.status, "pending"));
    assert.ok(
      proposed.some((c) => Number(c.proposedPrice) === 1234),
      "it became a proposal, like every other price change",
    );
  });

  test("the trail names both ends of every change", async () => {
    const res = await request(app)
      .get(`${API}/price-changes?depotId=${depot.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    assert.equal(res.status, 200);

    const approved = res.body.data.changes.find((c) => c.status === "approved");
    assert.ok(approved.requestedByName, "who asked");
    assert.ok(approved.reviewedByName, "who approved");
    assert.ok(approved.requestedAt && approved.reviewedAt, "and exactly when, both times");
    assert.ok(approved.depotName && approved.productName);
  });
});
