const asyncHandler = require("express-async-handler");
const workQueues = require("../../services/workQueues.service");
const overview = require("../../services/overview.service");
const myPfis = require("../../services/myPfis.service");
const myNotifications = require("../../services/myNotifications.service");
const { resolvePeriod } = require("../../lib/reportPeriod");
const { db } = require("../../config/db");
const {
  fleetTrucks: trucks,
  drivers,
  depots,
  products,
  orders,
  customers,
  deposits,
  offlineSales,
  deliverySales,
  deliveryCustomers,
  auditEvents,
  walletHolds,
  dangoteOrderRequests,
  lpgOrderRequests,
  lpgStations,
} = require("../../db/schema");
const {
  eq,
  and,
  or,
  not,
  inArray,
  notInArray,
  count,
  sql,
  gte,
  lte,
  desc,
} = require("drizzle-orm");
const {
  revenueSummary,
  salesSummary,
  walletSummary,
  pfiSummary,
  outstandingPayments,
} = require("../../services/reporting.service");

const NEEDS_ATTENTION = sql`(${trucks.truckStatus} ILIKE 'Fair%' OR ${trucks.truckStatus} ILIKE 'Bad%')`;

/**
 * A truck counts as working when it is standing on a load that has not
 * finished: gated in, loaded, or gated out and on the road. `pending` is
 * excluded — an allocation nobody has acted on yet leaves the vehicle in the
 * yard.
 */
const TRUCK_WORKING_STATUSES = ["gated_in", "loaded", "gated_out"];

/** Orders whose loads no longer put a truck on the road. */
const ORDER_FINISHED_STATUSES = ["Completed", "Cancelled", "Expired"];

/**
 * A Released order is never moved to Completed in practice, so "not finished"
 * on its own would count a load gated out months ago as still on the road and
 * the figure would only ever climb. A load is treated as live for this long
 * after its last gate stamp.
 */
const TRUCK_IN_TRANSIT_DAYS = 7;

/**
 * A truck-sale load is often never marked offloaded — 66 of the 95 still
 * "loaded" on 2026-09-29 were from August, each followed by a newer load on
 * the same truck. One counts only while it is the truck's latest load and is
 * no older than this; a sale trip runs for days, not the week an order load
 * gets.
 */
const TRUCK_SALE_LIVE_DAYS = 21;

/**
 * Plates are compared with punctuation and case stripped: the load ledger
 * writes them as the gate officer types them ("EN 46 XM") while the fleet
 * registry stores them closed up ("BWR800XB"), so a literal comparison
 * matches nothing at all. Normalised, 61 of the 65 registered vehicles are
 * recognisable in the ledger.
 */
const normalisedPlate = (col) =>
  sql`UPPER(REGEXP_REPLACE(${col}, '[^A-Za-z0-9]', '', 'g'))`;

const num = (v) => Number(v || 0);

// getPeriodDates lived here and understood four presets. Replaced by
// lib/reportPeriod.resolvePeriod, which also takes an explicit from/to range
// and returns the label and trend granularity alongside the dates.

async function getDailyRevenueTrend(dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);

  const [paidOrders, approvedOffline, deliveryRows, receivedRows] = await Promise.all([
    db
      .select({
        date: sql`DATE(${orders.createdAt})`.mapWith(String),
        total: sql`COALESCE(SUM(${orders.totalAmount}), 0)`.mapWith(Number),
      })
      .from(orders)
      .where(
        and(
          eq(orders.paymentStatus, "Paid"),
          gte(orders.createdAt, from),
          lte(orders.createdAt, to)
        )
      )
      .groupBy(sql`DATE(${orders.createdAt})`),

    db
      .select({
        date: sql`DATE(${offlineSales.createdAt})`.mapWith(String),
        total: sql`COALESCE(SUM(${offlineSales.totalAmount}), 0)`.mapWith(Number),
      })
      .from(offlineSales)
      .where(
        and(
          eq(offlineSales.status, "approved"),
          gte(offlineSales.createdAt, from),
          lte(offlineSales.createdAt, to)
        )
      )
      .groupBy(sql`DATE(${offlineSales.createdAt})`),

    db
      .select({
        date: sql`${deliverySales.dateLoaded}`.mapWith(String),
        total: sql`COALESCE(SUM(${deliverySales.paymentAmount}), 0)`.mapWith(Number),
      })
      .from(deliverySales)
      .where(
        and(
          gte(deliverySales.dateLoaded, dateFrom.slice(0, 10)),
          lte(deliverySales.dateLoaded, dateTo.slice(0, 10)),
          // A station's load paid on the truck sale is the company settling
          // with itself; the money arrives as the station's own deposits,
          // which are counted. Migration 0070.
          sql`NOT (${deliverySales.book} = 'trucking' AND ${deliverySales.customerId} IN (
            SELECT id FROM delivery_customers WHERE customer_type::text IN ('filling_station', 'lpg_plant')))`
        )
      )
      .groupBy(deliverySales.dateLoaded),

    // Money received on the day's orders — the dashboard's headline, drawn
    // day by day. The same rows and the same exclusions as financeSummary's
    // `received` (services/overview.service.js), so the line sums to the
    // figure above it. Keyed by the Lagos day: the period starts at Lagos
    // midnight, and a UTC date put each night's first hour on the day before.
    db.execute(sql`
      SELECT to_char(o.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS date,
             COALESCE(SUM(p.amount), 0) AS total
        FROM orders o
        JOIN order_payments p
          ON p.order_id = o.id AND p.source NOT IN ('transfer_in', 'transfer_out', 'refund')
       WHERE o.created_at >= ${from.toISOString()}::timestamptz
         AND o.created_at <= ${to.toISOString()}::timestamptz
         AND o.payment_status IN ('Paid', 'Part Paid')
       GROUP BY 1`),
  ]);

  const EMPTY = { orders: 0, offline: 0, delivery: 0, received: 0 };
  const byDay = new Map();
  const put = (date, field, total) => {
    const key = String(date);
    if (!byDay.has(key)) byDay.set(key, { ...EMPTY });
    byDay.get(key)[field] = num(total);
  };
  for (const r of paidOrders) put(r.date, "orders", r.total);
  for (const r of approvedOffline) put(r.date, "offline", r.total);
  for (const r of deliveryRows) put(r.date, "delivery", r.total);
  for (const r of receivedRows.rows ?? receivedRows) put(r.date, "received", r.total);

  const lagosDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" });
  const trend = [];
  const seen = new Set();
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
    const key = lagosDay.format(new Date(t));
    if (seen.has(key)) continue;
    seen.add(key);
    trend.push({ date: key, ...(byDay.get(key) || EMPTY) });
  }
  return trend;
}

const getStats = asyncHandler(async (req, res) => {
  const inTransitTrucks = 0;

  const [
    [{ totalTrucks }],
    [{ idleTrucks }],
    [{ maintenanceTrucks }],
    [{ totalDrivers }],
    [{ activeDrivers }],
    [{ onTripDrivers }],
    [{ offDutyDrivers }],
    [{ totalDepots }],
    [{ totalProducts }],
    categoryResult,
  ] = await Promise.all([
    db.select({ totalTrucks: count() }).from(trucks).where(eq(trucks.isActive, true)),
    db
      .select({ idleTrucks: count() })
      .from(trucks)
      .where(and(eq(trucks.isActive, true), not(NEEDS_ATTENTION))),
    db
      .select({ maintenanceTrucks: count() })
      .from(trucks)
      .where(and(eq(trucks.isActive, true), NEEDS_ATTENTION)),
    db.select({ totalDrivers: count() }).from(drivers),
    db
      .select({ activeDrivers: count() })
      .from(drivers)
      .where(sql`${drivers.status}::text = 'Active'`),
    db
      .select({ onTripDrivers: count() })
      .from(drivers)
      .where(sql`${drivers.status}::text = 'On Trip'`),
    db
      .select({ offDutyDrivers: count() })
      .from(drivers)
      .where(sql`${drivers.status}::text = 'Off Duty'`),
    db.select({ totalDepots: count() }).from(depots),
    db.select({ totalProducts: count() }).from(products),
    db.select({ count: sql`COUNT(DISTINCT ${products.category})` }).from(products),
  ]);

  res.json({
    success: true,
    data: {
      trucks: {
        total: totalTrucks,
        inTransit: inTransitTrucks,
        idle: idleTrucks,
        maintenance: maintenanceTrucks,
      },
      drivers: {
        total: totalDrivers,
        active: activeDrivers,
        onTrip: onTripDrivers,
        offDuty: offDutyDrivers,
      },
      depots: { total: totalDepots },
      products: { total: totalProducts, categories: Number(categoryResult[0]?.count) || 0 },
    },
  });
});

const getOverview = asyncHandler(async (req, res) => {
  // Presets plus an explicit from/to range — see lib/reportPeriod. The label
  // and granularity travel with the data so every panel, and the page header,
  // describe the same window without each deriving its own wording.
  const resolved = resolvePeriod(req.query);
  const { from, to } = resolved;

  const [
    revenue,
    sales,
    wallet,
    pfi,
    outstanding,
    fleetCounts,
    driverCounts,
    customerCounts,
    recentActivity,
    revenueTrend,
    depotLeaderboard,
    dangoteSummary,
    lpgSummary,
    finance,
    inventory,
    activeDepotLeaderboard,
    activity,
  ] = await Promise.all([
    revenueSummary({ dateFrom: from, dateTo: to }),
    salesSummary({ dateFrom: from, dateTo: to }),
    walletSummary({ dateFrom: from, dateTo: to }),
    pfiSummary(),
    outstandingPayments({ limit: 5 }),
    (async () => {
      // inTransit used to be hardcoded to 0, which made the dashboard's
      // utilisation card — inTransit / total — permanently read 0%. It is
      // counted off the load ledger: distinct vehicles standing on a live
      // load that is neither finished nor still an untouched allocation.
      //
      // The join is on the normalised plate, not order_trucks.truck_id: that
      // soft FK is null on every one of the 7,519 rows in the ledger, so a
      // join through it counts nothing. The UNION keeps one row per truck,
      // however many loads it carries across concurrent orders.
      const [total, maintenance, inTransit] = await Promise.all([
        db.select({ c: count() }).from(trucks).where(eq(trucks.isActive, true)),
        db
          .select({ c: count() })
          .from(trucks)
          .where(and(eq(trucks.isActive, true), NEEDS_ATTENTION)),
        // Working on an order load, or out on a truck sale. The two overlap
        // heavily — a trucking PFI's truck-sale record usually sits on the
        // same vehicle's order load — so they are unioned, not added.
        db.execute(sql`
          SELECT count(*)::int AS c FROM (
            SELECT t.id
              FROM order_trucks ot
              JOIN orders o ON o.id = ot.order_id
              JOIN fleet_trucks t ON ${normalisedPlate(sql`t.plate_number`)} = ${normalisedPlate(sql`ot.truck_number`)}
             WHERE t.is_active
               AND ot.status IN ${sql.raw(`('${TRUCK_WORKING_STATUSES.join("','")}')`)}
               AND o.status NOT IN ${sql.raw(`('${ORDER_FINISHED_STATUSES.join("','")}')`)}
               AND COALESCE(ot.security_exited_at, ot.loaded_at, ot.security_entered_at, ot.created_at)
                   > now() - (${TRUCK_IN_TRANSIT_DAYS} * interval '1 day')
            UNION
            SELECT t.id
              FROM delivery_inventory d
              JOIN fleet_trucks t
                ON t.id = d.truck_id OR ${normalisedPlate(sql`t.plate_number`)} = ${normalisedPlate(sql`d.truck_number`)}
             WHERE t.is_active
               AND d.loading_status = 'loaded'
               AND d.created_at > now() - (${TRUCK_SALE_LIVE_DAYS} * interval '1 day')
               AND NOT EXISTS (
                 SELECT 1 FROM delivery_inventory later
                  WHERE later.id <> d.id AND later.created_at > d.created_at
                    AND ${normalisedPlate(sql`later.truck_number`)} = ${normalisedPlate(sql`d.truck_number`)})
          ) working`),
      ]);

      const totalCount = total[0].c;
      const maintenanceCount = maintenance[0].c;
      const inTransitCount = Number((inTransit.rows ?? inTransit)[0]?.c || 0);
      return {
        total: totalCount,
        maintenance: maintenanceCount,
        inTransit: inTransitCount,
        // Whatever is left over: on the books, not under repair, not on a
        // load. Derived rather than queried so the three always add to total
        // instead of overlapping the way a separate count would.
        idle: Math.max(0, totalCount - maintenanceCount - inTransitCount),
      };
    })(),
    (async () => {
      const [total, active, onTrip, offDuty] = await Promise.all([
        db.select({ c: count() }).from(drivers),
        db
          .select({ c: count() })
          .from(drivers)
          .where(sql`${drivers.status}::text = 'Active'`),
        db
          .select({ c: count() })
          .from(drivers)
          .where(sql`${drivers.status}::text = 'On Trip'`),
        db
          .select({ c: count() })
          .from(drivers)
          .where(sql`${drivers.status}::text = 'Off Duty'`),
      ]);
      return {
        total: total[0].c,
        active: active[0].c,
        onTrip: onTrip[0].c,
        offDuty: offDuty[0].c,
      };
    })(),
    (async () => {
      const [total, newThisPeriod] = await Promise.all([
        db.select({ c: count() }).from(customers),
        db
          .select({ c: count() })
          .from(customers)
          .where(gte(customers.createdAt, new Date(from))),
      ]);
      return { total: total[0].c, newThisPeriod: newThisPeriod[0].c };
    })(),
    db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        actorType: auditEvents.actorType,
        actorName: auditEvents.actorName,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .orderBy(desc(auditEvents.createdAt))
      .limit(15),
    getDailyRevenueTrend(from, to),

    // Depot leaderboard: orders grouped by depot, ranked by revenue
    (async () => {
      const rows = await db
        .select({
          id: depots.id,
          name: depots.name,
          orderCount: sql`COUNT(${orders.id})::int`.mapWith(Number),
          revenue: sql`COALESCE(SUM(${orders.totalAmount}), 0)`.mapWith(Number),
          volume: sql`COALESCE(SUM(${orders.quantity}), 0)::bigint`.mapWith(Number),
        })
        .from(depots)
        .leftJoin(
          orders,
          and(
            eq(orders.depotId, depots.id),
            eq(orders.paymentStatus, "Paid"),
            gte(orders.createdAt, new Date(from)),
            lte(orders.createdAt, new Date(to))
          )
        )
        .groupBy(depots.id, depots.name)
        .orderBy(desc(sql`COALESCE(SUM(${orders.totalAmount}), 0)`));
      return rows;
    })(),

    // Dangote order requests summary
    (async () => {
      const [totals] = await db
        .select({
          totalRequests: sql`COUNT(*)::int`.mapWith(Number),
          totalValue: sql`COALESCE(SUM(${dangoteOrderRequests.totalAmount}), 0)`.mapWith(Number),
          paidValue: sql`COALESCE(SUM(CASE WHEN ${dangoteOrderRequests.paymentStatus} = 'Paid' THEN ${dangoteOrderRequests.totalAmount} ELSE 0 END), 0)`.mapWith(Number),
        })
        .from(dangoteOrderRequests)
        .where(
          and(
            gte(dangoteOrderRequests.createdAt, new Date(from)),
            lte(dangoteOrderRequests.createdAt, new Date(to))
          )
        );

      const byStatus = await db
        .select({
          status: dangoteOrderRequests.status,
          count: sql`COUNT(*)::int`.mapWith(Number),
          total: sql`COALESCE(SUM(${dangoteOrderRequests.totalAmount}), 0)`.mapWith(Number),
        })
        .from(dangoteOrderRequests)
        .where(
          and(
            gte(dangoteOrderRequests.createdAt, new Date(from)),
            lte(dangoteOrderRequests.createdAt, new Date(to))
          )
        )
        .groupBy(dangoteOrderRequests.status);

      return { ...totals, byStatus };
    })(),

    // LPG orders + stations summary
    (async () => {
      const [orderTotals] = await db
        .select({
          totalOrders: sql`COUNT(*)::int`.mapWith(Number),
          totalValue: sql`COALESCE(SUM(${lpgOrderRequests.totalAmount}), 0)`.mapWith(Number),
          paidValue: sql`COALESCE(SUM(CASE WHEN ${lpgOrderRequests.paymentStatus} = 'Paid' THEN ${lpgOrderRequests.totalAmount} ELSE 0 END), 0)`.mapWith(Number),
        })
        .from(lpgOrderRequests)
        .where(
          and(
            gte(lpgOrderRequests.createdAt, new Date(from)),
            lte(lpgOrderRequests.createdAt, new Date(to))
          )
        );

      const [stationCounts] = await db
        .select({
          total: sql`COUNT(*)::int`.mapWith(Number),
          active: sql`COUNT(*) FILTER (WHERE ${lpgStations.status} = 'Active')::int`.mapWith(Number),
        })
        .from(lpgStations);

      const byStatus = await db
        .select({
          status: lpgOrderRequests.status,
          count: sql`COUNT(*)::int`.mapWith(Number),
          total: sql`COALESCE(SUM(${lpgOrderRequests.totalAmount}), 0)`.mapWith(Number),
        })
        .from(lpgOrderRequests)
        .where(
          and(
            gte(lpgOrderRequests.createdAt, new Date(from)),
            lte(lpgOrderRequests.createdAt, new Date(to))
          )
        )
        .groupBy(lpgOrderRequests.status);

      return { ...orderTotals, stations: stationCounts, byStatus };
    })(),
    overview.financeSummary({ from, to }),
    overview.inventorySummary(),
    overview.depotLeaderboard({ from, to }),
    overview.activityFeed({ limit: 10 }),
  ]);

  const orderStatusMap = {};
  for (const row of sales.byStatus) {
    const key = row.status;
    if (!orderStatusMap[key]) orderStatusMap[key] = 0;
    orderStatusMap[key] += row.orderCount;
  }
  const orderStatusBreakdown = Object.entries(orderStatusMap).map(([name, value]) => ({
    name,
    value,
  }));

  res.json({
    success: true,
    data: {
      period: resolved,
      /** Rebuilt on order_payments — see services/overview.service.js. */
      finance,
      inventory,
      activity,
      revenue,
      orders: sales,
      wallet,
      pfi,
      outstanding,
      fleet: fleetCounts,
      drivers: driverCounts,
      customers: customerCounts,
      revenueTrend,
      orderStatusBreakdown,
      recentActivity,
      // Active depots only, ranked on money received. The old list included
      // suspended depots sitting on nil.
      depotLeaderboard: activeDepotLeaderboard,
      dangote: dangoteSummary,
      lpg: lpgSummary,
    },
  });
});

/**
 * How much work is waiting on this user, per desk.
 *
 * Serves both the sidebar's number badges and the "my work" landing page, so
 * the two can never disagree. Location/PFI scoped like every other list.
 */
const getWorkQueues = asyncHandler(async (req, res) => {
  const data = await workQueues.getWorkQueues(req.user);
  res.json({ success: true, data });
});

/**
 * The PFIs this person is assigned to, for their dashboard — stock, sales,
 * loading and the accounts each collects into. Litres and counts only; see
 * services/myPfis.service.js for why no money figure is on it.
 *
 * Open to every signed-in staff member, PFI-confined ones included: it only
 * ever reads the caller's own assignments.
 */
const getMyPfis = asyncHandler(async (req, res) => {
  const data = await myPfis.getMyPfis(req.user);
  res.json({ success: true, data });
});

/**
 * This person's notifications, for their dashboard: their own inbox, less the
 * role-wide notices about orders and requests outside their scope. See
 * services/myNotifications.service.js.
 */
const getMyNotifications = asyncHandler(async (req, res) => {
  const data = await myNotifications.getMyNotifications(req.user, { limit: req.query.limit });
  res.json({ success: true, data });
});

/**
 * The full activity log, paginated and filterable.
 *
 * Backs the activity page, and the overview's ten rows come from the same
 * function so the two cannot show different histories.
 */
const getActivity = asyncHandler(async (req, res) => {
  const { limit = 50, page = 1, entityType, action } = req.query;
  const perPage = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const current = Math.max(1, parseInt(page) || 1);

  // A date range only when one was asked for — the activity page opens on
  // "everything", unlike the dashboard which always has a window.
  const range = req.query.from || req.query.to ? resolvePeriod(req.query) : null;

  const { rows, total } = await overview.activityFeed({
    limit: perPage,
    offset: (current - 1) * perPage,
    entityType,
    action,
    from: range?.from,
    to: range?.to,
  });

  res.json({
    success: true,
    data: {
      activity: rows,
      period: range,
      pagination: { page: current, limit: perPage, total, pages: Math.ceil(total / perPage) },
    },
  });
});

module.exports = { getStats, getOverview, getWorkQueues, getMyPfis, getMyNotifications, getActivity };
