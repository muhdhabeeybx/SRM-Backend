const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  decimal,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  check, char } = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { expenseStatusEnum } = require("./enums");
const { pfis } = require("./pfi");
const { orders } = require("./order");
const { staff } = require("./staff");
const { vendors } = require("./vendor");
const { deliveryCustomers } = require("./deliveryCustomer");
const { lpgStations } = require("./lpgStation");

/**
 * The chart of accounts. A category is a GL account: it carries the code and
 * the group ("GL code / GL Name" on a payment schedule), and it is what an
 * expense line is booked to.
 *
 * The per-PFI system categories predate the chart and carry no GL code — they
 * only ever named a batch. Which cargo a cost lands on is now `pfiExpenses.pfiId`,
 * set from the PFI chosen on the form, and it is only allowed against a
 * `pfi_direct` account.
 */
const expenseCategories = pgTable(
  "expense_categories",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // Null only on the legacy per-PFI categories; every real account has one.
    glCode: varchar("gl_code", { length: 20 }),
    // One of GL_GROUPS: pfi_direct | administrative | depot |
    // sales_distribution | income. Drives the first dropdown on the form.
    glGroup: varchar("gl_group", { length: 40 }),
    // Optional heading inside a group (Staff & Employee, Finance, …). Only the
    // administrative group uses it.
    glSubgroup: varchar("gl_subgroup", { length: 60 }).default("").notNull(),
    // The PFI this legacy category stands for; null on every GL account.
    pfiId: integer("pfi_id").references(() => pfis.id, { onDelete: "cascade" }),
    // System categories are PFI-backed and cannot be renamed or deleted by hand.
    isSystemCategory: boolean("is_system_category").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("expense_categories_name_idx").on(table.name),
    // One category per PFI. Partial, so the many general categories (pfi_id null)
    // are unaffected.
    uniqueIndex("expense_categories_pfi_idx")
      .on(table.pfiId)
      .where(sql`${table.pfiId} IS NOT NULL`),
    // Same trick for the code: unique across the chart, absent on legacy rows.
    uniqueIndex("expense_categories_gl_code_idx")
      .on(table.glCode)
      .where(sql`${table.glCode} IS NOT NULL`),
  ]
);

/**
 * A cost booked against a GL account, with the invoice figures behind it.
 *
 * `amount` is the money that left the bank ("Amount paid") and is the only
 * figure any total reads. The invoice columns beside it document how that
 * figure was arrived at — ex-VAT, VAT, invoice total, WHT withheld — and feed
 * nothing but the schedule and the export.
 *
 * Deletes are soft: `deletedAt` is set, the row stays, and every total filters
 * it out.
 */
const pfiExpenses = pgTable(
  "pfi_expenses",
  {
    id: serial("id").primaryKey(),
    // Which cargo carries this cost. Denormalised on purpose: it is what every
    // total groups by, and it must not move afterwards. Only a `pfi_direct`
    // account may set it — see the controller.
    pfiId: integer("pfi_id").references(() => pfis.id, { onDelete: "set null" }),
    /**
     * The station or plant this cost was incurred for — at most one of them.
     *
     * A filling station is a delivery_customers row; an LPG plant has its own
     * table, hence two columns. Either set makes this a station or plant
     * expense, and `pfiId` beside it then says which of that subject's loads
     * it sits under rather than making it a cargo expense.
     *
     * This is money SOROMAN pays a vendor for that station. What the station
     * itself spends out of pump takings is delivery_sales.expenses_amount,
     * which is a debit against the station — the opposite direction, and
     * deliberately a different store. See migration 0055.
     */
    deliveryCustomerId: integer("delivery_customer_id")
      .references(() => deliveryCustomers.id, { onDelete: "set null" }),
    lpgStationId: integer("lpg_station_id")
      .references(() => lpgStations.id, { onDelete: "set null" }),
    categoryId: integer("category_id")
      .references(() => expenseCategories.id, { onDelete: "restrict" })
      .notNull(),
    expenseDate: timestamp("expense_date", { withTimezone: true }).defaultNow().notNull(),
    // Snapshot of the vendor's name at the time this was raised — never a live
    // lookup, so renaming a vendor later never rewrites this row. Still the
    // only vendor field on rows raised before the vendor list existed.
    vendor: varchar("vendor", { length: 255 }).default(""),
    // Set only when the requester picked (or saved) an entry from the vendor
    // list; null on free-typed, never-saved vendor names.
    vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    // The vendor's Tax Identification Number, as printed on their invoice.
    tinNumber: varchar("tin_number", { length: 30 }).default("").notNull(),
    invoiceNumber: varchar("invoice_number", { length: 100 }).default("").notNull(),
    // "Purpose" on the schedule.
    description: text("description").default(""),
    /**
     * What the request asks for: invoice amount less any WHT withheld,
     * denominated in `currency` below — NOT necessarily naira.
     */
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),

    // ── Currency ──────────────────────────────────────────────────────────
    //
    // The cargo accounts (5010 Vessel Hire, 5020 Freight, 5030 Demurrage,
    // 5310 Marine Insurance…) are billed by counterparties who invoice in
    // dollars. The foreign figure is the debt — it is what the vendor chases
    // and what the document an auditor reads actually says. Naira is a
    // translation of it, and it is translated twice: at the rate when the
    // request was raised, and again at the rate on the day it was paid.
    /** ISO 4217. 'NGN' for all but the vessel side. */
    currency: char("currency", { length: 3 }).default("NGN").notNull(),
    /** Naira per unit of `currency`, at the time of raising. Exactly 1 on NGN. */
    exchangeRate: decimal("exchange_rate", { precision: 18, scale: 6 }).default("1").notNull(),
    /**
     * The rate on the day it actually cleared. NULL until paid, and NULL
     * forever on a naira expense — "no conversion happened" and "the
     * conversion happened at parity" are different facts.
     */
    paidExchangeRate: decimal("paid_exchange_rate", { precision: 18, scale: 6 }),

    /**
     * The naira translations. GENERATED ALWAYS by the database — never written
     * from here, and Postgres refuses any attempt to.
     *
     * Every total in the system sums these rather than `amount`. The failure
     * mode if one is missed is silent: a $50,000 invoice adds 50,000 into a
     * naira total and understates it seventyfold, and nothing about the number
     * looks wrong. Deriving them in the database rather than in application
     * code is what makes that structurally impossible. See migration 0026.
     */
    amountNgn: decimal("amount_ngn", { precision: 15, scale: 2 }),
    amountPaidNgn: decimal("amount_paid_ngn", { precision: 15, scale: 2 }),

    // ── The invoice behind the payment ────────────────────────────────────
    // Null, not zero, when there is no invoice to document: a cash payment with
    // no VAT breakdown must not read as an invoice worth ₦0.
    amountExVat: decimal("amount_ex_vat", { precision: 15, scale: 2 }),
    /** VAT charged. Defaults to 7.5% of ex-VAT but is editable — not every vendor charges it. */
    vatAmount: decimal("vat_amount", { precision: 15, scale: 2 }),
    invoiceAmount: decimal("invoice_amount", { precision: 15, scale: 2 }),
    /** Withholding tax kept back: invoice amount − WHT is what the vendor receives. */
    whtDeduction: decimal("wht_deduction", { precision: 15, scale: 2 }).default("0").notNull(),
    /**
     * The rate that produced it, as a percentage. Null when the amount was
     * typed by hand — ₦5,000 withheld on ₦100,000 is either a correct 5% or a
     * mis-keyed 2%, and only the rate tells anyone which.
     */
    whtRate: decimal("wht_rate", { precision: 5, scale: 2 }),

    // ── Settlement ────────────────────────────────────────────────────────
    // Filled by the Expenditure Officer at the moment of payment, not by the
    // person who raised the request — until then nobody knows which account it
    // will come out of or what will actually clear.
    //
    // NULL means unpaid. Distinct from 0 on purpose: every total falls back to
    // `amount` when this is null, so a request approved for ₦1m never reads as
    // ₦0 of spend while it waits.
    amountPaid: decimal("amount_paid", { precision: 15, scale: 2 }),
    bankPaidFrom: varchar("bank_paid_from", { length: 255 }).default(""),
    /** Teller or transfer reference for the payment itself. */
    paymentReference: varchar("payment_reference", { length: 100 }).default("").notNull(),
    /** The vendor's own receipt or document reference, captured on the request. */
    receiptReference: varchar("receipt_reference", { length: 100 }).default(""),
    /** When the payment actually cleared — editable, distinct from `paidAt` (the system timestamp of the mark-paid action). */
    paymentDate: timestamp("payment_date", { withTimezone: true }),
    paymentMethod: varchar("payment_method", { length: 30 }).default("").notNull(),
    /** Required by the controller when amountPaid differs from amount — otherwise free-form context. */
    paymentNotes: text("payment_notes").default("").notNull(),

    // ── Where the money is going ──────────────────────────────────────────
    // Captured on the request so an approver can see the destination account
    // before authorising, rather than after.
    payeeBankName: varchar("payee_bank_name", { length: 200 }).default(""),
    /** The payee bank's sort/CBN code, for the transfer schedule. */
    bankCode: varchar("bank_code", { length: 20 }).default("").notNull(),
    payeeAccountNumber: varchar("payee_account_number", { length: 50 }).default(""),
    payeeAccountName: varchar("payee_account_name", { length: 255 }).default(""),

    // ── The approval chain ────────────────────────────────────────────────
    status: expenseStatusEnum("status").default("pending").notNull(),

    // One pair per stage, written once and never overwritten, so who signed
    // what survives even after the request moves on. `reviewed*` is the
    // opposite: "last touched by", rewritten on every transition.
    verifiedBy: integer("verified_by").references(() => staff.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    auditApprovedBy: integer("audit_approved_by").references(() => staff.id, { onDelete: "set null" }),
    auditApprovedAt: timestamp("audit_approved_at", { withTimezone: true }),
    adminApprovedBy: integer("admin_approved_by").references(() => staff.id, { onDelete: "set null" }),
    adminApprovedAt: timestamp("admin_approved_at", { withTimezone: true }),
    paidBy: integer("paid_by").references(() => staff.id, { onDelete: "set null" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),

    reviewedBy: integer("reviewed_by").references(() => staff.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Most recent reason only. Durable history lives in pfi_expense_audits —
    // read reasons from there, or a rejection note vanishes once the corrected
    // request is later approved.
    reviewNote: text("review_note").default(""),

    addedBy: integer("added_by").references(() => staff.id, { onDelete: "set null" }),
    editedBy: integer("edited_by").references(() => staff.id, { onDelete: "set null" }),
    // Free-text display name, kept for historical rows.
    enteredBy: varchar("entered_by", { length: 255 }).default(""),
    // The actual audit trail.
    recordedBy: integer("recorded_by").references(() => staff.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // EXP-{year}-{id, zero-padded}. Generated from `id` and `created_at`, both
    // immutable, so it can never collide or drift from the row it names.
    referenceNumber: varchar("reference_number", { length: 20 }).generatedAlwaysAs(
      sql`'EXP-' || EXTRACT(YEAR FROM created_at AT TIME ZONE 'UTC')::int::text || '-' || LPAD(id::text, 6, '0')`
    ),
  },
  (table) => [
    index("pfi_expenses_pfi_idx").on(table.pfiId),
    index("pfi_expenses_delivery_customer_idx").on(table.deliveryCustomerId),
    index("pfi_expenses_lpg_station_idx").on(table.lpgStationId),
    // A row cannot be two subjects at once: a station expense and a plant
    // expense are different registers, and a row claiming both is counted in
    // each. See migration 0055.
    check(
      "pfi_expenses_one_subject",
      sql`${table.deliveryCustomerId} IS NULL OR ${table.lpgStationId} IS NULL`,
    ),
    index("pfi_expenses_category_idx").on(table.categoryId),
    index("pfi_expenses_date_idx").on(table.expenseDate),
    index("pfi_expenses_status_idx").on(table.status),
    index("pfi_expenses_vendor_idx").on(table.vendorId),
    uniqueIndex("pfi_expenses_reference_number_idx").on(table.referenceNumber),
    // Every total reads live rows only; this keeps that path off a seq scan.
    index("pfi_expenses_live_idx").on(table.pfiId).where(sql`${table.deletedAt} IS NULL`),
    check("pfi_expenses_amount_check", sql`${table.amount} >= 0`),
  ]
);

/**
 * Append-only stock ledger. One row per release; the unique constraint on
 * (order, action) is what makes ticket generation idempotent — the same order
 * can never deduct the same PFI twice no matter how often it runs.
 */
const pfiMovements = pgTable(
  "pfi_movements",
  {
    id: serial("id").primaryKey(),
    pfiId: integer("pfi_id")
      .references(() => pfis.id, { onDelete: "cascade" })
      .notNull(),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 30 }).default("RELEASE").notNull(),
    qtyLitres: integer("qty_litres").notNull(),
    notes: text("notes").default(""),
    recordedBy: integer("recorded_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pfi_movements_order_action_idx").on(table.orderId, table.action),
    index("pfi_movements_pfi_idx").on(table.pfiId),
  ]
);

/**
 * A receipt or supporting document.
 *
 * No type, size or count validation anywhere — deliberately. A receipt is
 * whatever the vendor handed over, and refusing a file at upload time just
 * means it never gets attached at all.
 */
const pfiExpenseAttachments = pgTable(
  "pfi_expense_attachments",
  {
    id: serial("id").primaryKey(),
    expenseId: integer("expense_id")
      .references(() => pfiExpenses.id, { onDelete: "cascade" })
      .notNull(),
    // Storage key, not a public URL. Files are streamed through an authorised
    // route so receipts never sit on a public path.
    storageKey: text("storage_key").notNull(),
    fileName: varchar("file_name", { length: 255 }).default(""),
    contentType: varchar("content_type", { length: 120 }).default(""),
    sizeBytes: integer("size_bytes").default(0),
    // invoice | quotation | receipt | supporting_approval | payment_evidence |
    // other. Null on every upload made before this existed.
    type: varchar("type", { length: 30 }),
    uploadedBy: integer("uploaded_by").references(() => staff.id, { onDelete: "set null" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("pfi_expense_attachments_expense_idx").on(table.expenseId)]
);

/** Every create, edit, delete and transition writes one of these. */
const pfiExpenseAudits = pgTable(
  "pfi_expense_audits",
  {
    id: serial("id").primaryKey(),
    expenseId: integer("expense_id").references(() => pfiExpenses.id, { onDelete: "cascade" }),
    // 40, not 20. The two post-settlement actions — amended_after_payment and
    // deleted_after_payment — are 21 characters, and the audit write happens
    // AFTER the change it records, so an overflow here loses the trail entry
    // while the change itself stands. See migration 0018.
    action: varchar("action", { length: 40 }).notNull(),
    changes: jsonb("changes").default({}),
    actorId: integer("actor_id").references(() => staff.id, { onDelete: "set null" }),
    actorName: varchar("actor_name", { length: 255 }).default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("pfi_expense_audits_expense_idx").on(table.expenseId)]
);

/**
 * The conversation on a request.
 *
 * Separate from `pfi_expense_audits`, which records what the system did, and
 * from `review_note`, which holds only the most recent reason and is wiped when
 * a corrected request is resubmitted. This is what people said to each other,
 * and it survives every transition — a reviewer's query and the requester's
 * answer both have to still be there when the next approver reads it.
 */
const pfiExpenseComments = pgTable(
  "pfi_expense_comments",
  {
    id: serial("id").primaryKey(),
    expenseId: integer("expense_id")
      .references(() => pfiExpenses.id, { onDelete: "cascade" })
      .notNull(),
    body: text("body").notNull(),
    authorId: integer("author_id").references(() => staff.id, { onDelete: "set null" }),
    // Kept beside the FK so a comment still reads correctly once the author
    // leaves and the staff row is cleared.
    authorName: varchar("author_name", { length: 255 }).default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("pfi_expense_comments_expense_idx").on(table.expenseId, table.createdAt)]
);

module.exports = {
  expenseCategories,
  pfiExpenses,
  pfiExpenseAttachments,
  pfiMovements,
  pfiExpenseAudits,
  pfiExpenseComments,
};
