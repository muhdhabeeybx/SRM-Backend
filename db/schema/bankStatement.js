const {
  pgTable,
  pgEnum,
  serial,
  integer,
  varchar,
  text,
  numeric,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} = require("drizzle-orm/pg-core");

const { bankAccounts } = require("./bankAccount");

const statementLineStatus = pgEnum("statement_line_status", [
  "UNMATCHED",
  "MATCHED",
]);

/**
 * How to read one bank's export format. Set up once per account.
 *
 * Nigerian bank exports commonly split credits and debits into two columns
 * rather than one signed amount. When `creditColumn` is set the parser reads
 * that column only, so withdrawals never enter the pool.
 */
const bankStatementColumnMappings = pgTable(
  "bank_statement_column_mappings",
  {
    id: serial("id").primaryKey(),
    bankAccountId: integer("bank_account_id")
      .references(() => bankAccounts.id, { onDelete: "cascade" })
      .notNull(),
    // Zero-indexed position of the header row in the raw grid.
    headerRow: integer("header_row").default(0).notNull(),
    dateColumn: integer("date_column").notNull(),
    // Either a single signed amount column, or a dedicated credit column.
    amountColumn: integer("amount_column"),
    creditColumn: integer("credit_column"),
    depositorColumn: integer("depositor_column"),
    referenceColumn: integer("reference_column"),
    narrationColumn: integer("narration_column"),
    // The header labels captured at setup, for display.
    sampleHeaders: jsonb("sample_headers").default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One format per account.
    accountUnique: uniqueIndex("bscm_bank_account_unique").on(t.bankAccountId),
  }),
);

/** One uploaded file. */
const bankStatements = pgTable("bank_statements", {
  id: serial("id").primaryKey(),
  bankAccountId: integer("bank_account_id")
    .references(() => bankAccounts.id, { onDelete: "cascade" })
    .notNull(),
  filename: varchar("filename", { length: 255 }).default("").notNull(),
  uploadedBy: integer("uploaded_by"),
  rowCount: integer("row_count").default(0).notNull(),
  duplicateCount: integer("duplicate_count").default(0).notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A single credit row from a statement — the thing Finance matches against.
 *
 * `dedupKey` is a truncated SHA-256 of date|ref|amount|depositor, unique per
 * account, so re-uploading an overlapping date range cannot create duplicates.
 * The uniqueness is enforced here rather than in application code on purpose.
 */
const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: serial("id").primaryKey(),
    bankAccountId: integer("bank_account_id")
      .references(() => bankAccounts.id, { onDelete: "cascade" })
      .notNull(),
    statementId: integer("statement_id")
      .references(() => bankStatements.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * The date printed on the statement — a calendar date, not an instant.
     *
     * A timestamp was the wrong type: there is no hour or timezone on a bank
     * line, and storing one is how 1,066 rows ended up a day out. See
     * migration 0039.
     */
    txnDate: date("txn_date").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    depositor: varchar("depositor", { length: 255 }).default("").notNull(),
    bankRef: varchar("bank_ref", { length: 255 }).default("").notNull(),
    narration: text("narration").default("").notNull(),
    // The original row, kept for traceability.
    rawRow: jsonb("raw_row").default([]).notNull(),
    dedupKey: varchar("dedup_key", { length: 32 }).notNull(),
    status: statementLineStatus("status").default("UNMATCHED").notNull(),
    matchedOrderId: integer("matched_order_id"),
    matchedDepositId: integer("matched_deposit_id"),
    matchedBy: integer("matched_by"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dedupUnique: uniqueIndex("bsl_account_dedup_unique").on(t.bankAccountId, t.dedupKey),
    poolIdx: index("bsl_pool_idx").on(t.bankAccountId, t.status),
  }),
);

module.exports = {
  statementLineStatus,
  bankStatementColumnMappings,
  bankStatements,
  bankStatementLines,
};
