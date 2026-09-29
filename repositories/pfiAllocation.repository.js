const { eq, and, desc, inArray, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfiTruckAllocations, pfis, fleetTrucks, drivers, customers } = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");

/**
 * Reads and writes for pfi_truck_allocations. The rules — who may raise,
 * approve or refuse one, and what approval makes — are in
 * services/pfiAllocation.service.js.
 */

/** An allocation with its parent's and its trucking PFI's names beside it. */
const WITH_NAMES = {
  allocation: pfiTruckAllocations,
  parentPfiNumber: sql`parent.pfi_number`,
  parentPfiType: sql`parent.pfi_type`,
  locationName: sql`COALESCE(NULLIF(d.name, ''), parent.location_name, '')`,
  productName: sql`COALESCE(NULLIF(parent.product_name, ''), pr.name, '')`,
  productUnit: sql`COALESCE(parent.product_unit, 'Litres')`,
  subPfiStatus: sql`sub.status`,
  orderStatus: sql`o.status`,
  orderPaymentStatus: sql`o.payment_status`,
};

const shape = (row) =>
  row && {
    ...row.allocation,
    pricePerUnit: Number(row.allocation.pricePerUnit),
    parentPfiNumber: row.parentPfiNumber || "",
    parentPfiType: row.parentPfiType || "",
    locationName: row.locationName || "",
    productName: row.productName || "",
    productUnit: row.productUnit || "Litres",
    subPfiStatus: row.subPfiStatus || null,
    orderStatus: row.orderStatus || null,
    orderPaymentStatus: row.orderPaymentStatus || null,
  };

const baseQuery = (tx = db) =>
  tx
    .select(WITH_NAMES)
    .from(pfiTruckAllocations)
    .innerJoin(sql`pfis parent`, sql`parent.id = ${pfiTruckAllocations.parentPfiId}`)
    .leftJoin(sql`depots d`, sql`d.id = parent.location_id`)
    .leftJoin(sql`products pr`, sql`pr.id = parent.product_id`)
    .leftJoin(sql`pfis sub`, sql`sub.id = ${pfiTruckAllocations.subPfiId}`)
    .leftJoin(sql`orders o`, sql`o.id = ${pfiTruckAllocations.orderId}`);

const findById = async (id, tx = db) => {
  const [row] = await baseQuery(tx).where(eq(pfiTruckAllocations.id, Number(id))).limit(1);
  return shape(row) || null;
};

/** Locks the row for the rest of the caller's transaction. */
const lockById = async (id, tx) => {
  const [row] = await tx
    .select()
    .from(pfiTruckAllocations)
    .where(eq(pfiTruckAllocations.id, Number(id)))
    .for("update")
    .limit(1);
  return row || null;
};

/** Every allocation off one cargo, newest first. */
const listForParent = async (parentPfiId) =>
  (await baseQuery()
    .where(eq(pfiTruckAllocations.parentPfiId, Number(parentPfiId)))
    .orderBy(desc(pfiTruckAllocations.raisedAt))).map(shape);

/** The allocation a trucking PFI was made by, if it was made by one. */
const findBySubPfi = async (subPfiId) => {
  const [row] = await baseQuery().where(eq(pfiTruckAllocations.subPfiId, Number(subPfiId))).limit(1);
  return shape(row) || null;
};

/**
 * Allocations by status, across every cargo the reader can see.
 *
 * Scoped through the parent, by the same rule the PFI register uses, so a
 * manager on one cargo sees that cargo's requests and nobody else's.
 */
const listByStatus = async ({ status = "pending", scopeUser = null, limit = 200 } = {}) => {
  const conditions = [];
  if (status && status !== "all") conditions.push(eq(pfiTruckAllocations.status, status));
  const scope = scopeCondition(scopeUser, {
    depotColumn: sql`parent.location_id`,
    lpgStationColumn: sql`parent.lpg_station_id`,
    pfiColumn: sql`parent.id`,
  });
  if (scope) conditions.push(scope);
  return (await baseQuery()
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(pfiTruckAllocations.raisedAt))
    .limit(limit)).map(shape);
};

/** Litres already asked of a cargo by allocations nobody has decided yet. */
const pendingQuantity = async (parentPfiId, tx = db) => {
  const [row] = await tx
    .select({ qty: sql`COALESCE(SUM(${pfiTruckAllocations.quantity}), 0)` })
    .from(pfiTruckAllocations)
    .where(and(
      eq(pfiTruckAllocations.parentPfiId, Number(parentPfiId)),
      eq(pfiTruckAllocations.status, "pending"),
    ));
  return Number(row?.qty) || 0;
};

/**
 * Every name that could be holding a letter, from every family.
 *
 * The family is picked out of these by lib/pfiFamily — the book is a few
 * hundred names at most, and matching serials in SQL would mean teaching
 * Postgres the three separators and the optional letter a second time.
 */
const namesThatHoldLetters = async (tx = db) => {
  const result = await tx.execute(sql`
    SELECT pfi_number AS name FROM pfis
    UNION SELECT allocation_code FROM pfis WHERE allocation_code IS NOT NULL
    UNION SELECT DISTINCT allocation_code FROM delivery_inventory WHERE allocation_code IS NOT NULL
    UNION SELECT code FROM delivery_batches
  `);
  return (result.rows ?? result).map((r) => r.name).filter(Boolean);
};

/** Letters held by allocations still pending or approved, in one family. */
const liveSuffixes = async (familySerial, tx = db) =>
  (await tx
    .select({ suffix: pfiTruckAllocations.suffix })
    .from(pfiTruckAllocations)
    .where(and(
      eq(pfiTruckAllocations.familySerial, String(familySerial)),
      inArray(pfiTruckAllocations.status, ["pending", "approved"]),
    ))).map((r) => r.suffix);

const create = async (values, tx = db) => {
  const [row] = await tx.insert(pfiTruckAllocations).values(values).returning();
  return row;
};

const update = async (id, values, tx = db) => {
  const [row] = await tx
    .update(pfiTruckAllocations)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(pfiTruckAllocations.id, Number(id)))
    .returning();
  return row || null;
};

/** Fleet trucks by id, with the driver the record points at. */
const fleetTrucksByIds = async (ids) => {
  const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!list.length) return [];
  return db
    .select({
      id: fleetTrucks.id,
      plateNumber: fleetTrucks.plateNumber,
      maxCapacity: fleetTrucks.maxCapacity,
      driverName: sql`COALESCE(NULLIF(${drivers.name}, ''), NULLIF(${fleetTrucks.driverName}, ''), '')`,
      driverPhone: sql`COALESCE(NULLIF(${drivers.phone}, ''), NULLIF(${fleetTrucks.driverPhone}, ''), '')`,
    })
    .from(fleetTrucks)
    .leftJoin(drivers, eq(fleetTrucks.driverId, drivers.id))
    .where(inArray(fleetTrucks.id, list));
};

/**
 * The house customer for one purpose, created the first time it is asked for.
 *
 * The phone is deliberately not a number: every customer text is addressed
 * through utils/phone, which turns anything unparseable into no recipient, so
 * the company is never texted an invoice for selling to itself. It is unique
 * like any other phone, which is what the unique index on it requires.
 */
const ensureHouseCustomer = async (purpose, { name, companyName }) => {
  const [existing] = await db.select().from(customers).where(eq(customers.houseAccount, purpose)).limit(1);
  if (existing) return existing;
  await db
    .insert(customers)
    .values({
      name,
      companyName,
      phone: `HOUSE-${String(purpose).toUpperCase()}`,
      email: "",
      houseAccount: purpose,
      status: "Active",
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(customers).where(eq(customers.houseAccount, purpose)).limit(1);
  return row;
};

/** The trucking PFI, inserted in the approval's transaction. */
const insertPfi = async (values, tx) => {
  const [row] = await tx.insert(pfis).values(values).returning();
  return row;
};

module.exports = {
  findById,
  lockById,
  listForParent,
  findBySubPfi,
  listByStatus,
  pendingQuantity,
  namesThatHoldLetters,
  liveSuffixes,
  create,
  update,
  fleetTrucksByIds,
  ensureHouseCustomer,
  insertPfi,
};
