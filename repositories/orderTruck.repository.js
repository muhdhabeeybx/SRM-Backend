const { eq, and, asc, desc, count, gte, lte, sql, or, ilike, isNotNull } = require("drizzle-orm");
const { alias } = require("drizzle-orm/pg-core");
const { db } = require("../config/db");
const { orderTrucks, orders, customers, depots, products, pfis, staff } = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");
const { generateOrderReference } = require("../utils/helpers");
const { dayEdge, lagosToday, localDateStr } = require("../lib/zonedDay");

// The gate is two people: one signs a truck in, another signs it out. Both
// come from `staff`, so the table is joined twice under its own aliases —
// without them the second join silently overwrites the first and every truck
// reports the same officer at both ends.
const enteredByStaff = alias(staff, "entered_by_staff");
const exitedByStaff = alias(staff, "exited_by_staff");

/**
 * order_trucks — one row per truck LOAD on an order (distinct from the fleet
 * `trucks` vehicle master). Every function threads an optional `tx` so a load
 * can be created/updated inside the same transaction as the order transition
 * that owns it (release, gate-in, gate-out).
 */

const create = async (data, tx = db) => {
  const [row] = await tx.insert(orderTrucks).values(data).returning();
  return row;
};

/** Bulk sibling of `create` — one round trip for a whole batch of loads. */
const createMany = async (rows, tx = db) => {
  if (!rows.length) return [];
  return tx.insert(orderTrucks).values(rows).returning();
};

const findById = async (id, tx = db) => {
  const [row] = await tx.select().from(orderTrucks).where(eq(orderTrucks.id, id)).limit(1);
  return row || null;
};

/** All loads on an order, in allocation order (truck 1, 2, 3 …). */
const findByOrder = async (orderId, tx = db) => {
  return tx
    .select()
    .from(orderTrucks)
    .where(eq(orderTrucks.orderId, orderId))
    .orderBy(asc(orderTrucks.truckIndex));
};

const update = async (id, data, tx = db) => {
  const [row] = await tx
    .update(orderTrucks)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(orderTrucks.id, id))
    .returning();
  return row || null;
};

/** How many loads on an order sit in a given status — drives the gate transitions. */
const countByOrderAndStatus = async (orderId, status, tx = db) => {
  const [row] = await tx
    .select({ n: count() })
    .from(orderTrucks)
    .where(and(eq(orderTrucks.orderId, orderId), eq(orderTrucks.status, status)));
  return Number(row?.n || 0);
};

const countByOrder = async (orderId, tx = db) => {
  const [row] = await tx
    .select({ n: count() })
    .from(orderTrucks)
    .where(eq(orderTrucks.orderId, orderId));
  return Number(row?.n || 0);
};

/**
 * How many loads on an order are still in the depot — i.e. have NOT gated out.
 * The order completes only when this hits zero (the last truck has physically
 * left). A `loaded` truck still counts: it is loaded but has not departed, so a
 * multi-truck order must not complete the moment the first truck exits.
 */
const countRemainingByOrder = async (orderId, tx = db) => {
  const [row] = await tx
    .select({ n: count() })
    .from(orderTrucks)
    .where(
      and(
        eq(orderTrucks.orderId, orderId),
        sql`${orderTrucks.status} <> 'gated_out'`
      )
    );
  return Number(row?.n || 0);
};

const deleteByOrder = async (orderId, tx = db) => {
  await tx.delete(orderTrucks).where(eq(orderTrucks.orderId, orderId));
};

/** Total quantity across every load on the order, ticketed or not. */
const sumQuantityByOrder = async (orderId, tx = db) => {
  const [row] = await tx
    .select({ total: sql`COALESCE(SUM(${orderTrucks.quantity}), 0)` })
    .from(orderTrucks)
    .where(eq(orderTrucks.orderId, orderId));
  return Number(row?.total || 0);
};

/**
 * Every truck the gate handled in a period, with everything known about it.
 *
 * The security report used to assemble this in the browser: fetch every order,
 * guess which ones might have a load in range, then issue one
 * `/orders/:id/trucks` request per candidate — dozens of round-trips, which is
 * the only reason that page ever needed a "Run report" button. One query does
 * it, so the page can simply show today's gate on arrival.
 *
 * Anchored on entry: a truck appears if it was gated IN during the period,
 * whether or not it has left again. One still on site is exactly what a
 * security officer needs to see, and filtering on exit hid them entirely.
 *
 * Both officers are joined by name — `securityEnteredBy` / `securityExitedBy`
 * are staff ids, and a report of who cleared what is not much use as numbers.
 */
const findGateMovements = async ({ dateFrom, dateTo, depotId, pfiId, search, scopeUser } = {}) => {
  const conditions = [isNotNull(orderTrucks.securityEnteredAt)];
  const scope = scopeCondition(scopeUser, { depotColumn: orders.depotId, pfiColumn: orders.pfiId });
  if (scope) conditions.push(scope);
  if (depotId) conditions.push(eq(orders.depotId, Number(depotId)));
  if (pfiId) conditions.push(eq(orders.pfiId, Number(pfiId)));
  // A bare yyyy-MM-dd is that day's UTC midnight; widened to the last instant
  // so "today" includes a truck that came in this afternoon.
  if (dateFrom) {
    conditions.push(gte(orderTrucks.securityEnteredAt, dayEdge(dateFrom, "start")));
  }
  if (dateTo) {
    conditions.push(lte(orderTrucks.securityEnteredAt, dayEdge(dateTo, "end")));
  }
  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(orderTrucks.truckNumber, term),
        ilike(orderTrucks.driverName, term),
        ilike(orderTrucks.entryDriverName, term),
        ilike(orderTrucks.driverPhone, term),
        ilike(orderTrucks.entryDriverPhone, term),
        ilike(orderTrucks.loaderName, term),
        ilike(orders.orderNumber, term),
        ilike(orders.companyName, term),
        ilike(customers.name, term),
      ),
    );
  }

  const rows = await db
    .select({
      id: orderTrucks.id,
      orderId: orderTrucks.orderId,
      truckIndex: orderTrucks.truckIndex,
      truckNumber: orderTrucks.truckNumber,
      quantity: orderTrucks.quantity,
      compartments: orderTrucks.compartments,
      gantry: orderTrucks.gantry,
      status: orderTrucks.status,
      // The driver recorded at the gate can differ from the one on the
      // ticket — a swap between allocation and arrival is common, and the
      // report shows both rather than picking one and being wrong sometimes.
      driverName: orderTrucks.driverName,
      driverPhone: orderTrucks.driverPhone,
      entryDriverName: orderTrucks.entryDriverName,
      entryDriverPhone: orderTrucks.entryDriverPhone,
      loaderName: orderTrucks.loaderName,
      loaderPhone: orderTrucks.loaderPhone,
      enteredAt: orderTrucks.securityEnteredAt,
      exitedAt: orderTrucks.securityExitedAt,
      loadedAt: orderTrucks.loadedAt,
      enteredByFirstName: enteredByStaff.firstName,
      enteredBySurname: enteredByStaff.surname,
      exitedByFirstName: exitedByStaff.firstName,
      exitedBySurname: exitedByStaff.surname,
      orderNumber: orders.orderNumber,
      companyName: orders.companyName,
      customerName: customers.name,
      customerPhone: customers.phone,
      depotName: depots.name,
      productName: products.name,
      pfiNumber: pfis.pfiNumber,
    })
    .from(orderTrucks)
    .innerJoin(orders, eq(orderTrucks.orderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(depots, eq(orders.depotId, depots.id))
    .leftJoin(products, eq(orders.productId, products.id))
    .leftJoin(pfis, eq(orders.pfiId, pfis.id))
    .leftJoin(enteredByStaff, eq(orderTrucks.securityEnteredBy, enteredByStaff.id))
    .leftJoin(exitedByStaff, eq(orderTrucks.securityExitedBy, exitedByStaff.id))
    .where(and(...conditions))
    .orderBy(desc(orderTrucks.securityEnteredAt), desc(orderTrucks.id));

  // The reference people actually use — "AA11214", built from the order's own
  // company initials, not the internal ORD-768CF4D000B7. Same helper every
  // other report and every printed ticket goes through, so a reference read
  // off this page finds the order it names.
  const trucks = rows.map((r) => ({
    ...r,
    reference: generateOrderReference(r.companyName, r.orderId),
  }));

  const entered = trucks.length;
  const exited = trucks.filter((r) => r.exitedAt).length;

  return {
    trucks,
    totals: {
      entered,
      exited,
      onSite: entered - exited,
      quantityEntered: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
      quantityExited: rows.reduce((s, r) => s + (r.exitedAt ? Number(r.quantity || 0) : 0), 0),
    },
  };
};

module.exports = {
  create,
  createMany,
  findById,
  findByOrder,
  findGateMovements,
  update,
  deleteByOrder,
  countByOrderAndStatus,
  countByOrder,
  countRemainingByOrder,
  sumQuantityByOrder,
};
