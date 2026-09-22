const {
  pgTable,
  serial,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
} = require("drizzle-orm/pg-core");

const bankAccounts = pgTable("bank_accounts", {
  id: serial("id").primaryKey(),
  bankName: varchar("bank_name", { length: 100 }).notNull(),
  accountName: varchar("account_name", { length: 255 }).notNull(),
  accountNumber: varchar("account_number", { length: 50 }).notNull(),
  bankCode: varchar("bank_code", { length: 50 }).default(""),
  branchName: varchar("branch_name", { length: 150 }).default(""),
  currency: varchar("currency", { length: 10 }).default("NGN").notNull(),
  status: varchar("status", { length: 20 }).default("Active").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  /**
   * Which PFIs collect into this account — the assignment that matters.
   *
   * Two PFIs can run out of one location at the same time and need separate
   * accounts, which a location-level link cannot express. See migration 0012.
   */
  pfiIds: jsonb("pfi_ids").default([]).notNull(),
  /**
   * When each of those PFIs was attached — { "<pfi id>": "<iso timestamp>" }.
   *
   * An annotation beside pfiIds, never a second answer to what is assigned:
   * the same writes maintain it, keeping the stamp of a PFI still assigned and
   * dropping one removed. Empty for every assignment made before migration
   * 0054, which is deliberately not backfilled — see the migration.
   */
  pfiAssignedAt: jsonb("pfi_assigned_at").default({}).notNull(),
  /**
   * Derived from the locations of `pfiIds` on every save, never picked by
   * hand. Kept so everything already reading it — the subaccount lookup,
   * staff scope, the accounts list — keeps working unchanged.
   */
  depotIds: jsonb("depot_ids").default([]).notNull(),
  lpgStationIds: jsonb("lpg_station_ids").default([]).notNull(),
  /** Which areas may collect into this account: "truck_sales", "expenses". */
  usage: jsonb("usage").default([]).notNull(),
  notes: text("notes").default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

module.exports = { bankAccounts };
