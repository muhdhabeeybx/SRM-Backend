const { eq, and, desc, inArray, isNull, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfiTruckAllocations, pfis, fleetTrucks, drivers, customers, deliveryCustomers } = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");
const { STATION_TYPES } = require("../lib/customerTypes");
const { orderReferenceSql } = require("../lib/orderReferenceSql");
const { PREFIX: ALLOCATION_ORDER_PREFIX } = require("../lib/allocationOrders");

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
  /**
   * The order's money, so the cargo can see what its trucking PFI has paid
   * for those litres and what is still on credit (lib/allocationOrders).
   */
  orderReference: sql`CASE WHEN o.id IS NULL THEN NULL ELSE ${orderReferenceSql("o", "oc")} END`,
  orderTotal: sql`o.total_amount`,
  orderPaid: sql`o.amount_paid`,
  orderCustomerName: sql`oc.name`,
  /**
   * The order was placed before the request was raised: an order already on
   * the cargo, linked rather than placed by approval (see linkOrder in the
   * service). A placed one is always younger than its request.
   */
  linkedOrder: sql`(o.id IS NOT NULL AND o.created_at < ${pfiTruckAllocations.raisedAt})`,
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
    orderReference: row.orderReference || null,
    orderTotal: row.orderTotal == null ? null : Number(row.orderTotal),
    orderPaid: row.orderPaid == null ? null : Number(row.orderPaid),
    orderCustomerName: row.orderCustomerName || null,
    linkedOrder: row.linkedOrder === true,
    /** What is still unpaid on the order: owed by the trucking PFI, by no customer. */
    orderOnCredit:
      row.orderTotal == null ? null : Math.max(0, Math.round((Number(row.orderTotal) - Number(row.orderPaid || 0)) * 100) / 100),
  };

const baseQuery = (tx = db) =>
  tx
    .select(WITH_NAMES)
    .from(pfiTruckAllocations)
    .innerJoin(sql`pfis parent`, sql`parent.id = ${pfiTruckAllocations.parentPfiId}`)
    .leftJoin(sql`depots d`, sql`d.id = parent.location_id`)
    .leftJoin(sql`products pr`, sql`pr.id = parent.product_id`)
    .leftJoin(sql`pfis sub`, sql`sub.id = ${pfiTruckAllocations.subPfiId}`)
    .leftJoin(sql`orders o`, sql`o.id = ${pfiTruckAllocations.orderId}`)
    .leftJoin(sql`customers oc`, sql`oc.id = o.customer_id`);

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

/**
 * Litres already asked of a cargo by allocations nobody has decided yet.
 *
 * A request to link an order already placed asks for nothing: its litres left
 * the cargo's shelf when that order was placed.
 */
const pendingQuantity = async (parentPfiId, tx = db) => {
  const [row] = await tx
    .select({ qty: sql`COALESCE(SUM(${pfiTruckAllocations.quantity}), 0)` })
    .from(pfiTruckAllocations)
    .where(and(
      eq(pfiTruckAllocations.parentPfiId, Number(parentPfiId)),
      eq(pfiTruckAllocations.status, "pending"),
      isNull(pfiTruckAllocations.orderId),
    ));
  return Number(row?.qty) || 0;
};

/** Orders up to this day are on the audited finance report (2026-09-10). */
const AUDITED_THROUGH = "2026-09-10";

/**
 * Orders on a cargo, with what decides whether one may be linked to a new
 * trucking PFI (services/pfiAllocation.service linkProblem).
 *
 * The list for the form (no `orderId`): every live order on the cargo placed
 * after the audited report, that is not already an allocation's, newest first.
 * One order (`orderId`): that order whatever it is, for the checks at raise and
 * at approval.
 */
const ordersToLink = async ({ pfiId, orderId = null }, tx = db) => {
  const one = orderId != null;
  const result = await tx.execute(sql`
    SELECT o.id,
           ${orderReferenceSql("o", "c")} AS "reference",
           o.pfi_id AS "pfiId",
           o.created_at AS "createdAt",
           (o.created_at AT TIME ZONE 'Africa/Lagos')::date::text AS "placedOn",
           o.status::text AS "status",
           o.payment_status::text AS "paymentStatus",
           o.pricing_status AS "pricingStatus",
           o.quantity,
           o.price,
           o.total_amount AS "totalAmount",
           o.amount_paid AS "amountPaid",
           o.idempotency_key AS "idempotencyKey",
           o.customer_id AS "customerId",
           c.name AS "customerName",
           c.house_account AS "houseAccount",
           COALESCE(NULLIF(btrim(o.company_name), ''), c.company_name, '') AS "companyName",
           (SELECT count(*)::int FROM order_trucks t WHERE t.order_id = o.id) AS "loads",
           (SELECT count(*)::int FROM order_trucks t WHERE t.order_id = o.id AND t.status <> 'pending') AS "loadsTicketed",
           EXISTS (SELECT 1 FROM commissions m WHERE m.order_id = o.id AND m.status = 'paid') AS "commissionPaid",
           EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = o.id AND r.status = 'requested') AS "refundOpen",
           (SELECT a.id FROM pfi_truck_allocations a
             WHERE a.order_id = o.id AND a.status = 'pending' LIMIT 1) AS "pendingLinkId",
           (SELECT a.pfi_number FROM pfi_truck_allocations a
             WHERE a.order_id = o.id AND a.status = 'pending' LIMIT 1) AS "pendingLink"
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
     WHERE ${one
       ? sql`o.id = ${Number(orderId)}`
       : sql`o.pfi_id = ${Number(pfiId)}
         AND o.status::text NOT IN ('Cancelled', 'Expired')
         AND COALESCE(o.idempotency_key, '') NOT LIKE ${`${ALLOCATION_ORDER_PREFIX}%`}
         AND (o.created_at AT TIME ZONE 'Africa/Lagos')::date > ${AUDITED_THROUGH}::date`}
     ORDER BY o.created_at DESC
     LIMIT ${one ? 1 : 300}
  `);
  return (result.rows ?? result).map((r) => ({
    ...r,
    id: Number(r.id),
    pfiId: r.pfiId == null ? null : Number(r.pfiId),
    customerId: Number(r.customerId),
    quantity: Number(r.quantity),
    price: Number(r.price),
    totalAmount: Number(r.totalAmount),
    amountPaid: Number(r.amountPaid || 0),
    pendingLinkId: r.pendingLinkId == null ? null : Number(r.pendingLinkId),
  }));
};

/**
 * The trucking PFI a pending request will link this order to, or null. While
 * there is one the order does not lapse (services/order.service expireOrder):
 * a request waiting for an admin must not find its order expired overnight.
 */
const pendingLinkForOrder = async (orderId, tx = db) => {
  const [row] = await tx
    .select({ id: pfiTruckAllocations.id, pfiNumber: pfiTruckAllocations.pfiNumber })
    .from(pfiTruckAllocations)
    .where(and(eq(pfiTruckAllocations.orderId, Number(orderId)), eq(pfiTruckAllocations.status, "pending")))
    .limit(1);
  return row || null;
};

/**
 * A linked order's own papers go with it to the house account: what was
 * expected to be paid on it, its delivery notes, and a commission not yet paid
 * out. A paid commission is money already out to an agent, so an order with
 * one is never linked (linkProblem).
 */
const moveOrderPapers = async (orderId, customerId, tx) => {
  const id = Number(orderId);
  const to = Number(customerId);
  await tx.execute(sql`UPDATE expected_payments SET customer_id = ${to}, updated_at = now() WHERE order_id = ${id}`);
  await tx.execute(sql`UPDATE delivery_notes SET customer_id = ${to}, updated_at = now() WHERE order_id = ${id}`);
  await tx.execute(sql`UPDATE commissions SET customer_id = ${to}, updated_at = now() WHERE order_id = ${id} AND status <> 'paid'`);
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

/** Our own stations and plants still trading — what litres can be allocated to. */
const activeStations = () =>
  db
    .select({ id: deliveryCustomers.id, name: deliveryCustomers.name, customerType: deliveryCustomers.customerType })
    .from(deliveryCustomers)
    .where(and(inArray(deliveryCustomers.customerType, STATION_TYPES), eq(deliveryCustomers.status, "active")))
    .orderBy(deliveryCustomers.name);

/** One station or plant by id, whatever its state — the caller says what it may be. */
const stationById = async (id) => {
  const [row] = await db
    .select({
      id: deliveryCustomers.id,
      name: deliveryCustomers.name,
      customerType: deliveryCustomers.customerType,
      status: deliveryCustomers.status,
    })
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.id, Number(id)))
    .limit(1);
  return row || null;
};

/**
 * The house customer for one purpose, created the first time it is asked for.
 *
 * The phone is deliberately not a number: every customer text is addressed
 * through utils/phone, which turns anything unparseable into no recipient, so
 * the company is never texted an invoice for selling to itself. It is unique
 * like any other phone, which is what the unique index on it requires.
 */
const ensureHouseCustomer = async (purpose, { name, companyName, phone = `HOUSE-${String(purpose).toUpperCase()}` }) => {
  const [existing] = await db.select().from(customers).where(eq(customers.houseAccount, purpose)).limit(1);
  if (existing) return existing;
  await db
    .insert(customers)
    .values({
      name,
      companyName,
      phone,
      email: "",
      houseAccount: purpose,
      status: "Active",
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(customers).where(eq(customers.houseAccount, purpose)).limit(1);
  return row;
};

/**
 * A withdrawn request, gone without a trace: its lines in the activity log,
 * the notices it raised (their delivery rows go with them), then the request.
 */
const deleteWithTraces = async (id, tx = db) => {
  const key = String(Number(id));
  await tx.execute(sql`
    DELETE FROM audit_logs
     WHERE action LIKE 'pfi.trucks_allocation_%'
       AND metadata->>'allocationId' = ${key}`);
  await tx.execute(sql`
    DELETE FROM notifications
     WHERE type IN ('staff.pfi_allocation_raised', 'staff.pfi_allocation_raised_sms', 'staff.pfi_allocation_decided')
       AND dedupe_key LIKE ${`%|staff.pfi_allocation_%:${key}`}`);
  await tx.delete(pfiTruckAllocations).where(eq(pfiTruckAllocations.id, Number(id)));
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
  ordersToLink,
  pendingLinkForOrder,
  moveOrderPapers,
  AUDITED_THROUGH,
  namesThatHoldLetters,
  liveSuffixes,
  create,
  update,
  fleetTrucksByIds,
  activeStations,
  stationById,
  ensureHouseCustomer,
  insertPfi,
  deleteWithTraces,
};
