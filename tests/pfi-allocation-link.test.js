// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq, inArray, sql } = require("drizzle-orm");

const app = require("../app");
const { db } = require("../config/db");
const {
  pfis, depots, products, bankAccounts, fleetTrucks, drivers, orders, orderTrucks, customers,
  pfiTruckAllocations, deliveryInventory,
} = require("../db/schema");
const { closeDb, staffToken, TEST_STAFF } = require("./helpers");
const { staffRepo } = require("../repositories");
const orderService = require("../services/order.service");

/**
 * Trucks linked to an order already on the cargo, rather than an order placed
 * by the approval: the request names the order, the trucks must carry exactly
 * its litres, the order does not lapse while the request waits, and approval
 * makes that same order the allocation's — moved to SOROMAN TRUCKING, still
 * waiting for its money, with the trucks as its loads — beside the lettered
 * trucking PFI and its trucks on the inventory.
 */
const API = "/api/pfis";
const RUN = Date.now();
const SERIAL = String(400000 + (RUN % 290000));
const PARENT_NAME = `PFI/${SERIAL}/26/LINK CARGO/${RUN}`;

let admin;
let adminStaff;
let depot;
let product;
let parent;
let account;
let truckA;
let truckB;
let driver;
let buyer;
const orderIds = [];

const as = (token) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
});

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

const parentRow = async () => (await db.select().from(pfis).where(eq(pfis.id, parent.id)))[0];
const orderRow = async (id) => (await db.select().from(orders).where(eq(orders.id, id)))[0];

/** An order on the cargo placed the ordinary way, at an agreed price, waiting for payment. */
const placeOnCargo = async (quantity, companyName = "SOROMAN TRUCKS") => {
  const { order } = await orderService.placeOrder({
    customerId: buyer.id,
    state: depot.state,
    depotId: depot.id,
    productId: product.id,
    quantity,
    deliveryType: "pickup",
    companyName,
    actor: { type: "staff", staffId: adminStaff.id },
    pinned: { pfiId: parent.id, price: 900 },
    quiet: true,
  });
  orderIds.push(order.id);
  return order;
};

describe("truck allocations — linked to an order already on the cargo", () => {
  before(async () => {
    admin = await staffToken(request, app);
    adminStaff = await staffRepo.findByEmail(TEST_STAFF.email);

    [depot] = await db.insert(depots).values({
      name: `Link Depot ${RUN}`, code: `LD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS L${RUN}`, sku: `LK${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    [parent] = await db.insert(pfis).values({
      pfiNumber: PARENT_NAME, pfiType: "coastal", status: "active",
      locationId: depot.id, locationName: depot.name, productId: product.id, productName: product.name,
      startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `LINK TEST ${RUN}`, accountNumber: `8${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [parent.id],
    }).returning();
    [driver] = await db.insert(drivers).values({
      name: `Link Driver ${RUN}`, phone: `0809${String(RUN).slice(-7)}`, licenseNumber: `LLIC${RUN}`, licenseClass: "C",
    }).returning();
    [truckA] = await db.insert(fleetTrucks).values({
      plateNumber: `LA${String(RUN).slice(-8)}`, maxCapacity: 45000, driverId: driver.id,
    }).returning();
    [truckB] = await db.insert(fleetTrucks).values({
      plateNumber: `LB${String(RUN).slice(-8)}`, maxCapacity: 33000,
    }).returning();
    [buyer] = await db.insert(customers).values({
      name: `Link Buyer ${RUN}`, companyName: "SOROMAN TRUCKS", phone: `+234807${String(RUN).slice(-7)}`, email: "",
      status: "Active",
    }).returning();
  });

  after(async () => {
    try {
      const allocs = await db.select().from(pfiTruckAllocations).where(eq(pfiTruckAllocations.parentPfiId, parent.id));
      const subIds = allocs.map((a) => a.subPfiId).filter(Boolean);
      await db.delete(pfiTruckAllocations).where(eq(pfiTruckAllocations.parentPfiId, parent.id));
      await db.delete(deliveryInventory).where(sql`${deliveryInventory.allocationCode} LIKE ${`PFI-${SERIAL}%`}`);
      if (orderIds.length) {
        const idList = sql`(${sql.join(orderIds.map((i) => sql`${i}`), sql`, `)})`;
        await db.delete(orderTrucks).where(inArray(orderTrucks.orderId, orderIds));
        await db.execute(sql`DELETE FROM order_pfi_allocations WHERE order_id IN ${idList}`);
        await db.execute(sql`DELETE FROM pfi_movements WHERE order_id IN ${idList}`).catch(() => {});
        await db.execute(sql`DELETE FROM audit_logs WHERE entity_type IN ('order', 'order_truck') AND (entity_id IN ${idList} OR metadata->>'orderId' IN (${sql.join(orderIds.map((i) => sql`${String(i)}`), sql`, `)}))`).catch(() => {});
        await db.delete(orders).where(inArray(orders.id, orderIds));
      }
      const pfiIds = [...subIds, parent.id];
      await db.execute(sql`DELETE FROM expense_categories WHERE pfi_id IN ${sql`(${sql.join(pfiIds.map((i) => sql`${i}`), sql`, `)})`}`).catch(() => {});
      await db.delete(pfis).where(inArray(pfis.id, pfiIds));
      await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
      await db.delete(fleetTrucks).where(inArray(fleetTrucks.id, [truckA.id, truckB.id]));
      await db.delete(drivers).where(eq(drivers.id, driver.id));
      await db.delete(customers).where(eq(customers.id, buyer.id));
      await db.delete(depots).where(eq(depots.id, depot.id));
      await db.delete(products).where(eq(products.id, product.id));
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  let order;   // the order on the cargo, 78,000 at 900
  let link;    // the request linking it

  const linkBody = (overrides = {}) => ({
    loadingDate: today,
    orderId: order.id,
    trucks: [
      { truckId: truckA.id, loadedQty: 45000 },
      { truckId: truckB.id, loadedQty: 33000 },
    ],
    ...overrides,
  });

  test("the form offers the cargo's orders, with what each will read as once linked", async () => {
    order = await placeOnCargo(78000);
    assert.equal((await parentRow()).soldQtyLitres, 78000, "the order took its litres when placed");

    const res = await as(admin).get(`${API}/${parent.id}/allocations`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { form } = res.body.data;
    const offered = form.orders.find((o) => o.id === order.id);
    assert.ok(offered, "the order is offered");
    assert.equal(offered.problem, null);
    assert.equal(offered.quantity, 78000);
    assert.equal(offered.price, 900);
    assert.equal(offered.referenceAfter, `SN${order.id}`, "SOROMAN NIGERIA LIMITED (PFI …B)");
    assert.equal(form.houseName, "SOROMAN TRUCKING");
  });

  test("the trucks must carry exactly the order's litres", async () => {
    const res = await as(admin).post(`${API}/${parent.id}/allocations`, linkBody({
      trucks: [{ truckId: truckA.id, loadedQty: 45000 }],
    }));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /carry 45,000 and .* is for 78,000/);
  });

  test("raising names the order, takes its rate, and asks nothing more of the cargo", async () => {
    const res = await as(admin).post(`${API}/${parent.id}/allocations`, linkBody());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    link = res.body.data.allocation;
    assert.equal(link.status, "pending");
    assert.equal(link.orderId, order.id);
    assert.equal(link.pricePerUnit, 900, "the order's rate, nothing typed");
    assert.equal(link.quantity, 78000);
    assert.equal(link.linkedOrder, true);

    const form = (await as(admin).get(`${API}/${parent.id}/allocations`)).body.data.form;
    assert.equal(form.pendingQty, 0, "its litres left the cargo with the order");
    assert.equal(form.available, 22000);
    assert.match(form.orders.find((o) => o.id === order.id).problem, /already waiting to become/);

    const o = await orderRow(order.id);
    assert.equal(o.customerId, buyer.id, "nothing moves until approval");
  });

  test("a second request cannot name the same order", async () => {
    const res = await as(admin).post(`${API}/${parent.id}/allocations`, linkBody());
    assert.equal(res.status, 409);
    assert.match(res.body.message, /already waiting to become/);
  });

  test("while the request waits, the order does not lapse", async () => {
    const yesterday = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await db.update(orders).set({ createdAt: yesterday }).where(eq(orders.id, order.id));
    await orderService.expireStaleOrders();
    const o = await orderRow(order.id);
    assert.equal(o.status, "Pending");
    await assert.rejects(orderService.expireOrder(order.id), /waiting to become/);
  });

  test("approval makes the order the allocation's: SOROMAN TRUCKING, still waiting for its money, the trucks its loads", async () => {
    const res = await as(admin).post(`${API}/allocations/${link.id}/approve`, { note: "linked" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const approved = res.body.data.allocation;
    assert.equal(approved.status, "approved");
    assert.equal(approved.orderId, order.id, "the same order, not a new one");
    assert.ok(approved.subPfiId);
    assert.match(res.body.message, new RegExp(`SN${order.id} is its order now`));

    const o = await orderRow(order.id);
    const [house] = await db.select().from(customers).where(eq(customers.houseAccount, "soroman_trucking"));
    assert.equal(o.customerId, house.id);
    assert.equal(o.companyName, `SOROMAN NIGERIA LIMITED (PFI ${SERIAL}B)`);
    assert.equal(o.idempotencyKey, `pfi-allocation:${link.id}`);
    assert.equal(o.status, "Pending", "not released");
    assert.equal(o.paymentStatus, "Unpaid");
    assert.equal(Number(o.creditQty), 0, "not put on credit");
    assert.equal(Number(o.quantity), 78000);
    assert.equal(Number(o.totalAmount), 78000 * 900);
    assert.equal(Number(o.expectedTrucks), 2);

    const loads = await db.select().from(orderTrucks).where(eq(orderTrucks.orderId, order.id));
    assert.equal(loads.length, 2);
    assert.ok(loads.every((l) => l.status === "pending"));
    assert.deepEqual(loads.map((l) => Number(l.quantity)).sort(), [33000, 45000]);

    assert.equal((await parentRow()).soldQtyLitres, 78000, "the cargo's stock does not move again");

    const [sub] = await db.select().from(pfis).where(eq(pfis.id, approved.subPfiId));
    assert.equal(sub.pfiType, "trucking");
    assert.equal(sub.status, "not_started");
    assert.equal(sub.parentPfiId, parent.id);
    assert.equal(Number(sub.startingQtyLitres), 78000);
    assert.equal(Number(sub.unitPrice), 900);

    const inv = await db.select().from(deliveryInventory).where(eq(deliveryInventory.pfiId, sub.id));
    assert.equal(inv.length, 2, "its trucks are on Delivery Inventory");
    assert.ok(inv.every((r) => r.allocationCode === `PFI-${SERIAL}B`));

    const logs = await db.execute(sql`SELECT metadata FROM audit_logs
      WHERE entity_type = 'order' AND entity_id = ${String(order.id)} AND action = 'order.linked_for_allocation'`);
    const meta = (logs.rows ?? logs)[0]?.metadata;
    assert.ok(meta, "the move is on record");
    assert.equal(meta.from.customerId, buyer.id);
    assert.equal(meta.to.customerId, house.id);
  });

  test("once linked it is an allocation's order: never lapses, and is no longer offered", async () => {
    const o = await orderRow(order.id);
    assert.equal(orderService.isOrderExpired({ ...o, createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) }), false);
    const form = (await as(admin).get(`${API}/${parent.id}/allocations`)).body.data.form;
    assert.equal(form.orders.find((x) => x.id === order.id), undefined);
  });

  test("an order on the audited finance report is never linked", async () => {
    const old = await placeOnCargo(10000);
    await db.update(orders).set({ createdAt: new Date("2026-09-05T10:00:00Z") }).where(eq(orders.id, old.id));
    const form = (await as(admin).get(`${API}/${parent.id}/allocations`)).body.data.form;
    assert.equal(form.orders.find((x) => x.id === old.id), undefined, "not offered");

    const res = await as(admin).post(`${API}/${parent.id}/allocations`, linkBody({
      orderId: old.id,
      trucks: [{ truckId: truckB.id, loadedQty: 10000 }],
    }));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /audited finance report/);
  });
});
