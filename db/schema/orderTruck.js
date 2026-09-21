const {
  pgTable,
  serial,
  smallint,
  integer,
  varchar,
  decimal,
  jsonb,
  timestamp,
  index,
  check,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { orderTruckStatusEnum } = require("./enums");
const { orders } = require("./order");
const { fleetTrucks } = require("./fleetTruck");
const { staff } = require("./staff");

/**
 * One row per truck load on an order — the `TruckAllocation` concept from
 * Django, plus the gate stamps. This is a LOAD (one truck's trip on one
 * order), distinct from `trucks`, which is the fleet VEHICLE master: one
 * vehicle does many loads over its life.
 *
 * `truck_id` is a SOFT, nullable FK to the fleet registry — set for a
 * delivery from Soroman's own fleet, null for a pickup (customer's own truck)
 * or an external haulier that is not in the registry. Django kept these
 * decoupled with plain strings for exactly that reason; the FK here is a
 * convenience the string columns still override, so a later edit to a fleet
 * vehicle never rewrites a historical load.
 *
 * No `ticket_number` here: a truck's ticket lives in `tickets`
 * (order_truck_id), which owns the number, QR and redemption lifecycle.
 */
const orderTrucks = pgTable(
  "order_trucks",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // Ordinal within the order — "truck 1 of 3". Drives the ticket suffix.
    truckIndex: smallint("truck_index").notNull(),
    // Soft link to the fleet vehicle (delivery only). Nullable by design.
    truckId: integer("truck_id").references(() => fleetTrucks.id, { onDelete: "set null" }),
    // The plate — the STORED source of truth. Delivery: copied from the fleet
    // record at release. Pickup: set by the entry officer at gate-in.
    truckNumber: varchar("truck_number", { length: 100 }),

    quantity: decimal("quantity", { precision: 15, scale: 2 }).notNull(),
    // Tanker compartments as [{qty, ullage}] — jsonb, not ten sparse columns.
    compartments: jsonb("compartments"),

    driverName: varchar("driver_name", { length: 255 }),
    driverPhone: varchar("driver_phone", { length: 50 }),
    // Observed at the gate, kept separate from the driver booked at
    // generation — the truck that turns up is not always the one booked.
    entryDriverName: varchar("entry_driver_name", { length: 255 }),
    entryDriverPhone: varchar("entry_driver_phone", { length: 50 }),
    // Gantry/arm the truck loaded from, recorded on exit.
    gantry: varchar("gantry", { length: 20 }),
    loaderName: varchar("loader_name", { length: 255 }),
    loaderPhone: varchar("loader_phone", { length: 50 }),

    /**
     * The handwritten ticket the driver is already carrying.
     *
     * Written in the depot's own book before this system saw the order, so it
     * follows whatever numbering that book uses and cannot share tickets.
     * ticket_number, which is UNIQUE and system-generated. Recording it here is
     * what ties the paper in the cab to the row in the database.
     */
    manualTicketNumber: varchar("manual_ticket_number", { length: 50 }).default("").notNull(),
    status: orderTruckStatusEnum("status").default("pending").notNull(),

    // Gate stamps. entered/exited are the two security roles; loaded is ticketing.
    securityEnteredAt: timestamp("security_entered_at", { withTimezone: true }),
    securityEnteredBy: integer("security_entered_by").references(() => staff.id, { onDelete: "set null" }),
    loadedAt: timestamp("loaded_at", { withTimezone: true }),
    loadedBy: integer("loaded_by").references(() => staff.id, { onDelete: "set null" }),
    securityExitedAt: timestamp("security_exited_at", { withTimezone: true }),
    securityExitedBy: integer("security_exited_by").references(() => staff.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // A single load may not exceed one tanker. The cross-row invariant — the
    // trucks' quantities summing to the order quantity — is a service check
    // inside the transaction, not something a CHECK can express.
    check("order_trucks_quantity_check", sql`${table.quantity} > 0 AND ${table.quantity} <= 60000`),
    index("order_trucks_order_idx").on(table.orderId, table.truckIndex),
    index("order_trucks_truck_idx").on(table.truckId).where(sql`${table.truckId} IS NOT NULL`),
    index("order_trucks_status_idx").on(table.status),
  ]
);

module.exports = { orderTrucks };
