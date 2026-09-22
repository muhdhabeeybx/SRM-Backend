const { eq, and, sql, desc, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const {
  orders,
  deposits,
  customers,
  walletHolds,
  pfis,
  deliveryInventory,
  deliverySales,
  deliveryCustomers,
  fleetTrucks,
  fleetLedgerEntries,
  dailyReports,
  offlineSales,
} = require("../db/schema");
const { fleetTruckRepo } = require("../repositories");

// Read-only aggregation, SQL-side, over the same records the existing
// screens use: delivery_sales is the delivery sales ledger (rows keyed in
// manually by staff), fleet_ledger_entries the fleet book. Nothing here
// writes.

const num = (value) => Number(value || 0);

const dateConditions = (column, dateFrom, dateTo) => {
  const conditions = [];
  if (dateFrom) conditions.push(gte(column, new Date(dateFrom)));
  if (dateTo) conditions.push(lte(column, new Date(dateTo)));
  return conditions;
};

const salesSummary = async ({ dateFrom, dateTo } = {}) => {
  const conditions = dateConditions(orders.createdAt, dateFrom, dateTo);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const byStatus = await db
    .select({
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      orderCount: sql`count(*)::int`,
      totalLitres: sql`COALESCE(SUM(${orders.quantity}), 0)::bigint`,
      totalValue: sql`COALESCE(SUM(${orders.totalAmount}), 0)`,
    })
    .from(orders)
    .where(whereClause)
    .groupBy(orders.status, orders.paymentStatus);

  const totals = byStatus.reduce(
    (acc, row) => ({
      orders: acc.orders + row.orderCount,
      litres: acc.litres + num(row.totalLitres),
      value: acc.value + num(row.totalValue),
      paidValue: acc.paidValue + (row.paymentStatus === "Paid" ? num(row.totalValue) : 0),
    }),
    { orders: 0, litres: 0, value: 0, paidValue: 0 }
  );

  return { totals, byStatus };
};

const walletSummary = async ({ dateFrom, dateTo } = {}) => {
  const conditions = dateConditions(deposits.createdAt, dateFrom, dateTo);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [movement] = await db
    .select({
      credits: sql`COALESCE(SUM(CASE WHEN ${deposits.type} = 'credit' THEN ${deposits.amount} ELSE 0 END), 0)`,
      debits: sql`COALESCE(SUM(CASE WHEN ${deposits.type} = 'debit' THEN ${deposits.amount} ELSE 0 END), 0)`,
      entryCount: sql`count(*)::int`,
    })
    .from(deposits)
    .where(whereClause);

  const [balances] = await db
    .select({
      totalBalance: sql`COALESCE(SUM(${customers.balance}), 0)`,
      customersWithBalance: sql`COUNT(*) FILTER (WHERE ${customers.balance} > 0)::int`,
    })
    .from(customers);

  const [held] = await db
    .select({ totalHeld: sql`COALESCE(SUM(${walletHolds.amount}), 0)` })
    .from(walletHolds)
    .where(eq(walletHolds.status, "active"));

  return { movement, balances, activeHolds: held };
};

const pfiSummary = async () => {
  const rows = await db
    .select({
      status: pfis.status,
      pfiCount: sql`count(*)::int`,
      startingLitres: sql`COALESCE(SUM(${pfis.startingQtyLitres}), 0)::bigint`,
      soldLitres: sql`COALESCE(SUM(${pfis.soldQtyLitres}), 0)::bigint`,
      // Remaining counts any evacuation surplus found since; starting stays the
      // landed figure. See lib/pfiStock.js.
      remainingLitres: sql`COALESCE(SUM(${pfis.startingQtyLitres} + ${pfis.evacuationSurplusLitres} - ${pfis.soldQtyLitres}), 0)::bigint`,
      totalValue: sql`COALESCE(SUM(${pfis.totalAmount}), 0)`,
    })
    .from(pfis)
    .groupBy(pfis.status);
  return { byStatus: rows };
};

// Delivery sales ledger totals: sales value vs payments received, and the
// gap between them — the same arithmetic the Django ledger screens show.
const deliverySalesTotals = async ({ dateFrom, dateTo, customerType } = {}) => {
  const conditions = [];
  if (dateFrom) conditions.push(gte(deliverySales.dateLoaded, dateFrom));
  if (dateTo) conditions.push(lte(deliverySales.dateLoaded, dateTo));
  if (customerType) conditions.push(eq(deliveryCustomers.customerType, customerType));

  const [totals] = await db
    .select({
      saleCount: sql`count(*)::int`,
      quantity: sql`COALESCE(SUM(${deliverySales.quantity}), 0)`,
      salesValue: sql`COALESCE(SUM(${deliverySales.salesValue}), 0)`,
      paymentAmount: sql`COALESCE(SUM(${deliverySales.paymentAmount}), 0)`,
      outstanding: sql`COALESCE(SUM(${deliverySales.salesValue} - ${deliverySales.paymentAmount}), 0)`,
    })
    .from(deliverySales)
    .leftJoin(deliveryCustomers, eq(deliverySales.customerId, deliveryCustomers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return totals;
};

const deliverySummary = async ({ dateFrom, dateTo } = {}) => {
  const conditions = dateConditions(deliveryInventory.createdAt, dateFrom, dateTo);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const byStatus = await db
    .select({
      loadingStatus: deliveryInventory.loadingStatus,
      releaseStatus: deliveryInventory.releaseStatus,
      allocationCount: sql`count(*)::int`,
      totalLitres: sql`COALESCE(SUM(${deliveryInventory.quantityAllocated}), 0)`,
    })
    .from(deliveryInventory)
    .where(whereClause)
    .groupBy(deliveryInventory.loadingStatus, deliveryInventory.releaseStatus);

  const salesLedger = await deliverySalesTotals({ dateFrom, dateTo });

  return { byStatus, salesLedger };
};

const stationSummary = async ({ dateFrom, dateTo } = {}) => {
  const totals = await deliverySalesTotals({ dateFrom, dateTo, customerType: "filling_station" });

  const [stations] = await db
    .select({
      stationCount: sql`count(*)::int`,
      active: sql`COUNT(*) FILTER (WHERE ${deliveryCustomers.status} = 'active')::int`,
    })
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.customerType, "filling_station"));

  return { stations, salesLedger: totals };
};

const fleetSummary = async ({ dateFrom, dateTo } = {}) => {
  const ledger = await fleetTruckRepo.summarizeLedger({ dateFrom, dateTo });

  const conditions = [];
  if (dateFrom) conditions.push(gte(fleetLedgerEntries.entryDate, dateFrom));
  if (dateTo) conditions.push(lte(fleetLedgerEntries.entryDate, dateTo));

  const perTruck = await db
    .select({
      truckId: fleetTrucks.id,
      plateNumber: fleetTrucks.plateNumber,
      expenses: sql`COALESCE(SUM(CASE WHEN ${fleetLedgerEntries.entryType} = 'expense' THEN ${fleetLedgerEntries.amount} ELSE 0 END), 0)`,
      income: sql`COALESCE(SUM(CASE WHEN ${fleetLedgerEntries.entryType} = 'income' THEN ${fleetLedgerEntries.amount} ELSE 0 END), 0)`,
    })
    .from(fleetLedgerEntries)
    .innerJoin(fleetTrucks, eq(fleetLedgerEntries.truckId, fleetTrucks.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(fleetTrucks.id, fleetTrucks.plateNumber)
    .orderBy(desc(sql`SUM(CASE WHEN ${fleetLedgerEntries.entryType} = 'expense' THEN ${fleetLedgerEntries.amount} ELSE 0 END)`))
    .limit(50);

  return { ledger, perTruck };
};

/**
 * Who owes us money on the delivery sales ledger, biggest first:
 * outstanding = sales value - payments, per customer.
 *
 * `totalOutstanding` is the whole book, not the slice `limit` returned. It
 * used to be summed from `rows`, so a caller asking for the top 5 got a
 * five-customer subtotal that the dashboard then presented as the total
 * owed. The two figures answer different questions, so the total is now its
 * own aggregate and `customerCount` says how many customers stand behind it.
 */
const outstandingPayments = async ({ limit = 50 } = {}) => {
  /**
   * Expected value is read ONCE per truck cycle, not summed across its rows.
   *
   * `delivery_sales` holds one row per PAYMENT, and every row of a cycle
   * repeats that cycle's sales_value. Summing it therefore multiplied what
   * was owed by however many times the customer had paid — a truck paid in
   * three instalments counted its value three times. 161 cycles carry more
   * than one payment row, and the dashboard was reporting ₦33.39bn
   * outstanding against a true ₦24.85m: a figure 1,343 times too large, on
   * the front page.
   *
   * MAX is what the sales ledger itself uses for exactly this reason (see
   * useLedgerGroups), and the fallback to rate × quantity mirrors it too, so
   * the two screens now answer with the same number.
   *
   * The plate is normalised the way getCycleKey normalises it, because a
   * loading written "BWR 826 XB" and its payment written "BWR826XB" are the
   * same cycle and must not split into two.
   */
  const perCycle = sql`
    WITH per_cycle AS (
      SELECT
        ${deliverySales.customerId} AS customer_id,
        regexp_replace(UPPER(COALESCE(${deliverySales.truckNumber}, '')), '\\s', '', 'g') AS plate,
        COALESCE(LEFT(${deliverySales.dateLoaded}, 10), '') AS loaded_on,
        MAX(${deliverySales.salesValue}::numeric) AS sales_value,
        MAX(${deliverySales.rate}::numeric) AS rate,
        MAX(${deliverySales.quantity}::numeric) AS quantity,
        SUM(${deliverySales.paymentAmount}::numeric) AS paid
      FROM ${deliverySales}
      GROUP BY 1, 2, 3
    ),
    per_cycle_expected AS (
      SELECT
        customer_id,
        CASE
          WHEN COALESCE(sales_value, 0) > 0 THEN sales_value
          WHEN COALESCE(rate, 0) > 0 AND COALESCE(quantity, 0) > 0 THEN rate * quantity
          ELSE 0
        END AS expected,
        COALESCE(paid, 0) AS paid
      FROM per_cycle
    ),
    per_customer AS (
      SELECT
        customer_id,
        SUM(expected) AS sales_value,
        SUM(paid) AS payment_amount,
        SUM(expected - paid) AS outstanding
      FROM per_cycle_expected
      GROUP BY customer_id
      HAVING SUM(expected - paid) > 0
    )
  `;

  const [rows, totals] = await Promise.all([
    db.execute(sql`
      ${perCycle}
      SELECT
        pc.customer_id AS "customerId",
        COALESCE(dc.name, '') AS "customerName",
        dc.customer_type AS "customerType",
        pc.sales_value AS "salesValue",
        pc.payment_amount AS "paymentAmount",
        pc.outstanding AS "outstanding"
      FROM per_customer pc
      LEFT JOIN ${deliveryCustomers} dc ON dc.id = pc.customer_id
      ORDER BY pc.outstanding DESC
      LIMIT ${Math.min(200, limit)}
    `),
    // The whole book, not the slice `limit` returned — and only customers in
    // debit, since netting one in credit against one who owes would
    // understate what is actually out.
    db.execute(sql`
      ${perCycle}
      SELECT COALESCE(SUM(outstanding), 0) AS total, COUNT(*)::int AS "customerCount"
      FROM per_customer
    `),
  ]);

  const rowList = rows.rows ?? rows;
  const totalRow = (totals.rows ?? totals)[0] || {};

  return {
    totalOutstanding: num(totalRow.total),
    customerCount: Number(totalRow.customerCount) || 0,
    customers: rowList,
  };
};

const dailyReportSummary = async ({ dateFrom, dateTo, location } = {}) => {
  const conditions = [eq(dailyReports.status, "approved")];
  if (dateFrom) conditions.push(gte(dailyReports.reportDate, dateFrom));
  if (dateTo) conditions.push(lte(dailyReports.reportDate, dateTo));
  if (location) conditions.push(eq(dailyReports.location, location));

  const byLocation = await db
    .select({
      location: dailyReports.location,
      reportCount: sql`count(*)::int`,
      litresSold: sql`COALESCE(SUM(${dailyReports.litresSold}), 0)`,
      salesAmount: sql`COALESCE(SUM(${dailyReports.totalSalesAmount}), 0)`,
      amountPaid: sql`COALESCE(SUM(${dailyReports.amountPaid}), 0)`,
      truckCount: sql`COALESCE(SUM(${dailyReports.truckCount}), 0)::int`,
    })
    .from(dailyReports)
    .where(and(...conditions))
    .groupBy(dailyReports.location);

  return { byLocation };
};

const revenueSummary = async ({ dateFrom, dateTo } = {}) => {
  const orderConditions = [eq(orders.paymentStatus, "Paid"), ...dateConditions(orders.createdAt, dateFrom, dateTo)];
  const [orderRevenue] = await db
    .select({ total: sql`COALESCE(SUM(${orders.totalAmount}), 0)`, orderCount: sql`count(*)::int` })
    .from(orders)
    .where(and(...orderConditions));

  const offlineConditions = [eq(offlineSales.status, "approved"), ...dateConditions(offlineSales.createdAt, dateFrom, dateTo)];
  const [offlineRevenue] = await db
    .select({ total: sql`COALESCE(SUM(${offlineSales.totalAmount}), 0)`, saleCount: sql`count(*)::int` })
    .from(offlineSales)
    .where(and(...offlineConditions));

  const deliveryRevenue = await deliverySalesTotals({ dateFrom, dateTo });

  return {
    orders: orderRevenue,
    offlineSales: offlineRevenue,
    deliverySales: deliveryRevenue,
    combined: num(orderRevenue.total) + num(offlineRevenue.total) + num(deliveryRevenue.paymentAmount),
  };
};

module.exports = {
  salesSummary,
  walletSummary,
  pfiSummary,
  deliverySummary,
  fleetSummary,
  stationSummary,
  outstandingPayments,
  dailyReportSummary,
  revenueSummary,
};
