const {
  pgTable,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { deliveryCustomers } = require("./deliveryCustomer");
const { staff } = require("./staff");

/**
 * Which filling stations a member of staff is assigned (migration 0057).
 * Same shape and meaning as lpg_station_staff: see lib/scopeFilter.js.
 */
const fillingStationStaff = pgTable(
  "filling_station_staff",
  {
    id: serial("id").primaryKey(),
    deliveryCustomerId: integer("delivery_customer_id")
      .notNull()
      .references(() => deliveryCustomers.id, { onDelete: "cascade" }),
    staffId: integer("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("filling_station_staff_unique_idx").on(table.deliveryCustomerId, table.staffId),
    index("filling_station_staff_staff_idx").on(table.staffId),
  ]
);

module.exports = { fillingStationStaff };
