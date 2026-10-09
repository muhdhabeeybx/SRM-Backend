// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq, inArray, sql } = require("drizzle-orm");

const app = require("../app");
const { db } = require("../config/db");
const {
  pfis, depots, products, bankAccounts, fleetTrucks, orders, orderTrucks,
  pfiTruckAllocations, deliveryInventory, auditLogs,
} = require("../db/schema");
const { closeDb, staffToken } = require("./helpers");
const { syncFromTrucks } = require("../services/allocationTrucks.service");

/**
 * Trucks added to, changed on or taken off a trucking PFI an allocation made
 * carry through to its order on the cargo, the cargo's stock, the trucking
 * PFI's own figures and the allocation — PFI-47D, 9 October 2026, had 13
 * trucks added that reached none of them.
 */
const RUN = Date.now();
const SERIAL = String(400000 + (RUN % 290000));
const PARENT_NAME = `PFI/${SERIAL}/26/SYNC CARGO/${RUN}`;
const CODE = `PFI-${SERIAL}B`;

let admin;
let depot;
let product;
let parent;
let account;
const trucks = [];
let order;
let sub;
let alloc;

const as = (token) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
  patch: (url, body = {}) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
  del: (url) => request(app).delete(url).set("Authorization", `Bearer ${token}`),
});

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const loadsOf = async () => db.select().from(orderTrucks).where(eq(orderTrucks.orderId, order.id));
const inventory = async () => db.select().from(deliveryInventory).where(eq(deliveryInventory.allocationCode, CODE));

/** Everything that must agree, read fresh. */
const state = async () => {
  const o = await row(orders, order.id);
  const p = await row(pfis, parent.id);
  const s = await row(pfis, sub.id);
  const a = await row(pfiTruckAllocations, alloc.id);
  const loads = await loadsOf();
  return { o, p, s, a, loads };
};

describe("an allocation's trucking PFI — its trucks carry through to its order", () => {
  before(async () => {
    admin = await staffToken(request, app);

    [depot] = await db.insert(depots).values({
      name: `Sync Depot ${RUN}`, code: `SD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS ${RUN}`, sku: `SY${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    [parent] = await db.insert(pfis).values({
      pfiNumber: PARENT_NAME, pfiType: "coastal", status: "active",
      locationId: depot.id, locationName: depot.name, productId: product.id, productName: product.name,
      startingQtyLitres: 200000, soldQtyLitres: 0,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `SYNC TEST ${RUN}`, accountNumber: `6${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [parent.id],
    }).returning();
    for (const [i, cap] of [[1, 45000], [2, 33000], [3, 50000], [4, 50000]]) {
      const [t] = await db.insert(fleetTrucks).values({
        plateNumber: `S${i}${String(RUN).slice(-7)}`, maxCapacity: cap,
      }).returning();
      trucks.push(t);
    }

    // Raised, approved, started — the state PFI-47D was in.
    const raised = await as(admin).post(`/api/pfis/${parent.id}/allocations`, {
      loadingDate: today, price: 925,
      trucks: [{ truckId: trucks[0].id, loadedQty: 45000 }, { truckId: trucks[1].id, loadedQty: 33000 }],
    });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const approved = await as(admin).post(`/api/pfis/allocations/${raised.body.data.allocation.id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    alloc = approved.body.data.allocation;
    order = await row(orders, alloc.orderId);
    sub = await row(pfis, alloc.subPfiId);
    const started = await as(admin).post(`/api/pfis/${sub.id}/activate`, {
      bankAccountIds: [account.id], officers: { auditOfficerId: 1, salesManagerId: 1 },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
  });

  after(async () => {
    try {
      await db.delete(deliveryInventory).where(eq(deliveryInventory.allocationCode, CODE));
      await db.delete(pfiTruckAllocations).where(eq(pfiTruckAllocations.parentPfiId, parent.id));
      await db.delete(orderTrucks).where(eq(orderTrucks.orderId, order.id));
      await db.execute(sql`DELETE FROM order_pfi_allocations WHERE order_id = ${order.id}`);
      await db.delete(orders).where(eq(orders.id, order.id));
      await db.execute(sql`DELETE FROM expense_categories WHERE pfi_id IN (${sub.id}, ${parent.id})`).catch(() => {});
      await db.delete(pfis).where(inArray(pfis.id, [sub.id, parent.id]));
      await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
      await db.delete(fleetTrucks).where(inArray(fleetTrucks.id, trucks.map((t) => t.id)));
      await db.delete(depots).where(eq(depots.id, depot.id));
      await db.delete(products).where(eq(products.id, product.id));
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  test("starts in step: 78,000 over 2 trucks everywhere", async () => {
    const { o, p, s, loads } = await state();
    assert.equal(o.quantity, 78000);
    assert.equal(p.soldQtyLitres, 78000);
    assert.equal(s.startingQtyLitres, 78000);
    assert.equal(s.soldQtyLitres, 78000);
    assert.equal(loads.length, 2);
    assert.equal((await inventory()).length, 2);
  });

  let added;

  test("a truck added to the trucking PFI goes onto the order and off the cargo", async () => {
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE, truckId: trucks[2].id, quantityAllocated: 40000, dateAllocated: today,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    added = res.body.data.inventoryRecord;
    assert.equal(added.pfiId, sub.id);
    assert.ok(!/undefined/.test(added.createdBy), `created by a name, not "${added.createdBy}"`);

    const { o, p, s, a, loads } = await state();
    assert.equal(o.quantity, 118000, "the order grows by the truck");
    assert.equal(Number(o.totalAmount), 118000 * 925, "valued at the order's rate");
    assert.equal(Number(o.creditQty), 118000, "still wholly on credit, so every litre can be ticketed");
    assert.equal(o.expectedTrucks, 3);
    assert.equal(o.paymentStatus, "Unpaid");
    assert.equal(p.soldQtyLitres, 118000, "the cargo gives up the litres");
    assert.equal(s.startingQtyLitres, 118000);
    assert.equal(s.soldQtyLitres, 118000);
    assert.equal(s.ticketCount, 3);
    assert.equal(a.quantity, 118000);
    assert.equal(a.trucks.length, 3);

    const load = loads.find((l) => l.truckId === trucks[2].id);
    assert.ok(load, "the truck is a load the desk can ticket");
    assert.equal(load.status, "pending");
    assert.equal(Number(load.quantity), 40000);
    assert.equal(load.truckNumber, trucks[2].plateNumber);

    const [audit] = await db.select().from(auditLogs).where(sql`${auditLogs.entityType} = 'pfi'
      AND ${auditLogs.entityId} = ${sub.id} AND ${auditLogs.action} = 'pfi.allocation_trucks_changed'`);
    assert.ok(audit, "the change is on the trucking PFI's record");
  });

  test("the finance report shows the new value, on credit", async () => {
    const res = await as(admin).get(`/api/finance-report?pfiId=${parent.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const listed = res.body.data.orders.find((x) => x.id === order.id);
    assert.ok(listed);
    assert.equal(listed.onCredit, true);
    assert.equal(res.body.data.totals.totalOnCredit, 118000 * 925);
  });

  test("a truck's litres changed on the batch change its load", async () => {
    const res = await as(admin).patch(`/api/delivery-inventory/${added.id}`, { quantityAllocated: 30000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { o, p, s, loads } = await state();
    assert.equal(o.quantity, 108000);
    assert.equal(p.soldQtyLitres, 108000, "the 10,000 go back to the cargo");
    assert.equal(s.startingQtyLitres, 108000);
    assert.equal(Number(loads.find((l) => l.truckId === trucks[2].id).quantity), 30000);
  });

  test("an edit that is not about litres or trucks leaves the order alone", async () => {
    const before = (await row(orders, order.id)).updatedAt;
    const res = await as(admin).patch(`/api/delivery-inventory/${added.id}`, { notes: "Driver called" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await row(orders, order.id)).updatedAt.getTime(), before.getTime());
  });

  test("a ticketed truck's litres cannot change, and the edit is not made", async () => {
    const [aRow] = (await inventory()).filter((r) => r.truckId === trucks[0].id);
    const aLoad = (await loadsOf()).find((l) => l.truckId === trucks[0].id);
    await db.update(orderTrucks).set({ status: "gated_out" }).where(eq(orderTrucks.id, aLoad.id));

    const res = await as(admin).patch(`/api/delivery-inventory/${aRow.id}`, { quantityAllocated: 40000 });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /already been ticketed/);
    assert.equal((await row(deliveryInventory, aRow.id)).quantityAllocated, 45000, "the inventory edit rolled back");
    assert.equal((await row(orders, order.id)).quantity, 108000);
  });

  test("the cargo refuses a truck it does not have the litres for", async () => {
    // 200,000 − 108,000 = 92,000 left; take it down to 10,000.
    await db.update(pfis).set({ soldQtyLitres: 190000 }).where(eq(pfis.id, parent.id));
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE, truckId: trucks[3].id, quantityAllocated: 20000,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /has 10,000 left, not the 20,000/);
    assert.equal((await inventory()).length, 3, "the truck was not added");
    await db.update(pfis).set({ soldQtyLitres: 108000 }).where(eq(pfis.id, parent.id));
  });

  test("trucks that went on before any of this are brought into step by a sync", async () => {
    // As on PFI-47D: written to the inventory with nothing following.
    const [d] = await db.insert(deliveryInventory).values({
      pfiId: sub.id, allocationCode: CODE, truckId: trucks[3].id, truckNumber: trucks[3].plateNumber,
      quantityAllocated: 20000, loadingStatus: "loaded",
    }).returning();
    assert.equal((await row(orders, order.id)).quantity, 108000, "nothing followed the raw write");

    const result = await db.transaction((tx) => syncFromTrucks(sub.id, { tx, actor: { type: "staff", staffId: 1 } }));
    assert.deepEqual(result.added.map((a) => a.quantity), [20000]);
    const { o, p, s } = await state();
    assert.equal(o.quantity, 128000);
    assert.equal(p.soldQtyLitres, 128000);
    assert.equal(s.startingQtyLitres, 128000);
    assert.equal(
      await db.transaction((tx) => syncFromTrucks(sub.id, { tx, actor: { type: "staff", staffId: 1 } })),
      null,
      "a second run finds nothing to do",
    );

    const res = await as(admin).del(`/api/delivery-inventory/${d.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await row(orders, order.id)).quantity, 108000);
  });

  test("a truck taken off the batch comes off the order and its litres go back", async () => {
    const res = await as(admin).del(`/api/delivery-inventory/${added.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { o, p, s, a, loads } = await state();
    assert.equal(o.quantity, 78000);
    assert.equal(o.expectedTrucks, 2);
    assert.equal(p.soldQtyLitres, 78000);
    assert.equal(s.startingQtyLitres, 78000);
    assert.equal(s.ticketCount, 2);
    assert.equal(a.trucks.length, 2);
    assert.ok(!loads.some((l) => l.truckId === trucks[2].id));
  });

  test("the PFI form cannot type a quantity the trucks do not hold", async () => {
    const refused = await as(admin).patch(`/api/pfis/${sub.id}`, { startingQtyLitres: 90000 });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.message, /come from its trucks/);
    // The form sends both on every save; unchanged, they pass.
    const same = await as(admin).patch(`/api/pfis/${sub.id}`, { startingQtyLitres: 78000, ticketCount: 2, description: "ok" });
    assert.equal(same.status, 200, JSON.stringify(same.body));
  });

  test("an order that is over takes no more trucks, but other edits still work", async () => {
    await db.update(orders).set({ status: "Completed" }).where(eq(orders.id, order.id));
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE, truckId: trucks[3].id, quantityAllocated: 20000,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /Raise a new allocation/);

    const [bRow] = (await inventory()).filter((r) => r.truckId === trucks[1].id);
    const ok = await as(admin).patch(`/api/delivery-inventory/${bRow.id}`, { customerName: "Walk-in" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});
