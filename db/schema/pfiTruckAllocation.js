const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  decimal,
  date,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { pfis } = require("./pfi");
const { orders } = require("./order");
const { depots } = require("./depot");
const { products } = require("./product");
const { staff } = require("./staff");

/**
 * Trucks allocated off a cargo, and what became of the request.
 *
 * Approving one places an order on the parent for the whole quantity at the
 * day's price and raises the lettered trucking PFI (PFI/47C off PFI/47) that
 * holds exactly those litres. See db/migrations/0063 and
 * services/pfiAllocation.service.js.
 */
const pfiTruckAllocations = pgTable(
  "pfi_truck_allocations",
  {
    id: serial("id").primaryKey(),
    parentPfiId: integer("parent_pfi_id").notNull().references(() => pfis.id, { onDelete: "restrict" }),
    familySerial: varchar("family_serial", { length: 10 }).notNull(),
    suffix: varchar("suffix", { length: 2 }).notNull(),
    pfiNumber: varchar("pfi_number", { length: 100 }).notNull(),
    allocationCode: varchar("allocation_code", { length: 100 }).notNull(),
    depotId: integer("depot_id").references(() => depots.id, { onDelete: "set null" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    pricePerUnit: decimal("price_per_unit", { precision: 15, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull(),
    /** [{ truckId, plateNumber, driverName, driverPhone, loadedQty }] */
    trucks: jsonb("trucks").notNull(),
    loadingDate: date("loading_date").notNull(),
    note: text("note").default("").notNull(),
    /** pending | approved | rejected | withdrawn */
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    raisedBy: integer("raised_by").references(() => staff.id, { onDelete: "set null" }),
    raisedByName: varchar("raised_by_name", { length: 255 }).default("").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).defaultNow().notNull(),
    decidedBy: integer("decided_by").references(() => staff.id, { onDelete: "set null" }),
    decidedByName: varchar("decided_by_name", { length: 255 }).default("").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note").default("").notNull(),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    subPfiId: integer("sub_pfi_id").references(() => pfis.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pfi_truck_allocations_live_suffix_idx")
      .on(table.familySerial, table.suffix)
      .where(sql`${table.status} IN ('pending', 'approved')`),
    index("pfi_truck_allocations_parent_idx").on(table.parentPfiId, table.raisedAt),
  ]
);

module.exports = { pfiTruckAllocations };
