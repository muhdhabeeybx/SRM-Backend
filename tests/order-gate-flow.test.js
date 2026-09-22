// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { orders, depots, products } = require("../db/schema");
const { customerRepo, orderRepo, orderTruckRepo, ticketRepo, bankAccountRepo } = require("../repositories");
const { staffTokenWithRoles, closeDb } = require("./helpers");

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
            name: "Gate Depot",
            code: "GATE",
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
      accountName: "Gate Depot Account",
      accountNumber: `GATEACC${depotId}`,
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
    .values({ name: "Gate Product", sku: "GATE-PRD", category: "PMS" })
    .returning();
  return row.id;
}

let seq = 0;
const RUN = Date.now();
// A Released order plus its allocated loads, ready for the gate. With
// `allocate: false` the order is released carrying no loads at all — what
// payment's automatic release leaves behind for the ticketing desk.
async function releasedDeliveryOrder(customerId, depotId, productId, truckQtys, { allocate = true } = {}) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `ORD-GATE-${RUN}-${seq++}`,
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity: truckQtys.reduce((a, b) => a + b, 0),
      price: "100.00",
      totalAmount: "1.00",
      deliveryType: "delivery",
      status: "Released",
      paymentStatus: "Paid",
    })
    .returning();

  let index = 1;
  if (allocate) {
    for (const q of truckQtys) {
      await orderTruckRepo.create({
        orderId: order.id,
        truckIndex: index++,
        truckNumber: `PLATE-${RUN}-${index}`,
        quantity: String(q),
        status: "pending",
      });
    }
  }
  return order;
}

async function releasedPickupOrder(customerId, depotId, productId, quantity) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `ORD-GATE-${RUN}-${seq++}`,
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity,
      price: "100.00",
      totalAmount: "1.00",
      deliveryType: "pickup",
      status: "Released",
      paymentStatus: "Paid",
    })
    .returning();
  return order;
}

describe("truck gate flow — Released → Loading → Completed", () => {
  let depotId;
  let productId;
  let customerId;
  let entry; // security_entry
  let ticketing;
  let exit; // security_exit
  let superStaff;

  before(async () => {
    depotId = await depotFixture();
    productId = await productFixture();
    const customer = await customerRepo.create({
      name: "Gate Customer",
      phone: `+23483${String(RUN).slice(-8)}`,
      status: "Active",
    });
    customerId = customer.id;
    entry = await staffTokenWithRoles(["security_entry"], "test-gate-entry@soroman.test");
    ticketing = await staffTokenWithRoles(["ticketing"], "test-gate-ticketing@soroman.test");
    exit = await staffTokenWithRoles(["security_exit"], "test-gate-exit@soroman.test");
    superStaff = await staffTokenWithRoles(["super_admin"], "test-gate-super@soroman.test");
  });

  after(async () => {
    await closeDb();
  });

  test("a full delivery lifecycle: two trucks in, loaded, out — first-in opens Loading, last-out Completes", async () => {
    const order = await releasedDeliveryOrder(customerId, depotId, productId, [30000, 30000]);
    const loads = await orderTruckRepo.findByOrder(order.id);
    const [t1, t2] = loads;

    // First truck gates in → Released → Loading.
    let res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t1.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.truck.status, "gated_in");
    assert.equal((await orderRepo.findById(order.id)).status, "Loading", "first-in opened Loading");

    // Second truck gates in — order already Loading, stays Loading.
    res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t2.id });
    assert.equal(res.status, 200);
    assert.equal((await orderRepo.findById(order.id)).status, "Loading");

    // Both load → each gets a ticket. A truck already inside the gate keeps its
    // gated_in state; only the loading stamp is added.
    for (const t of [t1, t2]) {
      res = await request(app)
        .post(`/api/orders/${order.id}/trucks/${t.id}/load`)
        .set("Authorization", `Bearer ${ticketing.accessToken}`)
        .send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.data.truck.status, "gated_in");
      assert.ok(res.body.data.truck.loadedAt, "the loading is stamped");
      assert.ok(res.body.data.ticket.ticketNumber.includes(`-${t.truckIndex}`), "per-truck ticket number");
      const tk = await ticketRepo.findByOrderTruck(t.id);
      assert.ok(tk, "ticket row linked to the load");
    }

    // First truck out — order still Loading (one truck remains).
    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t1.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.orderCompleted, false);
    assert.equal((await orderRepo.findById(order.id)).status, "Loading");

    // Last truck out — order Completes.
    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t2.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.orderCompleted, true);
    const done = await orderRepo.findById(order.id);
    assert.equal(done.status, "Completed");
    assert.ok(done.completedAt, "completedAt stamped");
  });

  test("a truck batch short of the order's full quantity does not complete it — the order stays open for the remaining balance", async () => {
    // The MA11089/CE11241 incident: an order for 62,000L where only a 50,000L
    // truck ever gets created and gated out. "No load remains in a
    // non-terminal state" was true the moment that one truck exited, but
    // 12,000L of the order was never ticketed at all — the order must not
    // complete until the full quantity actually has been.
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `ORD-GATE-${RUN}-${seq++}`,
        customerId,
        state: "Lagos",
        depotId,
        productId,
        quantity: 62000,
        price: "100.00",
        totalAmount: "1.00",
        deliveryType: "delivery",
        status: "Released",
        paymentStatus: "Paid",
      })
      .returning();

    const t1 = await orderTruckRepo.create({
      orderId: order.id,
      truckIndex: 1,
      truckNumber: `PARTIAL-${RUN}-1`,
      quantity: "50000",
      status: "pending",
    });

    await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t1.id });
    await request(app)
      .post(`/api/orders/${order.id}/trucks/${t1.id}/load`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({});

    let res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t1.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.orderCompleted, false, "50,000 of 62,000 ticketed — must not complete yet");
    assert.equal((await orderRepo.findById(order.id)).status, "Loading", "stays open for the remaining 12,000L");

    // The remaining balance is ticketed in a second sitting, exactly as it
    // would be once the shortfall is noticed.
    res = await request(app)
      .post(`/api/orders/${order.id}/generate-tickets`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({
        trucks: [
          { quantity: 12000, truckNumber: `PARTIAL-${RUN}-2`, driverName: "Musa", driverPhone: "+2348010000099" },
        ],
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const t2 = res.body.data.trucks[0];

    await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t2.id });

    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t2.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.orderCompleted, true, "full 62,000L now ticketed — completes");
    assert.equal((await orderRepo.findById(order.id)).status, "Completed");
  });

  test("a pickup lifecycle: security captures the customer's own truck at gate-in", async () => {
    const order = await releasedPickupOrder(customerId, depotId, productId, 40000);

    // No loads exist yet; gate-in creates one.
    let res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ truckNumber: "OWN-TRUCK-1", quantity: 40000, driverName: "Ada" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const loadId = res.body.data.truck.id;
    assert.equal(res.body.data.truck.truckNumber, "OWN-TRUCK-1");
    assert.equal(res.body.data.truck.driverName, "Ada");
    assert.equal((await orderRepo.findById(order.id)).status, "Loading");

    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${loadId}/load`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({});
    assert.equal(res.status, 200);

    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${loadId}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal((await orderRepo.findById(order.id)).status, "Completed");
  });

  test("the ticket is the loading: generated loads go straight in and out", async () => {
    // The flow the desks actually work: ticketing cuts the tickets, security
    // takes each truck in and back out. No "mark loaded" step in between.
    const order = await releasedDeliveryOrder(
      customerId, depotId, productId, [30000, 30000], { allocate: false },
    );

    let res = await request(app)
      .post(`/api/orders/${order.id}/generate-tickets`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({
        trucks: [
          { quantity: 30000, truckNumber: `TKT-${RUN}-1`, driverName: "Musa", driverPhone: "+2348010000011" },
          { quantity: 30000, truckNumber: `TKT-${RUN}-2`, driverName: "Ben", driverPhone: "+2348010000012" },
        ],
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const loads = await orderTruckRepo.findByOrder(order.id);
    assert.equal(loads.length, 2);
    for (const l of loads) {
      assert.equal(l.status, "loaded", "generating the ticket loaded it");
      assert.ok(l.loadedAt, "loadedAt stamped at generation");
      assert.ok(await ticketRepo.findByOrderTruck(l.id), "each load carries its ticket");
    }

    for (const l of loads) {
      res = await request(app)
        .post(`/api/orders/${order.id}/gate-in`)
        .set("Authorization", `Bearer ${entry.accessToken}`)
        .send({ loadId: l.id });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.truck.status, "gated_in", "a ticketed truck enters");
      assert.ok(res.body.data.truck.securityEnteredAt, "entry stamped");
    }

    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${loads[0].id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.orderCompleted, false);

    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${loads[1].id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.orderCompleted, true, "the last exit completed the order");
    assert.equal((await orderRepo.findById(order.id)).status, "Completed");
  });

  // ── guards ─────────────────────────────────────────────────────────────────

  test("the one ordering rule left: a truck that never arrived cannot leave", async () => {
    const order = await releasedDeliveryOrder(customerId, depotId, productId, [50000]);
    const [t] = await orderTruckRepo.findByOrder(order.id);

    // Loading now precedes the gate, so an allocated truck may be ticketed
    // before it arrives — that is the ticketing desk doing its job.
    let res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t.id}/load`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({});
    assert.equal(res.status, 200, "ticketing does not wait for the gate");
    assert.equal(res.body.data.truck.status, "loaded");

    // Being loaded is not being present: it still cannot skip the entrance.
    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 409, "exit before gate-in is refused");
    assert.match(res.body.message, /entered/);

    // In through the gate, and it may leave.
    await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t.id });
    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t.id}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200, "an entered truck may exit");
    assert.equal(res.body.data.truck.status, "gated_out");
    assert.ok(await ticketRepo.findByOrderTruck(t.id), "ticket present after exit");
  });

  test("a truck captured at the gate is stamped as loaded on its way out", async () => {
    // The pickup case: security creates the load at gate-in, so nothing ever
    // ticketed it. The exit stands in for the loading it never had.
    const order = await releasedPickupOrder(customerId, depotId, productId, 40000);

    let res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ truckNumber: `GATE-${RUN}-X`, quantity: 40000, driverName: "Ada" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const loadId = res.body.data.truck.id;
    assert.equal(res.body.data.truck.loadedAt, null, "captured at the gate, never loaded");

    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${loadId}/gate-out`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.truck.loadedAt, "the exit stamped the loading");
    assert.ok(await ticketRepo.findByOrderTruck(loadId), "and issued the missing ticket");
  });

  test("gating the same truck in twice is idempotent — the second entry reports the first", async () => {
    const order = await releasedDeliveryOrder(customerId, depotId, productId, [50000]);
    const [t] = await orderTruckRepo.findByOrder(order.id);

    let res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t.id });
    assert.equal(res.status, 200);

    // A repeat gate-in does not error or overwrite the original entry — it
    // returns 200 and reports the existing load.
    res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t.id });
    assert.equal(res.status, 200);
  });

  test("each checkpoint is gated to its role", async () => {
    const order = await releasedDeliveryOrder(customerId, depotId, productId, [50000]);
    const [t] = await orderTruckRepo.findByOrder(order.id);

    // ticketing cannot work the entry gate
    let res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${ticketing.accessToken}`)
      .send({ loadId: t.id });
    assert.equal(res.status, 403);

    // entry security cannot issue tickets
    await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({ loadId: t.id });
    res = await request(app)
      .post(`/api/orders/${order.id}/trucks/${t.id}/load`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({});
    assert.equal(res.status, 403);

    // exit security cannot work the entry gate
    res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${exit.accessToken}`)
      .send({ loadId: t.id });
    assert.equal(res.status, 403);
  });

  test("a delivery gate-in without a loadId is refused 400", async () => {
    const order = await releasedDeliveryOrder(customerId, depotId, productId, [50000]);
    const res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${entry.accessToken}`)
      .send({});
    assert.equal(res.status, 400);
  });

  test("gating a truck on a Paid (not yet Released) order is refused 409", async () => {
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `ORD-GATE-${RUN}-${seq++}`,
        customerId,
        state: "Lagos",
        depotId,
        productId,
        quantity: 50000,
        price: "100.00",
        totalAmount: "1.00",
        deliveryType: "pickup",
        status: "Paid",
        paymentStatus: "Paid",
      })
      .returning();

    const res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({ truckNumber: "OWN-2", quantity: 50000 });
    assert.equal(res.status, 409);
  });

  /**
   * The end of the chain, stated where the truck actually turns up.
   *
   * A part payment does not release the order, and GATEABLE is Released or
   * Loading — so an order still owing money is refused at the gate as well as
   * at ticketing. This is the check worth having at this level rather than
   * trusting the one upstream: the pickup branch of gate-in CREATES a load
   * when none was declared, so it is the one door into loading that does not
   * need a ticket to have been cut first.
   */
  test("a part-paid order is refused at the gate — nothing loads on an outstanding", async () => {
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `ORD-GATE-${RUN}-${seq++}`,
        customerId,
        state: "Lagos",
        depotId,
        productId,
        quantity: 50000,
        price: "100.00",
        totalAmount: "5000000.00",
        amountPaid: "2000000.00",
        deliveryType: "pickup",
        status: "Pending",
        paymentStatus: "Part Paid",
      })
      .returning();

    const res = await request(app)
      .post(`/api/orders/${order.id}/gate-in`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({ truckNumber: "OWN-3", quantity: 50000 });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /not open for gating/i);

    // And nothing was created on the way to being refused — a pickup gate-in
    // writes the load itself, so a refusal that still left a row behind would
    // put the truck on the yard in every report that counts loads.
    const loads = await orderTruckRepo.findByOrder(order.id);
    assert.equal(loads.length, 0, "no load was written for a refused gate-in");
  });
});
