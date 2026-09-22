// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { orders, depots, products } = require("../db/schema");
const { orderRepo, customerRepo, auditLogRepo, bankAccountRepo } = require("../repositories");
const walletService = require("../services/wallet.service");
const { staffTokenWithRoles, closeDb, seedLegacyHold } = require("./helpers");

// depot/product are notNull FKs on orders — reuse an existing row or make one.
// placeOrder pays into the depot's own bank account (manual deposit only —
// no Paystack DVA), so whichever depot this resolves to needs one linked.
async function depotFixture() {
  const [existing] = await db.select().from(depots).limit(1);
  const depotId = existing
    ? existing.id
    : (
        await db
          .insert(depots)
          .values({
            name: "Endpoint Depot",
            code: "ENDP",
            address: "1 Test Rd",
            city: "Lagos",
            state: "Lagos",
            country: "NG",
            postcode: "100001",
            maxCapacity: 1000000,
            establishedYear: "2020",
          })
          .returning()
      )[0].id;

  const linked = await bankAccountRepo.findAll({ depotId, status: "Active" });
  if (linked.length === 0) {
    await bankAccountRepo.create({
      bankName: "Test Bank",
      accountName: "Endpoint Depot Account",
      accountNumber: `ENDPACC${depotId}`,
      depotIds: [depotId],
      status: "Active",
      isDefault: true,
    });
  }

  return depotId;
}

async function productFixture() {
  const [existing] = await db.select().from(products).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(products)
    .values({ name: "Endpoint Product", sku: "ENDP-PRD", category: "PMS" })
    .returning();
  return row.id;
}

let seq = 0;
const RUN = Date.now();
// `rest` carries any other column the case needs — amountPaid, creditQty —
// straight through to the insert, so a test can build the exact money state it
// is about without a helper argument per column.
async function makeOrder(customerId, depotId, productId, { status, paymentStatus, ...rest } = {}) {
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber: `ORD-ENDP-${RUN}-${seq++}`,
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity: 1000,
      price: "100.00",
      totalAmount: "100000.00",
      deliveryType: "pickup",
      status: status || "Pending",
      paymentStatus: paymentStatus || "Unpaid",
      ...rest,
    })
    .returning();
  return row;
}

describe("order lifecycle endpoints — role gates + state machine", () => {
  let depotId;
  let productId;
  let customerId;
  let releaseStaff; // role: release
  let financeStaff; // role: finance
  let adminStaff; // role: admin — holds neither gate
  let superStaff; // role: super_admin — passes both gates

  before(async () => {
    depotId = await depotFixture();
    productId = await productFixture();
    const customer = await customerRepo.create({
      name: "Endpoint Customer",
      phone: `+23481${String(RUN).slice(-8)}`,
      status: "Active",
    });
    customerId = customer.id;

    releaseStaff = await staffTokenWithRoles(["release"], "test-ep-release@soroman.test");
    financeStaff = await staffTokenWithRoles(["finance"], "test-ep-finance@soroman.test");
    adminStaff = await staffTokenWithRoles(["admin"], "test-ep-admin@soroman.test");
    superStaff = await staffTokenWithRoles(["super_admin"], "test-ep-super@soroman.test");
  });

  after(async () => {
    await closeDb();
  });

  // ── release ────────────────────────────────────────────────────────────────

  test("the release desk moves a Paid order to Released, stamping who + when", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Paid",
      paymentStatus: "Paid",
    });

    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${releaseStaff.accessToken}`)
      .send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.data.order.status, "Released");

    const after = await orderRepo.findById(order.id);
    assert.equal(after.status, "Released");
    assert.ok(after.releasedAt, "releasedAt stamped");
    assert.equal(after.releasedBy, releaseStaff.staff.id);

    const events = await auditLogRepo.findByEntity("order", order.id);
    const released = events.find((e) => e.newState === "Released");
    assert.ok(released, "audit row written");
    assert.equal(released.actorStaffId, releaseStaff.staff.id);
  });

  test("super_admin may also release", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Paid",
      paymentStatus: "Paid",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 200);
  });

  test("a role without the release gate is refused 403", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Paid",
      paymentStatus: "Paid",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${adminStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 403);

    const after = await orderRepo.findById(order.id);
    assert.equal(after.status, "Paid", "status unchanged by a refused caller");
  });

  /**
   * Nothing loads on an outstanding.
   *
   * Pending → Released IS a legal move in the state machine — the credit path
   * needs it — so the state machine alone never refused this. The gate is the
   * money: a full payment releases the order by itself, so an order sitting at
   * Pending here is one still owing, and releasing it from this screen would be
   * the part-payment release taken out through a side entrance.
   */
  test("releasing an order nobody has paid for is refused (409)", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Pending",
      paymentStatus: "Unpaid",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${releaseStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /outstanding/i, "the desk is told what is missing");
  });

  test("a part-paid order is refused too — a balance is a balance", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Pending",
      paymentStatus: "Part Paid",
      amountPaid: "1000",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${releaseStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 409);
  });

  test("an order paid in full may be released", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Paid",
      paymentStatus: "Paid",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${releaseStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("an authorised credit allowance opens the same gate on a balance", async () => {
    // Credit is the one way to load against an outstanding, and it is a
    // decision with an authoriser's name on it — see the credit allowance in
    // order.controller.js. It must keep working, or the exception the business
    // actually relies on disappears with the part-payment release.
    // The authoriser, the timestamp and the reason are not decoration: the
    // orders_credit_authorised_check constraint refuses credit without them,
    // which is the database insisting the exception has a name on it.
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Pending",
      paymentStatus: "Unpaid",
      creditQty: "10",
      creditReason: "Trusted customer — cleared by finance",
      creditAuthorisedBy: superStaff.staff.id,
      creditAuthorisedAt: new Date(),
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/release`)
      .set("Authorization", `Bearer ${releaseStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  // ── cancel ───────────────────────────────────────────────────────────────

  test("finance cancels a Paid order and the held funds are returned", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Paid",
      paymentStatus: "Paid",
    });
    const amount = Number(order.totalAmount);

    // A Paid order holds the customer's funds. makeOrder's raw insert doesn't
    // place the hold, so do it here — that's what cancel releases. Fund the
    // wallet first so the hold can be taken.
    await customerRepo.creditBalance(customerId, amount);
    const startBalance = Number((await customerRepo.findById(customerId)).balance);
    await seedLegacyHold({ customerId, orderId: order.id, amount, description: "test" });
    assert.equal(
      Number((await customerRepo.findById(customerId)).balance),
      startBalance - amount,
      "funds are held while the order is Paid"
    );

    const res = await request(app)
      .post(`/api/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${financeStaff.accessToken}`)
      .send({ reason: "customer changed their mind" });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.order.status, "Cancelled");

    const after = await orderRepo.findById(order.id);
    assert.equal(after.status, "Cancelled");
    assert.equal(after.cancelledBy, financeStaff.staff.id);
    assert.equal(after.cancellationReason, "customer changed their mind");

    // releaseHold returns the held money — balance back to before the hold, and
    // no debit/credit ledger churn (the hold is the record).
    assert.equal(
      Number((await customerRepo.findById(customerId)).balance),
      startBalance,
      "the held funds were returned on cancel"
    );
    const hold = await walletService.findHoldByOrder(order.id);
    assert.equal(hold.status, "released", "the hold is marked released");
  });

  test("a role without the finance gate cannot cancel (403)", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Paid",
      paymentStatus: "Paid",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${adminStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 403);

    const after = await orderRepo.findById(order.id);
    assert.equal(after.status, "Paid", "status unchanged by a refused caller");
  });

  test("cancelling an already-cancelled order is refused 409, so no double refund", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Cancelled",
      paymentStatus: "Paid",
    });
    const res = await request(app)
      .post(`/api/orders/${order.id}/cancel`)
      .set("Authorization", `Bearer ${financeStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 409);
  });

  // ── H1: the raw status setter is gone ──────────────────────────────────────

  test("the removed raw PUT status setter is not routable", async () => {
    const order = await makeOrder(customerId, depotId, productId, {
      status: "Pending",
    });
    const res = await request(app)
      .put(`/api/orders/${order.id}`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({ status: "Completed" });
    assert.equal(res.status, 404, "PUT /orders/:id no longer exists");

    const after = await orderRepo.findById(order.id);
    assert.equal(after.status, "Pending", "status could not be force-set");
  });
});
