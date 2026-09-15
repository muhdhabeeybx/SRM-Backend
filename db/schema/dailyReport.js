const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  decimal,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { dailyReportStatusEnum , reportTypeEnum } = require("./enums");
const { staff } = require("./staff");

// One location/PFI's handwritten daily sales sheet, keyed in by staff and
// reviewed by a manager. A location can run several PFIs at once, each
// reported separately — hence the composite unique key.
const dailyReports = pgTable(
  "daily_reports",
  {
    id: serial("id").primaryKey(),
    // Which report this is. Replaces the "[TAG]" suffix the old system packed
    // into submittedByName.
    reportType: reportTypeEnum("report_type").default("sales_manager").notNull(),
    reportDate: date("report_date").notNull(),
    location: varchar("location", { length: 255 }).notNull(),
    pfiNumber: varchar("pfi_number", { length: 50 }).default("").notNull(),
    productName: varchar("product_name", { length: 100 }).default(""),

    // Stock movement (litres)
    carriedOverLoading: decimal("carried_over_loading", { precision: 15, scale: 2 }).default("0"),
    openingStock: decimal("opening_stock", { precision: 15, scale: 2 }).default("0"),
    receivedStock: decimal("received_stock", { precision: 15, scale: 2 }).default("0"),
    litresSold: decimal("litres_sold", { precision: 15, scale: 2 }).default("0").notNull(),
    tankBalance: decimal("tank_balance", { precision: 15, scale: 2 }).default("0"),
    loadingLeftOver: decimal("loading_left_over", { precision: 15, scale: 2 }).default("0"),

    // --- The location manager's sheet ------------------------------------
    //
    // Figures the paper form has always carried and the digital one had
    // nowhere to put, so they were written into `remarks` as prose — where
    // they could not be totalled, checked against the system, or carried into
    // the master report.
    //
    // Nullable with no default, unlike the litres columns above: on a sheet
    // filled in across a shift, 0 and "not answered yet" are different
    // answers, and here 0 would read as a dipped-empty tank rather than an
    // unvisited one.
    blFigure: decimal("bl_figure", { precision: 15, scale: 2 }),
    tankInitial: decimal("tank_initial", { precision: 15, scale: 2 }),
    aggregateSold: decimal("aggregate_sold", { precision: 15, scale: 2 }),
    pfiDaysCounting: integer("pfi_days_counting"),
    /** Carried from yesterday's sheet so an open issue survives the night. */
    yesterdayRemarks: text("yesterday_remarks"),
    /** Sold today but still in the tank. */
    soldUnloaded: decimal("sold_unloaded", { precision: 15, scale: 2 }),
    /** Counting product already sold but not yet lifted. */
    tankBalanceInclusive: decimal("tank_balance_inclusive", { precision: 15, scale: 2 }),
    /** What is left once product owed to customers is taken out. */
    netTankBalance: decimal("net_tank_balance", { precision: 15, scale: 2 }),

    // A day can sell at several prices: [{ "price": "850.00", "litres": "20000" }].
    // avgPrice / litresSold stay in sync as the derived scalars.
    priceBands: jsonb("price_bands").default(sql`'[]'::jsonb`),
    avgPrice: decimal("avg_price", { precision: 12, scale: 2 }).default("0"),
    totalSalesAmount: decimal("total_sales_amount", { precision: 15, scale: 2 }).default("0").notNull(),
    amountPaid: decimal("amount_paid", { precision: 15, scale: 2 }).default("0").notNull(),
    differentials: decimal("differentials", { precision: 15, scale: 2 }).default("0"),
    truckCount: integer("truck_count").default(0).notNull(),
    // Money owed/refundable from yesterday's shortfall or excess, settled
    // today — distinct from today's own differentials above.
    yesterdayDeficitPayment: decimal("yesterday_deficit_payment", { precision: 15, scale: 2 }).default("0"),
    yesterdaySurplusPayment: decimal("yesterday_surplus_payment", { precision: 15, scale: 2 }).default("0"),
    // The running bank total for this PFI (deposits matched to it, to date),
    // as distinct from amountPaid, which is only today's sales receipt.
    totalInflow: decimal("total_inflow", { precision: 15, scale: 2 }).default("0"),

    // --- Commission report ---------------------------------------------
    // Money taken in against which commission is worked out, and what that
    // works out to. Their own columns rather than borrowed generic ones: on
    // a commission report `amountPaid` already means "commission paid", so
    // reusing totalSalesAmount for "commission due" would leave two money
    // columns on one row meaning something different from every other
    // report type.
    //
    // Nullable with no default, unlike the money columns above: 0 and "not
    // filled in" are different answers on a report somebody may file in
    // stages, and the two figures below should not read as settled when
    // nothing has been entered.
    fundsReceived: decimal("funds_received", { precision: 15, scale: 2 }),
    commissionDue: decimal("commission_due", { precision: 15, scale: 2 }),
    // What is still owed, and what is left of the money taken in.
    //
    //   commission outstanding ≈ commissionDue - amountPaid
    //   funds remaining        ≈ fundsReceived - amountPaid
    //
    // Approximately: the form starts both at the subtraction and keeps them
    // there while the figures behind them move, but the filer can state
    // something else — what is still owed can carry an earlier period's
    // arrears, which today's two numbers cannot see. That is why these are
    // columns rather than a render-time subtraction, which is what they were:
    // the form offered no way to say anything but the subtraction, and the
    // Hub's own columns for them were permanently blank.
    //
    // Nullable, so a row filed before they existed keeps working out its own
    // (see reportValue in the dashboard's -report-config.ts).
    commissionOutstanding: decimal("commission_outstanding", { precision: 15, scale: 2 }),
    fundsRemaining: decimal("funds_remaining", { precision: 15, scale: 2 }),
    // Trucks that entered today — security_gate's mirror of truckCount, which
    // this role uses for "trucks exited" instead.
    trucksEntered: integer("trucks_entered"),

    bankName: varchar("bank_name", { length: 255 }).default(""),
    accountNumber: varchar("account_number", { length: 50 }).default(""),
    // Commission and compliance fields. The old system had no columns for
    // these and encoded them into remarks as "Customers: 12 | Orders: 30" and
    // "RATES: …", recovering them by regex — so editing your own note silently
    // destroyed the numbers.
    customerCount: integer("customer_count"),
    orderCount: integer("order_count"),
    rates: text("rates").default(""),
    // [{ name, phone, litres }, ...] — compliance's top 5 for the day.
    topCustomers: jsonb("top_customers").default(sql`'[]'::jsonb`),
    remarks: text("remarks").default(""),
    /**
     * What the system held for this PFI and date when the report was
     * submitted — the figures the typed ones are checked against.
     *
     * Captured rather than recomputed on read: orders get cancelled, payments
     * rematched, batches reassigned, so recomputing would check a report
     * against a book that has moved and the variance would change every time
     * somebody opened it. Null on reports filed before this existed, and the
     * master report says "not captured" rather than implying no variance.
     *
     * See services/reportActuals.service.js.
     */
    systemActuals: jsonb("system_actuals"),

    // Workflow: submitted -> approved | rejected (manager review).
    status: dailyReportStatusEnum("status").default("submitted").notNull(),
    submittedBy: integer("submitted_by").references(() => staff.id, { onDelete: "set null" }),
    submittedByName: varchar("submitted_by_name", { length: 255 }).default(""),
    reviewedBy: integer("reviewed_by").references(() => staff.id, { onDelete: "set null" }),
    reviewedByName: varchar("reviewed_by_name", { length: 255 }).default(""),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewComment: text("review_comment").default(""),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // reportType is part of the key: five report types share this table, so
    // without it filing a gate report would block the same person filing a
    // commission report for the same day and location.
    uniqueIndex("daily_reports_unique_idx").on(
      table.reportType,
      table.reportDate,
      table.location,
      table.pfiNumber,
      table.submittedBy
    ),
    index("daily_reports_date_location_idx").on(table.reportDate, table.location),
    index("daily_reports_status_idx").on(table.status),
    check("daily_reports_litres_check", sql`${table.litresSold} >= 0`),
    check("daily_reports_trucks_check", sql`${table.truckCount} >= 0`),
  ]
);

module.exports = { dailyReports };
