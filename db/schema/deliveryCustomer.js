const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  decimal,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const {
  deliveryCustomerTypeEnum,
  deliveryCustomerStatusEnum,
} = require("./enums");
const { staff } = require("./staff");
const { lpgStations } = require("./lpgStation");

const deliveryCustomers = pgTable(
  "delivery_customers",
  {
    id: serial("id").primaryKey(),
    customerType: deliveryCustomerTypeEnum("customer_type").notNull(),
    customerCode: varchar("customer_code", { length: 50 }),
    name: varchar("name", { length: 255 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 30 }).notNull(),
    altPhoneNumber: varchar("alt_phone_number", { length: 30 }).default(""),
    email: varchar("email", { length: 255 }).default(""),
    // Individual customer fields
    homeAddress: text("home_address").default(""),
    officeAddress: text("office_address").default(""),
    passportPhoto: text("passport_photo").default(""),
    // Filling station fields
    contactPerson: varchar("contact_person", { length: 255 }).default(""),
    contactPersonPhone: varchar("contact_person_phone", { length: 30 }).default(""),
    stationAddress: text("station_address").default(""),
    tankCapacity: integer("tank_capacity").default(0),
    pumpCount: integer("pump_count").default(1),
    // LPG plant only: the lpg_stations row this plant IS, when it is one of
    // Soroman's own. One customer per plant. Migration 0061.
    lpgStationId: integer("lpg_station_id").references(() => lpgStations.id, { onDelete: "set null" }),
    // Bank details (JSONB)
    bankDetails: jsonb("bank_details").default(sql`'{}'::jsonb`),
    // Structured plural forms: a customer can have several of each.
    // contacts:  [{ name, role, phone, email }]
    // addresses: [{ label, address, city, state }]
    contacts: jsonb("contacts").default(sql`'[]'::jsonb`),
    addresses: jsonb("addresses").default(sql`'[]'::jsonb`),
    // Paystack DVA
    paystackCustomerId: varchar("paystack_customer_id", { length: 100 }).default(""),
    virtualAccountNumber: varchar("virtual_account_number", { length: 30 }).default(""),
    virtualAccountBank: varchar("virtual_account_bank", { length: 100 }).default(""),
    virtualAccountName: varchar("virtual_account_name", { length: 255 }).default(""),
    creditLimit: decimal("credit_limit", { precision: 15, scale: 2 }).default("0"),
    status: deliveryCustomerStatusEnum("status").default("active").notNull(),
    notes: text("notes").default(""),
    lastTransactionDate: timestamp("last_transaction_date", { withTimezone: true }),
    createdBy: integer("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_customers_code_idx").on(table.customerCode),
    index("delivery_customers_type_idx").on(table.customerType),
    index("delivery_customers_status_idx").on(table.status),
    index("delivery_customers_virtual_account_idx").on(table.virtualAccountNumber),
    uniqueIndex("delivery_customers_lpg_station_uidx")
      .on(table.lpgStationId)
      .where(sql`${table.lpgStationId} IS NOT NULL`),
  ]
);

module.exports = { deliveryCustomers };
