const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  real,
  boolean,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { staff } = require("./staff");
const { drivers } = require("./driver");

// The single truck registry.
//
// This absorbed the old `trucks` table: there is no longer an "ops trucks"
// versus "fleet trucks" split, because two registries meant the same plate
// had to be typed in two places and neither was authoritative. Vehicle
// identity (VIN, year, make, model, type) came across from that table.
//
// Financials live in fleet_ledger_entries, never as columns here.
const fleetTrucks = pgTable(
  "fleet_trucks",
  {
    id: serial("id").primaryKey(),
    plateNumber: varchar("plate_number", { length: 50 }).notNull(),
    truckMake: varchar("truck_make", { length: 255 }).default(""),
    chassisNumber: varchar("chassis_number", { length: 255 }).default(""),
    maxCapacity: integer("max_capacity"),
    // ── Vehicle identity, carried over from the old `trucks` table ─────────
    vin: varchar("vin", { length: 50 }),
    year: integer("year"),
    model: varchar("model", { length: 100 }),
    truckType: varchar("truck_type", { length: 100 }),
    fuelLevel: integer("fuel_level").default(100),
    registrationExpiry: date("registration_expiry"),
    nextServiceMileage: integer("next_service_mileage"),
    // The driver as a record rather than a name. The free-text driverName /
    // driverPhone below are kept for rows that predate this and for one-off
    // stand-ins who are not in the drivers table.
    driverId: integer("driver_id").references(() => drivers.id, { onDelete: "set null" }),
    fuelCapacity: real("fuel_capacity"),
    avgLitresPerTrip: real("avg_litres_per_trip"),
    mileage: integer("mileage"),

    driverName: varchar("driver_name", { length: 255 }).default(""),
    driverPhone: varchar("driver_phone", { length: 50 }).default(""),
    driverAltPhone: varchar("driver_alt_phone", { length: 50 }).default(""),
    motorBoyName: varchar("motor_boy_name", { length: 255 }).default(""),
    motorBoyPhone: varchar("motor_boy_phone", { length: 50 }).default(""),
    spareDriverName: varchar("spare_driver_name", { length: 255 }).default(""),
    spareDriverPhone: varchar("spare_driver_phone", { length: 50 }).default(""),

    insuranceExpiry: date("insurance_expiry"),
    roadWorthinessExpiry: date("road_worthiness_expiry"),
    lastServiceDate: date("last_service_date"),
    nextServiceDate: date("next_service_date"),

    // [{ kind: "insurance_cert" | "vehicle_papers" | "drivers_license" | ...,
    //    name, url, uploadedAt }] — URLs/data-URIs, storage-agnostic.
    documents: jsonb("documents").default(sql`'[]'::jsonb`),

    passportPhoto: text("passport_photo").default(""),
    truckStatus: varchar("truck_status", { length: 500 }).default(""),
    isActive: boolean("is_active").default(true).notNull(),
    /**
     * Hired, not ours (0094). Carries loads like any truck, but stays off our
     * Fixed Assets and papers watchlist, and its trips are costed as haulage.
     */
    isThirdParty: boolean("is_third_party").default(false).notNull(),
    ownerName: varchar("owner_name", { length: 255 }).default("").notNull(),
    // A JSON array of {date, description}. Stored as text and parsed
  // defensively — malformed JSON yields an empty list rather than a crash.
  incidents: text("incidents").default("[]"),
  notes: text("notes").default(""),

    createdBy: integer("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("fleet_trucks_plate_idx").on(table.plateNumber),
    index("fleet_trucks_active_idx").on(table.isActive),
    check("fleet_trucks_mileage_check", sql`${table.mileage} IS NULL OR ${table.mileage} >= 0`),
  ]
);

module.exports = { fleetTrucks };
