const {
  pgTable,
  serial,
  integer,
  decimal,
  timestamp,
  index,
} = require("drizzle-orm/pg-core");
const { depotProductPrices } = require("./depotProductPrices");

const depotPriceHistory = pgTable(
  "depot_price_history",
  {
    id: serial("id").primaryKey(),
    depotProductPriceId: integer("depot_product_price_id")
      .notNull()
      .references(() => depotProductPrices.id, { onDelete: "cascade" }),
    price: decimal("price", { precision: 15, scale: 2 }).notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * The approved change that produced this row, where there was one.
     *
     * This trail predates the approval step and is still written on every
     * approval so anything already reading it is unaffected. Who asked and who
     * approved live on depot_price_changes rather than being copied here — one
     * of them would go stale. NULL on every row written before migration 0047,
     * and on the bulk "take everything off sale", which deliberately has no
     * approval.
     */
    changeId: integer("change_id"),
  },
  (table) => [
    index("depot_price_history_parent_idx").on(table.depotProductPriceId),
  ]
);

module.exports = { depotPriceHistory };
