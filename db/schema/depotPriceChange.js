const {
  pgTable,
  serial,
  integer,
  numeric,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { depots } = require("./depot");
const { products } = require("./product");

/**
 * A proposed change to a depot's selling price, and what became of it.
 *
 * depot_product_prices.current_price is what an order is priced from — see
 * order.service.js, which reads it as the server price and refuses the
 * client's — so a number typed on the pricing page used to be live the instant
 * it saved. Nothing sat between the typing and the selling.
 *
 * A row here IS the change: what it was, what is asked for, who asked, who
 * decided, and when each happened. current_price is only ever moved by
 * approving one. See migration 0047.
 *
 * Rejected and superseded rows are kept, for the same reason approved ones
 * are: "why is PMS still 950" is answered by the change that was refused, not
 * by its absence.
 */
const depotPriceChanges = pgTable(
  "depot_price_changes",
  {
    id: serial("id").primaryKey(),
    depotId: integer("depot_id")
      .notNull()
      .references(() => depots.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /**
     * What it was when this was asked for. NULL when the product had no price
     * at all — that is a first price, not a change, and 0 would claim it was
     * being sold for nothing.
     */
    previousPrice: numeric("previous_price", { precision: 15, scale: 2 }),
    proposedPrice: numeric("proposed_price", { precision: 15, scale: 2 }).notNull(),
    /** pending | approved | rejected | superseded. Checked in the database. */
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    requestedBy: integer("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One price can be waiting per depot+product. A second proposal supersedes
    // the first rather than queueing behind it: two pending prices for one
    // product is a question nobody can answer, and the later one is what is
    // meant.
    uniqueIndex("depot_price_changes_one_pending_idx")
      .on(table.depotId, table.productId)
      .where(sql`status = 'pending'`),
    index("depot_price_changes_depot_idx").on(table.depotId, table.productId, table.requestedAt),
  ]
);

module.exports = { depotPriceChanges };
