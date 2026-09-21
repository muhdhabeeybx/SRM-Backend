// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { orders, depots, products } = require("../db/schema");
const { customerRepo, orderRepo, orderTruckRepo } = require("../repositories");
const { staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * The manual-ticket flow: order raised, released on credit, ticketed, loaded,
 * gone — and only then paid for.
 *
 * What these tests are really protecting is the pair of claims the feature
 * rests on. First, that an order nobody has authorised behaves exactly as it
 * always did — an unpaid order still releases nothing, so the gate was not
 * quietly removed for everyone. Second, that what IS released on credit stays
 * visibly unpaid all the way to Completed, because a fulfilled order that reads
 * as settled is the failure mode that loses real money.
 */

async function depotFixture() {
  const [existing] = await db.select().from(depots).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(depots)
    .values({
      name: "Credit Depot",
      code: "CRED",
      address: "1 Test Rd",
      city: "Lagos",
      state: "Lagos",
      country: "NG",
      postcode: "100001",
      maxCapacity: 1000000,
      establishedYear: "2020",
    })
    .returning();
  return row.id;
}

async function productFixture() {
  const [existing] = await db.select().from(products).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(products)
    .values({ name: "Credit Product", sku: "CRED-PRD", category: "PMS" })
    .returning();
  return row.id;
}

const RUN = Date.now();
let seq = 0;

/** A Pending, wholly unpaid pickup order — what the desk actually starts from. */
async function unpaidOrder(customerId, depotId, productId, quantity = 45000) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `ORD-CRED-${RUN}-${seq++}`,
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity,
      price: "200.00",
      totalAmount: String(quantity * 200),
      amountPaid: "0",
      deliveryType: "pickup",
      status: "Pending",
      paymentStatus: "Unpaid",
    })
    .returning();
  return order;
}

describe("manual loading ticket — released on credit, paid afterwards", () => {
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
    const customer = await customerRepo.create({
      name: "Credit Customer",
      phone: `+23484${String(RUN).slice(-8)}`,
      status: "Active",
    });
    customerId = customer.id;
    finance = await staffTokenWithRoles(["finance"], `test-credit-fin-${RUN}@soroman.test`);
    ticketing = await staffTokenWithRoles(["ticketing"], `test-credit-tkt-${RUN}@soroman.test`);
    entry = await staffTokenWithRoles(["security_entry"], `test-credit-in-${RUN}@soroman.test`);
    exit = await staffTokenWithRoles(["security_exit"], `test-credit-out-${RUN}@soroman.test`);
  });

  test("an unpaid order nobody authorised still releases nothing", async () => {
    const order = await unpaidOrder(customerId, depotId, productId);
    const fresh = await orderRepo.findByIdFull(order.id);
    const { releasableQuantity } = require("../services/order.service");

    assert.equal(releasableQuantity(fresh), 0, "the money gate is untouched for everyone else");

    // And it cannot be ticketed at all, because it is not even Released.
    const res = await request(app)
      .post(`/api/orders/${order.id}/generate-tickets`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({ trucks: [{ quantity: 1000, truckNumber: "X1", driverName: "A", driverPhone: "1" }] });
    assert.equal(res.status, 409);
  });

  test("authorising credit releases the order and lifts the ceiling by exactly that much", async () => {
    const order = await unpaidOrder(customerId, depotId, productId, 45000);

    const res = await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 30000, reason: "Paper ticket written at the depot this morning" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.releasableQuantity, 30000, "only what was authorised");

    const after = await orderRepo.findByIdFull(order.id);
    assert.equal(after.status, "Released", "Pending → Released, so it can be ticketed");
    assert.equal(after.paymentStatus, "Unpaid", "releasing on credit does NOT mark it paid");
    assert.equal(Number(after.creditQty), 30000);
    assert.ok(after.creditAuthorisedBy, "the allowance carries a name");
  });

  test("a reason is not optional", async () => {
    const order = await unpaidOrder(customerId, depotId, productId);
    const res = await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 1000 });
    assert.equal(res.status, 400);
  });

  test("credit cannot exceed the order's own quantity", async () => {
    const order = await unpaidOrder(customerId, depotId, productId, 45000);
    const res = await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 50000, reason: "too much" });
    assert.equal(res.status, 400);
  });

  test("the full run: ticket on paper, in, out, completed — and still unpaid", async () => {
    const order = await unpaidOrder(customerId, depotId, productId, 30000);

    await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 30000, reason: "Regular customer, pays on Friday" })
      .expect(200);

    // Ticketing beyond the allowance is refused ...
    const tooMuch = await request(app)
      .post(`/api/orders/${order.id}/generate-tickets`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({
        trucks: [{ quantity: 40000, truckNumber: "OVER-1", driverName: "D", driverPhone: "1" }],
      });
    assert.equal(tooMuch.status, 400);

    // ... and within it, allowed, carrying the number off the paper ticket.
    const cut = await request(app)
      .post(`/api/orders/${order.id}/generate-tickets`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({
        trucks: [
          {
            quantity: 30000,
            truckNumber: `CRED-${RUN}`,
            driverName: "Musa",
            driverPhone: "08010000001",
            manualTicketNumber: "DEPOT-BOOK-0042",
          },
        ],
      });
    assert.equal(cut.status, 200, JSON.stringify(cut.body));

    const [load] = await orderTruckRepo.findByOrder(order.id);
    assert.equal(load.manualTicketNumber, "DEPOT-BOOK-0042", "the paper ticket is tied to the row");

    // The credit cannot now be withdrawn — there is product committed against it.
    const revoke = await request(app)
      .delete(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ reason: "changed my mind" });
    assert.equal(revoke.status, 409, "cannot un-authorise what is already ticketed");

    // Through the gate.
    await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: load.id })
      .expect(200);

    await request(app)
      .post(`/api/orders/${order.id}/trucks/${load.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({})
      .expect(200);

    const done = await orderRepo.findByIdFull(order.id);
    assert.equal(done.status, "Completed", "the product physically left");
    assert.equal(done.paymentStatus, "Unpaid", "and the money has still not arrived");
    assert.ok(
      Number(done.totalAmount) - Number(done.amountPaid ?? 0) > 0,
      "the order still shows a balance owing — this is what the receivables view reads",
    );
  });

  test("credit can be withdrawn while nothing has been ticketed against it", async () => {
    const order = await unpaidOrder(customerId, depotId, productId);

    await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 5000, reason: "authorised in error" })
      .expect(200);

    const res = await request(app)
      .delete(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ reason: "authorised against the wrong order" });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.releasableQuantity, 0, "back to what the money alone buys");

    const after = await orderRepo.findByIdFull(order.id);
    assert.equal(Number(after.creditQty), 0);
    assert.equal(after.creditAuthorisedBy, null);
  });

  test("the whole act is on the order's timeline", async () => {
    const order = await unpaidOrder(customerId, depotId, productId);
    await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 2000, reason: "audit trail check" })
      .expect(200);

    const res = await request(app)
      .get(`/api/orders/${order.id}/timeline`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);

    const actions = res.body.data.events.map((e) => e.action);
    assert.ok(actions.includes("order.credit_authorised"), "the authorisation is recorded");

    const row = res.body.data.events.find((e) => e.action === "order.credit_authorised");
    assert.equal(row.metadata.reason, "audit trail check");
    assert.ok(row.actorName, "with the name of whoever gave it");
  });

  /**
   * The point of the whole feature. An order that left on credit has to be
   * findable afterwards, because the list is the only thing replacing the
   * arithmetic that used to refuse it.
   */
  test("an order that left on credit shows up in receivables", async () => {
    const order = await unpaidOrder(customerId, depotId, productId, 10000);

    await request(app)
      .post(`/api/orders/${order.id}/credit-release`)
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .send({ quantity: 10000, reason: "Receivables coverage" })
      .expect(200);

    const res = await request(app)
      .get("/api/orders/receivables")
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);

    const mine = res.body.data.orders.find((o) => o.id === order.id);
    assert.ok(mine, "the exposed order is on the list");
    assert.equal(Number(mine.outstanding), 10000 * 200, "the full value is still owed");
    assert.equal(Number(mine.creditQty), 10000);
    assert.ok(mine.creditAuthorisedByName, "with the name of whoever authorised it");
    assert.ok(mine.orderNumber && !String(mine.orderNumber).startsWith("ORD-"),
      "shown by the reference people can actually look up");
    assert.ok(res.body.data.summary.onCredit >= 10000 * 200, "and counted in the credit total");
  });

  test("a settled order is not on the receivables list", async () => {
    const order = await unpaidOrder(customerId, depotId, productId, 5000);
    // Settle it outright, the way the payment sweep would.
    await orderRepo.update(order.id, {
      amountPaid: String(5000 * 200),
      paymentStatus: "Paid",
    });

    const res = await request(app)
      .get("/api/orders/receivables")
      .set("Authorization", `Bearer ${finance.accessToken}`)
      .expect(200);

    assert.equal(
      res.body.data.orders.find((o) => o.id === order.id),
      undefined,
      "nothing owed, nothing listed",
    );
  });

  test("after (close db)", async () => {
    await closeDb();
  });
});
