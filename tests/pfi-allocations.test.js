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
  pfiTruckAllocations, deliveryInventory, deliverySales, deliveryCustomers,
} = require("../db/schema");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");
const orderService = require("../services/order.service");

/**
 * Trucks allocated off a cargo, approved, become an order on the cargo and a
 * lettered trucking PFI. Everything the flow promises is asserted here: the
 * letter it takes, that nothing moves until an admin approves, that approval
 * makes exactly one order and one PFI however often it is pressed, that the
 * litres leave the cargo once and land on the trucking PFI once, and that the
 * order cannot quietly hand them back — by lapsing, or by being cancelled
 * while the trucking PFI still holds them.
 */
const API = "/api/pfis";
const RUN = Date.now();
// A serial nobody else in the test database uses, so the family is ours.
const SERIAL = String(700000 + (RUN % 290000));
const PARENT_NAME = `PFI/${SERIAL}/26/TEST CARGO/${RUN}`;
// A delivery batch beside it, for litres allocated straight to a station.
const DELIVERY_SERIAL = String(Number(SERIAL) + 1);
const DELIVERY_NAME = `PFI/${DELIVERY_SERIAL}/26/TEST DELIVERY/${RUN}`;

let admin;      // super_admin + admin
let desk;       // raises, cannot approve
let deskStaff;
let depot;
let product;
let parent;
let account;
let truckA;
let truckB;
let driver;
let deliveryParent;
let station;
const extraPfiIds = [];

const as = (token) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
});

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

const parentRow = async () => (await db.select().from(pfis).where(eq(pfis.id, parent.id)))[0];

describe("truck allocations — off a cargo, approved into an order and a lettered PFI", () => {
  before(async () => {
    admin = await staffToken(request, app);
    const d = await staffTokenWithRoles(["truck_sales"], `alloc-desk-${RUN}@soroman.test`);
    desk = d.accessToken;
    deskStaff = d.staff;

    [depot] = await db.insert(depots).values({
      name: `Alloc Depot ${RUN}`, code: `AD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS ${RUN}`, sku: `AS${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    [parent] = await db.insert(pfis).values({
      pfiNumber: PARENT_NAME, pfiType: "coastal", status: "active",
      locationId: depot.id, locationName: depot.name, productId: product.id, productName: product.name,
      startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `ALLOC TEST ${RUN}`, accountNumber: `7${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [parent.id],
    }).returning();
    [driver] = await db.insert(drivers).values({
      name: `Driver ${RUN}`, phone: `0803${String(RUN).slice(-7)}`, licenseNumber: `LIC${RUN}`, licenseClass: "C",
    }).returning();
    [truckA] = await db.insert(fleetTrucks).values({
      plateNumber: `AL${String(RUN).slice(-8)}`, maxCapacity: 45000, driverId: driver.id,
    }).returning();
    [truckB] = await db.insert(fleetTrucks).values({
      plateNumber: `BL${String(RUN).slice(-8)}`, maxCapacity: 33000,
    }).returning();
    [deliveryParent] = await db.insert(pfis).values({
      pfiNumber: DELIVERY_NAME, pfiType: "delivery", status: "active",
      locationId: depot.id, locationName: depot.name, productId: product.id, productName: product.name,
      startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    [station] = await db.insert(deliveryCustomers).values({
      customerType: "filling_station", name: `Alloc Station ${RUN}`, phoneNumber: `0806${String(RUN).slice(-7)}`,
    }).returning();
  });

  after(async () => {
    try {
      const parentIds = [parent.id, deliveryParent.id];
      const allocs = await db.select().from(pfiTruckAllocations).where(inArray(pfiTruckAllocations.parentPfiId, parentIds));
      const orderIds = allocs.map((a) => a.orderId).filter(Boolean);
      const subIds = allocs.map((a) => a.subPfiId).filter(Boolean);
      await db.delete(pfiTruckAllocations).where(inArray(pfiTruckAllocations.parentPfiId, parentIds));
      for (const serial of [SERIAL, DELIVERY_SERIAL]) {
        await db.delete(deliverySales).where(sql`${deliverySales.allocationCode} LIKE ${`PFI-${serial}%`}`);
        await db.delete(deliveryInventory).where(sql`${deliveryInventory.allocationCode} LIKE ${`PFI-${serial}%`}`);
      }
      if (orderIds.length) {
        await db.delete(orderTrucks).where(inArray(orderTrucks.orderId, orderIds));
        await db.execute(sql`DELETE FROM order_pfi_allocations WHERE order_id IN ${sql`(${sql.join(orderIds.map((i) => sql`${i}`), sql`, `)})`}`);
        await db.delete(orders).where(inArray(orders.id, orderIds));
      }
      const pfiIds = [...subIds, ...extraPfiIds, parent.id, deliveryParent.id];
      await db.execute(sql`DELETE FROM expense_categories WHERE pfi_id IN ${sql`(${sql.join(pfiIds.map((i) => sql`${i}`), sql`, `)})`}`).catch(() => {});
      await db.delete(pfis).where(inArray(pfis.id, pfiIds));
      await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
      await db.delete(fleetTrucks).where(inArray(fleetTrucks.id, [truckA.id, truckB.id]));
      await db.delete(drivers).where(eq(drivers.id, driver.id));
      await db.delete(deliveryCustomers).where(eq(deliveryCustomers.id, station.id));
      await db.delete(depots).where(eq(depots.id, depot.id));
      await db.delete(products).where(eq(products.id, product.id));
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  const raiseBody = (overrides = {}) => ({
    loadingDate: today,
    price: 925,
    trucks: [
      { truckId: truckA.id, loadedQty: 45000 },
      { truckId: truckB.id, loadedQty: 33000 },
    ],
    note: "Calabar run",
    ...overrides,
  });

  let first;   // the B allocation

  test("the form is told the next letter, the name, and what is left", async () => {
    const res = await as(desk).get(`${API}/${parent.id}/allocations`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { form, canApprove } = res.body.data;
    assert.equal(canApprove, false, "a truck sales desk cannot approve");
    assert.equal(form.problem, null);
    assert.equal(form.next.letter, "B");
    assert.equal(form.next.pfiNumber, `PFI/${SERIAL}B/26/TEST CARGO/${RUN}`);
    assert.equal(form.next.allocationCode, `PFI-${SERIAL}B`);
    assert.equal(form.available, 100000);
  });

  test("raising takes the letter and moves nothing", async () => {
    const res = await as(desk).post(`${API}/${parent.id}/allocations`, raiseBody());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    first = res.body.data.allocation;
    assert.equal(first.status, "pending");
    assert.equal(first.suffix, "B");
    assert.equal(first.quantity, 78000);
    assert.equal(first.pricePerUnit, 925);
    assert.equal(first.raisedBy, deskStaff.id);
    // The drivers come from the register, not the request.
    const a = first.trucks.find((t) => t.truckId === truckA.id);
    assert.equal(a.driverName, driver.name);
    assert.equal(a.plateNumber, truckA.plateNumber);

    const p = await parentRow();
    assert.equal(p.soldQtyLitres, 0, "nothing leaves the cargo until approval");
    const made = await db.select().from(pfis).where(eq(pfis.pfiNumber, first.pfiNumber));
    assert.equal(made.length, 0, "no PFI until approval");
  });

  test("a second request cannot ask for what the first is already holding", async () => {
    const res = await as(desk).post(`${API}/${parent.id}/allocations`, raiseBody({
      trucks: [{ truckId: truckA.id, loadedQty: 23000 }],
    }));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /22,000 left to allocate/);
    assert.match(res.body.message, /78,000 is already waiting/);
  });

  test("a truck loaded past what it holds is refused", async () => {
    const res = await as(desk).post(`${API}/${parent.id}/allocations`, raiseBody({
      trucks: [{ truckId: truckB.id, loadedQty: 34000 }],
    }));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /holds 33,000/);
  });

  test("the next letter skips one the family already holds, whatever raised it", async () => {
    // A hand-named trucking batch from before, holding C.
    const [old] = await db.insert(pfis).values({
      pfiNumber: `PFI ${SERIAL}C`, pfiType: "trucking", status: "finished", allocationCode: `PFI-${SERIAL}C`,
    }).returning();
    extraPfiIds.push(old.id);

    const res = await as(desk).get(`${API}/${parent.id}/allocations`);
    assert.equal(res.body.data.form.next.letter, "D", "B is pending, C is taken");
    assert.equal(res.body.data.form.available, 22000);
  });

  test("only an admin or super admin may approve", async () => {
    const res = await as(desk).post(`${API}/allocations/${first.id}/approve`);
    assert.equal(res.status, 403);
  });

  let order;
  let sub;

  test("approval places the order on the cargo and raises the trucking PFI", async () => {
    const res = await as(admin).post(`${API}/allocations/${first.id}/approve`, { note: "Checked with ops" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const approved = res.body.data.allocation;
    assert.equal(approved.status, "approved");
    assert.ok(approved.orderId && approved.subPfiId);

    [order] = await db.select().from(orders).where(eq(orders.id, approved.orderId));
    assert.equal(order.pfiId, parent.id, "sold from the cargo the trucks came off");
    assert.equal(order.quantity, 78000);
    assert.equal(Number(order.price), 925, "at the approved price, not the board price");
    assert.equal(order.deliveryType, "delivery");
    assert.equal(order.status, "Pending", "a normal order: it waits for its payment");
    assert.equal(order.paymentStatus, "Unpaid");
    assert.equal(order.expectedTrucks, 2);

    const [house] = await db.select().from(customers).where(eq(customers.id, order.customerId));
    assert.equal(house.houseAccount, "trucking");

    const loads = await db.select().from(orderTrucks).where(eq(orderTrucks.orderId, order.id));
    assert.equal(loads.length, 2, "the trucks are on the order from the start");
    assert.deepEqual(loads.map((l) => l.truckId).sort(), [truckA.id, truckB.id].sort());
    assert.ok(loads.every((l) => l.status === "pending"));

    const p = await parentRow();
    assert.equal(p.soldQtyLitres, 78000, "the litres left the cargo through the order");

    [sub] = await db.select().from(pfis).where(eq(pfis.id, approved.subPfiId));
    assert.equal(sub.pfiNumber, `PFI/${SERIAL}B/26/TEST CARGO/${RUN}`);
    assert.equal(sub.pfiType, "trucking");
    assert.equal(sub.status, "not_started", "it goes to review for its bank and officers");
    assert.equal(sub.parentPfiId, parent.id);
    assert.equal(sub.startingQtyLitres, 78000, "exactly what the cargo sold");
    assert.equal(sub.soldQtyLitres, 0);
    assert.equal(sub.allocationCode, `PFI-${SERIAL}B`);
    assert.equal(Number(sub.unitPrice), 925);
    assert.equal(sub.raisedBy, deskStaff.id, "raised by whoever allocated the trucks");
    assert.equal(sub.pendingBatch.trucks.length, 2);
  });

  test("approving again changes nothing", async () => {
    const res = await as(admin).post(`${API}/allocations/${first.id}/approve`);
    assert.equal(res.status, 200);
    const onParent = await db.select().from(orders).where(eq(orders.pfiId, parent.id));
    assert.equal(onParent.length, 1, "one order, however often it is pressed");
    const subs = await db.select().from(pfis).where(eq(pfis.parentPfiId, parent.id));
    assert.equal(subs.length, 1);
    assert.equal((await parentRow()).soldQtyLitres, 78000);
  });

  test("the order never lapses unpaid", async () => {
    const yesterday = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const aged = { ...order, createdAt: yesterday };
    assert.equal(orderService.isOrderExpired(aged), false);
    assert.equal(orderService.computeExpiresAt(aged), null);
  });

  test("the order cannot be cancelled while the trucking PFI holds its litres", async () => {
    const res = await as(admin).post(`/api/orders/${order.id}/cancel`, { reason: "test" });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /delete .* first/i);
    assert.equal((await parentRow()).soldQtyLitres, 78000);
  });

  test("the trucking PFI's own review writes its trucks to the inventory", async () => {
    const res = await as(admin).post(`${API}/${sub.id}/activate`, {
      bankAccountIds: [account.id],
      officers: { auditOfficerId: deskStaff.id, salesManagerId: deskStaff.id },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await db.select().from(deliveryInventory).where(eq(deliveryInventory.allocationCode, `PFI-${SERIAL}B`));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.pfiId === sub.id));
  });

  test("the file of each names the other", async () => {
    const parentView = await as(admin).get(`${API}/${parent.id}/allocations`);
    assert.equal(parentView.body.data.allocations.length, 1);
    assert.equal(parentView.body.data.allocations[0].subPfiId, sub.id);
    const subView = await as(admin).get(`${API}/${sub.id}/allocations`);
    assert.equal(subView.body.data.madeBy.parentPfiId, parent.id);
    assert.equal(subView.body.data.form, null, "a batch of trucks is not allocated off");
  });

  let second;

  test("a rejection needs a reason, and frees its letter", async () => {
    const raised = await as(desk).post(`${API}/${parent.id}/allocations`, raiseBody({
      trucks: [{ truckId: truckB.id, loadedQty: 20000 }],
    }));
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    second = raised.body.data.allocation;
    assert.equal(second.suffix, "D");

    const bare = await as(admin).post(`${API}/allocations/${second.id}/reject`);
    assert.equal(bare.status, 400);

    const res = await as(admin).post(`${API}/allocations/${second.id}/reject`, { note: "Wrong truck" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.allocation.status, "rejected");

    const again = await as(desk).get(`${API}/${parent.id}/allocations`);
    assert.equal(again.body.data.form.next.letter, "D", "a refused letter is free again");
    assert.equal((await parentRow()).soldQtyLitres, 78000);
  });

  test("whoever raised it can withdraw it; a decided one stays decided", async () => {
    const raised = await as(desk).post(`${API}/${parent.id}/allocations`, raiseBody({
      trucks: [{ truckId: truckB.id, loadedQty: 10000 }],
    }));
    const res = await as(desk).post(`${API}/allocations/${raised.body.data.allocation.id}/withdraw`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.allocation.status, "withdrawn");

    const late = await as(admin).post(`${API}/allocations/${second.id}/approve`);
    assert.equal(late.status, 409, "a rejected request cannot be approved");
  });

  test("the queue lists what is waiting, across cargoes", async () => {
    const raised = await as(desk).post(`${API}/${parent.id}/allocations`, raiseBody({
      trucks: [{ truckId: truckA.id, loadedQty: 5000 }],
    }));
    const res = await as(admin).get(`${API}/allocations?status=pending`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.canApprove, true);
    const mine = res.body.data.allocations.find((a) => a.id === raised.body.data.allocation.id);
    assert.ok(mine, "the new request is in the queue");
    assert.equal(mine.parentPfiNumber, PARENT_NAME);
    assert.equal(mine.locationName, depot.name);
  });

  test("a batch of trucks cannot have trucks allocated off it", async () => {
    const res = await as(desk).post(`${API}/${sub.id}/allocations`, raiseBody());
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not off a batch of trucks/);
  });

  // ── To a station, with no trucks ──────────────────────────────────────────

  const stationBody = (overrides = {}) => ({
    loadingDate: "2026-09-20",
    price: 1265,
    station: { customerId: station.id, quantity: 50000 },
    ...overrides,
  });

  test("litres go to a station only off a batch with no loading desk", async () => {
    const cargo = await as(desk).get(`${API}/${parent.id}/allocations`);
    assert.equal(cargo.body.data.form.stationAllowed, false, "a coastal cargo is loaded onto real trucks");
    assert.deepEqual(cargo.body.data.form.stations, []);
    const refused = await as(desk).post(`${API}/${parent.id}/allocations`, stationBody());
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.message, /allocate the trucks/);

    const delivery = await as(desk).get(`${API}/${deliveryParent.id}/allocations`);
    assert.equal(delivery.body.data.form.stationAllowed, true);
    assert.ok(delivery.body.data.form.stations.some((s) => s.id === station.id), "our station is offered");
  });

  test("a station allocation needs one of our stations and a whole quantity", async () => {
    const notStation = await as(desk).post(`${API}/${deliveryParent.id}/allocations`, stationBody({
      station: { customerId: 0, quantity: 50000 },
    }));
    assert.equal(notStation.status, 400);
    const fraction = await as(desk).post(`${API}/${deliveryParent.id}/allocations`, stationBody({
      station: { customerId: station.id, quantity: 100.5 },
    }));
    assert.equal(fraction.status, 400);
  });

  let toStation;
  let stationSub;

  test("raising to a station names no truck — one DANGOTE DELIVERY load on the station", async () => {
    const res = await as(desk).post(`${API}/${deliveryParent.id}/allocations`, stationBody());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    toStation = res.body.data.allocation;
    assert.equal(toStation.suffix, "B");
    assert.equal(toStation.quantity, 50000);
    assert.equal(toStation.trucks.length, 1);
    const [load] = toStation.trucks;
    assert.equal(load.truckId, null);
    assert.equal(load.plateNumber, "DANGOTE DELIVERY");
    assert.equal(load.driverName, "Dangote Delivery");
    assert.equal(load.customerId, station.id);
    assert.equal(load.customerName, station.name);
  });

  test("approval places a truckless order on the delivery batch and raises its lettered PFI", async () => {
    const res = await as(admin).post(`${API}/allocations/${toStation.id}/approve`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const approved = res.body.data.allocation;

    const [o] = await db.select().from(orders).where(eq(orders.id, approved.orderId));
    assert.equal(o.pfiId, deliveryParent.id);
    assert.equal(o.quantity, 50000);
    assert.equal(Number(o.price), 1265);
    assert.equal(o.companyName, "Dangote Delivery");
    assert.equal(o.expectedTrucks, null);
    assert.match(o.deliveryAddress, new RegExp(station.name));
    const loads = await db.select().from(orderTrucks).where(eq(orderTrucks.orderId, o.id));
    assert.equal(loads.length, 0, "no truck on the order: nobody gates one");

    [stationSub] = await db.select().from(pfis).where(eq(pfis.id, approved.subPfiId));
    assert.equal(stationSub.pfiNumber, `PFI/${DELIVERY_SERIAL}B/26/TEST DELIVERY/${RUN}`);
    assert.equal(stationSub.pfiType, "trucking");
    assert.equal(stationSub.startingQtyLitres, 50000);
    assert.match(stationSub.description, new RegExp(station.name));
    assert.equal(stationSub.pendingBatch.trucks[0].customerId, station.id);
  });

  test("Start selling writes the load to the inventory and the sales ledger, on the station", async () => {
    const res = await as(admin).post(`${API}/${stationSub.id}/activate`, {
      bankAccountIds: [account.id],
      officers: { auditOfficerId: deskStaff.id, salesManagerId: deskStaff.id },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.batch.inventoryIds, [], "no driver to tell and no truck sales desk to wake");

    const code = `PFI-${DELIVERY_SERIAL}B`;
    const inventory = await db.select().from(deliveryInventory).where(eq(deliveryInventory.allocationCode, code));
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].pfiId, stationSub.id);
    assert.equal(inventory[0].truckId, null);
    assert.equal(inventory[0].truckNumber, "DANGOTE DELIVERY");
    assert.equal(inventory[0].customerId, station.id);
    assert.equal(inventory[0].customerName, station.name);
    assert.equal(Number(inventory[0].quantityAllocated), 50000);
    assert.equal(inventory[0].dateAllocated, "2026-09-20");

    const ledger = await db.select().from(deliverySales).where(eq(deliverySales.allocationCode, code));
    assert.equal(ledger.length, 1);
    const [row] = ledger;
    assert.equal(row.truckNumber, "DANGOTE DELIVERY");
    assert.equal(row.dateLoaded, "2026-09-20");
    assert.equal(row.customerId, station.id);
    assert.equal(row.location, station.name);
    assert.equal(Number(row.quantity), 50000);
    assert.equal(Number(row.rate), 0, "a station's share waits for the desk's rate");
    assert.equal(Number(row.salesValue), 0);
    assert.equal(row.book, "trucking", "the load is the ledger's, not the station's own entry");

    const [sold] = await db.select().from(pfis).where(eq(pfis.id, stationSub.id));
    assert.equal(sold.soldQtyLitres, 50000, "the litres have left for the station");
  });
});
