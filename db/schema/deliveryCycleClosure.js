const { pgTable, varchar, text, timestamp, index } = require("drizzle-orm/pg-core");

/**
 * A filling-station delivery cycle the desk has finished with.
 *
 * A cycle is a loading with the sales that answer to it, assembled on the way
 * to the screen — not a row anywhere. This holds the one fact that assembly
 * has nowhere to put, and only for the cycles somebody has closed; absence of
 * a row means active.
 *
 * Separate from `delivery_batches` because the two are keyed by different
 * things — a batch by its allocation code, a cycle by the loading behind it.
 * See db/migrations/0029_station_cycle_closure.sql.
 */
const deliveryCycleClosures = pgTable(
  "delivery_cycle_closures",
  {
    /**
     * "loading:<id>", or "sale:<cycle>::<customer>::<location>" with no loading.
     * Also "station:<station id>|<PFI key>": a PFI the station has finished
     * with, closed on its own page (soromanfe lib/station-pfi-status).
     */
    cycleKey: text("cycle_key").primaryKey(),
    /** 'active' | 'completed'. Checked in the database, see the migration. */
    status: varchar("status", { length: 20 }).default("active").notNull(),
    /** Cleared on reopen — see the note on deliveryBatches. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: varchar("closed_by", { length: 255 }).default("").notNull(),
    note: text("note").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("delivery_cycle_closures_status_idx").on(table.status)]
);

module.exports = { deliveryCycleClosures };
