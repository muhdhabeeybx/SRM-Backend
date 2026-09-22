const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  real,
  decimal,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { pfiStatusEnum } = require("./enums");
const { depots } = require("./depot");
const { lpgStations } = require("./lpgStation");
const { products } = require("./product");
const { staff } = require("./staff");

const pfis = pgTable(
  "pfis",
  {
    id: serial("id").primaryKey(),
    pfiNumber: varchar("pfi_number", { length: 100 }).notNull(),
    // "coastal" or "gantry". A coastal batch arrives by sea, so it is billed on
    // the BL figure and carries vessel and surveyor details; a gantry batch is
    // an allocation bought at the loading gantry and split into tickets, with
    // one quantity and none of that. Everything that reads a BL, a surplus or a
    // vessel is coastal-only — see lib/pfiFinance.js.
    pfiType: varchar("pfi_type", { length: 20 }).default("coastal").notNull(),
    status: pfiStatusEnum("status").default("active").notNull(),
    description: text("description").default(""),
    pfiDate: timestamp("pfi_date", { withTimezone: true }),
    /**
     * The day this PFI started taking money.
     *
     * Confirming an order's payment offers the unmatched credits on the
     * account it collects into — and one account collects for as many as
     * twenty-six PFIs, so the account alone does not narrow a credit to one
     * cargo. Credits older than this are held back, behind an explicit
     * "include earlier credits".
     *
     * Its own date rather than pfi_date, which is the document's date and not
     * when money starts arriving: customers pay ahead of a cargo being
     * raised. NULL means no window — every credit stays on offer. See
     * migration 0052.
     */
    collectionsOpenFrom: date("collections_open_from"),
    locationId: integer("location_id").references(() => depots.id, { onDelete: "set null" }),
    lpgStationId: integer("lpg_station_id").references(() => lpgStations.id, { onDelete: "set null" }),
    locationName: varchar("location_name", { length: 255 }).default(""),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    productName: varchar("product_name", { length: 255 }).default(""),
    productUnit: varchar("product_unit", { length: 30 }).default("Litres"),
    // The measured figure — what actually landed in the tank. This is what you
    // sell from, so the stock balance runs off it.
    startingQtyLitres: integer("starting_qty_litres").default(0).notNull(),
    // The documented figure from the shipping papers. This is what you are
    // charged for, so cargo value is computed from it — never from the tank.
    // Nullable with no default: null means "not entered yet", which is what
    // makes every downstream money figure read "—" instead of a false ₦0.
    blQtyLitres: integer("bl_qty_litres"),
    // The same "not entered yet" figure as blQtyLitres, in MT — nullable with
    // no default for the same reason: an unknown BL weight must not read as 0.
    //
    // Tonnage is decimal in reality (14832.20 MT) and these are
    // display/reporting figures, so exact numeric — float4 cannot even
    // represent 19863.55 and would show 19863.549805.
    blQtyMt: decimal("bl_qty_mt", { precision: 14, scale: 2 }),
    qtyVolumeMt: decimal("qty_volume_mt", { precision: 14, scale: 2 }).default("0"),
    // Gantry only: how many tickets the allocation was split into. Nullable
    // with no default for the same reason as blQtyLitres — a batch nobody has
    // counted tickets for is not a batch with zero tickets.
    ticketCount: integer("ticket_count"),
    soldQtyLitres: integer("sold_qty_litres").default(0).notNull(),
    totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).default("0"),
    unitPrice: decimal("unit_price", { precision: 15, scale: 2 }).default("0"),
    // Rebate, discount or claim credited back against this cargo. Subtracted
    // from total cost to get the grand total cost — see lib/pfiFinance.js.
    creditBalance: decimal("credit_balance", { precision: 15, scale: 2 }).default("0"),
    // Officers (FK to staff)
    auditOfficerId: integer("audit_officer_id").references(() => staff.id, { onDelete: "set null" }),
    auditOfficerName: varchar("audit_officer_name", { length: 255 }).default(""),
    productOfficerId: integer("product_officer_id").references(() => staff.id, { onDelete: "set null" }),
    productOfficerName: varchar("product_officer_name", { length: 255 }).default(""),
    itComplianceOfficerId: integer("it_compliance_officer_id").references(() => staff.id, { onDelete: "set null" }),
    itComplianceOfficerName: varchar("it_compliance_officer_name", { length: 255 }).default(""),
    securityExitOfficerId: integer("security_exit_officer_id").references(() => staff.id, { onDelete: "set null" }),
    securityExitOfficerName: varchar("security_exit_officer_name", { length: 255 }).default(""),
    commissionOfficerId: integer("commission_officer_id").references(() => staff.id, { onDelete: "set null" }),
    commissionOfficerName: varchar("commission_officer_name", { length: 255 }).default(""),
    salesManagerId: integer("sales_manager_id").references(() => staff.id, { onDelete: "set null" }),
    salesManagerName: varchar("sales_manager_name", { length: 255 }).default(""),
    // Vessel & Surveyor
    vesselBroker: varchar("vessel_broker", { length: 255 }).default(""),
    vesselName: varchar("vessel_name", { length: 255 }).default(""),
    surveyorName: varchar("surveyor_name", { length: 255 }).default(""),
    surveyorPhone: varchar("surveyor_phone", { length: 30 }).default(""),
    // Closure data
    closureDate: timestamp("closure_date", { withTimezone: true }),
    totalInflow: decimal("total_inflow", { precision: 15, scale: 2 }).default("0"),
    closureBank: varchar("closure_bank", { length: 255 }).default(""),
    purchaseCost: decimal("purchase_cost", { precision: 15, scale: 2 }).default("0"),
    aggregateExpenses: decimal("aggregate_expenses", { precision: 15, scale: 2 }).default("0"),
    closureHandler: varchar("closure_handler", { length: 255 }).default(""),
    closureRemarks: text("closure_remarks").default(""),
    /**
     * The review gate — see migration 0046.
     *
     * A PFI is raised not_started and cannot trade until somebody who did not
     * raise it assigns its bank account and officers. Both halves are named:
     * an approval nobody is recorded on is not an approval.
     */
    raisedBy: integer("raised_by"),
    raisedAt: timestamp("raised_at", { withTimezone: true }),
    activatedBy: integer("activated_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    reviewNote: text("review_note").default("").notNull(),
    /**
     * A trucking PFI's unwritten batch, parked until activation.
     *
     * Writing the trucks at raise time would put the loads on the inventory
     * and into the sales ledger — owing money — against a batch nobody had
     * signed off, which is what the gate exists to prevent. Cleared once
     * spent.
     */
    pendingBatch: jsonb("pending_batch"),
    /** The delivery batch this PFI raised, by its code. Trucking only. */
    allocationCode: varchar("allocation_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pfis_pfi_number_idx").on(table.pfiNumber),
    index("pfis_location_product_status_idx").on(table.locationId, table.productId, table.status),
    index("pfis_lpg_station_idx").on(table.lpgStationId),
    index("pfis_status_idx").on(table.status),
    index("pfis_pfi_type_idx").on(table.pfiType),
    check("pfis_qty_check", sql`${table.startingQtyLitres} >= 0`),
    check("pfis_sold_qty_check", sql`${table.soldQtyLitres} >= 0`),
    check("pfis_pfi_type_check", sql`${table.pfiType} IN ('coastal', 'gantry')`),
    check("pfis_ticket_count_check", sql`${table.ticketCount} IS NULL OR ${table.ticketCount} >= 0`),
  ]
);

module.exports = { pfis };
