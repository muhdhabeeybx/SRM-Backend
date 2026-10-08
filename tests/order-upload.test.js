// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq, inArray, like } = require("drizzle-orm");

const app = require("../app");
const { db } = require("../config/db");
const { pfis, depots, products, customers, orders, orderPfiAllocations, bankAccounts } = require("../db/schema");
const { orderRepo } = require("../repositories");
const orderService = require("../services/order.service");
const upload = require("../services/orderUpload.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Orders uploaded by staff from a list: placed on one PFI at the list's rate,
 * dated to the list's day, Pending — and never lapsing, because a back-dated
 * order would otherwise lapse the moment it was entered.
 */
const RUN = Date.now();
const tail = String(RUN).slice(-7);
const EXISTING_PHONE = `0803${tail}`;
const NEW_PHONE = `0806${tail}`;

let staff;
let depot;
let product;
let pfi;
let existing;
let account;
let placedIds = [];

const rows = () => [
  { date: "2026-10-06", name: "Musa Bauchi", company: "MB Oil", phone: EXISTING_PHONE, product: "PMS", qty: "45,000", rate: "1,265" },
  { date: "06/10/2026", name: "Ada Obi", company: "Obi Ventures", phone: NEW_PHONE, product: "Petrol", qty: "30000", rate: "1270" },
  { date: "2026-10-07", name: "Ada Obi", company: "Obi Ventures", phone: NEW_PHONE, product: "petrol", qty: "10000", rate: "1270" },
  { date: "31/02/2026", name: "Bad Date", company: "", phone: NEW_PHONE, product: "PMS", qty: "1000", rate: "1265" },
  { date: "2026-10-06", name: "Wrong Product", company: "", phone: NEW_PHONE, product: "AGO", qty: "1000", rate: "1265" },
  { date: "2099-01-01", name: "Future", company: "", phone: NEW_PHONE, product: "PMS", qty: "1000", rate: "1265" },
];

describe("orders uploaded from a list", () => {
  before(async () => {
    staff = (await staffTokenWithRoles(["admin"], `upload-${RUN}@soroman.test`)).staff;
    [depot] = await db.insert(depots).values({
      name: `Upload Depot ${RUN}`, code: `UD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS ${RUN}`, sku: `UP${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    [pfi] = await db.insert(pfis).values({
      pfiNumber: `PFI/UPLOAD/${RUN}`, pfiType: "coastal", status: "active",
      locationId: depot.id, locationName: depot.name, productId: product.id, productName: product.name,
      startingQtyLitres: 100000, soldQtyLitres: 0,
    }).returning();
    // Every order is placed against a payment account at its depot.
    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `UPLOAD TEST ${RUN}`, accountNumber: `8${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [pfi.id],
    }).returning();
    [existing] = await db.insert(customers).values({
      name: "Musa Bauchi", phone: `+234${EXISTING_PHONE.slice(1)}`, email: "", companyName: "MB Oil",
    }).returning();
  });

  after(async () => {
    try {
      const made = await db.select({ id: orders.id, customerId: orders.customerId }).from(orders).where(eq(orders.pfiId, pfi.id));
      const ids = made.map((o) => o.id);
      if (ids.length) {
        await db.delete(orderPfiAllocations).where(inArray(orderPfiAllocations.orderId, ids));
        await db.delete(orders).where(inArray(orders.id, ids));
      }
      await db.delete(customers).where(inArray(customers.phone, [`+234${EXISTING_PHONE.slice(1)}`, `+234${NEW_PHONE.slice(1)}`]));
      await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
      await db.delete(pfis).where(eq(pfis.id, pfi.id));
      await db.delete(depots).where(eq(depots.id, depot.id));
      await db.delete(products).where(eq(products.id, product.id));
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  test("the plan says what would happen, row by row, and writes nothing", async () => {
    const p = await upload.plan({ pfiId: pfi.id, rows: rows() });
    assert.equal(p.summary.toPlace, 3);
    assert.equal(p.summary.refused, 3);
    assert.equal(p.summary.newCustomers, 1, "the new phone twice is one customer");
    assert.equal(p.summary.quantity, 85000);

    const [first, second, third, badDate, wrongProduct, future] = p.rows;
    assert.equal(first.customer.existing, true);
    assert.equal(first.customer.id, existing.id, "matched on the phone, however it is written");
    assert.equal(first.qty, 45000, "commas read as thousands");
    assert.equal(second.day, "2026-10-06", "day first, as the desk writes it");
    assert.equal(second.customer.existing, false);
    assert.equal(third.day, "2026-10-07");
    assert.match(badDate.problems.join(), /not a day/);
    assert.match(wrongProduct.problems.join(), /is not PMS/);
    assert.match(future.problems.join(), /future/);

    const placed = await db.select().from(orders).where(eq(orders.pfiId, pfi.id));
    assert.equal(placed.length, 0, "a plan places nothing");
  });

  test("applying places Pending orders on the PFI at the list's rate, dated to the list's day", async () => {
    const out = await upload.apply({ pfiId: pfi.id, rows: rows(), staffId: staff.id });
    const placed = out.results.filter((r) => r.outcome === "placed");
    assert.equal(placed.length, 3, JSON.stringify(out.results));
    assert.equal(out.results.filter((r) => r.outcome === "refused").length, 3);
    placedIds = placed.map((r) => r.orderId);

    const rowsOut = await db.select().from(orders).where(inArray(orders.id, placedIds));
    const byQty = Object.fromEntries(rowsOut.map((o) => [o.quantity, o]));
    const musa = byQty[45000];
    assert.equal(musa.customerId, existing.id);
    assert.equal(Number(musa.price), 1265);
    assert.equal(Number(musa.totalAmount), 45000 * 1265);
    assert.equal(musa.status, "Pending");
    assert.equal(musa.paymentStatus, "Unpaid");
    assert.equal(musa.pfiId, pfi.id);
    assert.equal(musa.companyName, "MB Oil");
    assert.equal(new Date(musa.createdAt).toISOString(), "2026-10-06T11:00:00.000Z", "noon in Lagos on the row's day");
    assert.ok(musa.idempotencyKey.startsWith("order-upload:"));

    const ada = byQty[30000];
    const [adaCustomer] = await db.select().from(customers).where(eq(customers.id, ada.customerId));
    assert.equal(adaCustomer.name, "Ada Obi");
    assert.equal(adaCustomer.companyName, "Obi Ventures");
    assert.equal(byQty[10000].customerId, ada.customerId, "one new customer for both of her rows");

    const [after] = await db.select().from(pfis).where(eq(pfis.id, pfi.id));
    assert.equal(after.soldQtyLitres, 85000, "the litres came off the PFI, as any order's do");
  });

  test("they never lapse, back-dated or not", async () => {
    const placed = await db.select().from(orders).where(inArray(orders.id, placedIds));
    for (const o of placed) {
      assert.equal(orderService.isOrderExpired(o), false, `${o.id} would lapse`);
      assert.equal(orderService.computeExpiresAt(o), null, "no countdown to show");
    }
    const stale = await orderRepo.findStalePending(new Date());
    assert.ok(!stale.some((s) => placedIds.includes(s.id)), "the end-of-day sweep never picks them up");
    await assert.rejects(orderService.expireOrder(placedIds[0]), /does not lapse/);
  });

  test("an ordinary unpaid order from the same day still lapses", async () => {
    const control = { status: "Pending", paymentStatus: "Unpaid", createdAt: new Date("2026-10-06T11:00:00Z"), idempotencyKey: null };
    const prev = process.env.ORDER_EXPIRY_DISABLED;
    process.env.ORDER_EXPIRY_DISABLED = "false";
    try {
      assert.equal(orderService.isOrderExpired(control), true);
    } finally {
      process.env.ORDER_EXPIRY_DISABLED = prev;
    }
  });

  test("applying the same list again places nothing twice", async () => {
    const out = await upload.apply({ pfiId: pfi.id, rows: rows(), staffId: staff.id });
    assert.equal(out.results.filter((r) => r.outcome === "placed").length, 0);
    assert.equal(out.results.filter((r) => r.outcome === "already").length, 3);
    const placed = await db.select().from(orders).where(like(orders.idempotencyKey, `order-upload:${out.batch}:%`));
    assert.equal(placed.length, 3);
  });

  test("a row can name the account instead of a phone, and a new customer keeps its own company", async () => {
    const THIRD = `0805${tail}`;
    const list = [
      { date: "2026-10-05", name: "MANSUR", company: "FZE 727 DI", customerId: String(existing.id), product: "PMS", qty: "5000", rate: "1390" },
      { date: "2026-10-05", name: "MUKTARI", company: "FZE 600 DB", phone: THIRD, customerCompany: "", product: "PMS", qty: "5000", rate: "1380" },
      { date: "2026-10-05", name: "Nobody", company: "X", customerId: "99999999", product: "PMS", qty: "5000", rate: "1380" },
    ];
    const p = await upload.plan({ pfiId: pfi.id, rows: list });
    assert.equal(p.rows[0].customer.id, existing.id);
    assert.match(p.rows[2].problems.join(), /not found/);

    const out = await upload.apply({ pfiId: pfi.id, rows: list, staffId: staff.id });
    const [named, fresh] = out.results;
    assert.equal(named.outcome, "placed");
    assert.equal(fresh.outcome, "placed");
    const [o1] = await db.select().from(orders).where(eq(orders.id, named.orderId));
    assert.equal(o1.customerId, existing.id);
    assert.equal(o1.companyName, "FZE 727 DI", "the row's company is the order's");
    const [o2] = await db.select().from(orders).where(eq(orders.id, fresh.orderId));
    const [muktari] = await db.select().from(customers).where(eq(customers.id, o2.customerId));
    assert.equal(muktari.name, "MUKTARI");
    assert.equal(muktari.companyName, "", "not opened with a truck plate for a company");
    await db.delete(orderPfiAllocations).where(inArray(orderPfiAllocations.orderId, [o1.id, o2.id]));
    await db.delete(orders).where(inArray(orders.id, [o1.id, o2.id]));
    await db.delete(customers).where(eq(customers.id, muktari.id));
    await db.update(pfis).set({ soldQtyLitres: 85000 }).where(eq(pfis.id, pfi.id));
  });

  test("a PFI that is not trading is refused before anything is read", async () => {
    await db.update(pfis).set({ status: "finished" }).where(eq(pfis.id, pfi.id));
    try {
      await assert.rejects(upload.plan({ pfiId: pfi.id, rows: rows() }), /not trading/);
    } finally {
      await db.update(pfis).set({ status: "active" }).where(eq(pfis.id, pfi.id));
    }
  });
});
