const {
  pgTable,
  serial,
  integer,
  date,
  decimal,
  text,
  timestamp,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { pfis } = require("./pfi");
const { staff } = require("./staff");

/**
 * A correction on the CFO report — one row per (day, PFI).
 *
 * Everything the report shows is computed from orders and order_payments by
 * services/cfoReport.service.js. This table holds only what a person has
 * typed over the top of that, and the rules are in
 * db/migrations/0040_cfo_report_entries.sql. Two of them matter enough to
 * repeat here:
 *
 *   * A null override means the computed figure stands. It is NOT zero, and
 *     nothing may coalesce it to zero on the way out.
 *   * Stock balance and surplus/deficit are absent by design — they are
 *     derived from the columns beside them so that a printed row always adds
 *     up. Correct an input, not the answer.
 */
const cfoReportEntries = pgTable(
  "cfo_report_entries",
  {
    id: serial("id").primaryKey(),
    /**
     * The calendar day in the reporting zone, as a date — never an instant.
     * `mode: "string"` so it arrives as "2026-09-17" and is compared against
     * the day keys the service builds, with no timezone applied twice.
     */
    reportDate: date("report_date", { mode: "string" }).notNull(),
    pfiId: integer("pfi_id")
      .notNull()
      .references(() => pfis.id, { onDelete: "cascade" }),

    // ── the overrides. Nullable throughout, and that is the design ──
    initialQty: decimal("initial_qty", { precision: 18, scale: 2 }),
    cumulativeVolume: decimal("cumulative_volume", { precision: 18, scale: 2 }),
    dayVolume: decimal("day_volume", { precision: 18, scale: 2 }),
    salesValue: decimal("sales_value", { precision: 18, scale: 2 }),
    bankInflow: decimal("bank_inflow", { precision: 18, scale: 2 }),

    remarks: text("remarks").default("").notNull(),

    updatedBy: integer("updated_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // What makes the save path a plain upsert instead of a read-then-write
    // two people can race.
    uniqueIndex("cfo_report_entries_date_pfi_idx").on(table.reportDate, table.pfiId),
    index("cfo_report_entries_date_idx").on(table.reportDate),
  ]
);

/**
 * The columns a person may type over, and nothing else.
 *
 * Exported so the repository, the controller and the validation schema all
 * read the same list — the way a column gets silently dropped is three files
 * each keeping their own copy of it.
 */
const CFO_OVERRIDE_FIELDS = [
  "initialQty",
  "cumulativeVolume",
  "dayVolume",
  "salesValue",
  "bankInflow",
];

module.exports = { cfoReportEntries, CFO_OVERRIDE_FIELDS };
