const {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  real,
  decimal,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { depositStatusEnum, paymentMethodEnum, depositChannelEnum } = require("./enums");
const { deliveryCustomers } = require("./deliveryCustomer");

const deliverySales = pgTable(
  "delivery_sales",
  {
    id: serial("id").primaryKey(),
    truckNumber: varchar("truck_number", { length: 30 }).default(""),
    dateLoaded: varchar("date_loaded", { length: 20 }).default(""),
    depotLoaded: varchar("depot_loaded", { length: 255 }).default(""),
    customerId: integer("customer_id").references(() => deliveryCustomers.id, { onDelete: "set null" }),
    customerName: varchar("customer_name", { length: 255 }).default(""),
    location: varchar("location", { length: 255 }).default(""),
    quantity: real("quantity").default(0),
    rate: decimal("rate", { precision: 15, scale: 2 }).default("0"),
    salesValue: decimal("sales_value", { precision: 15, scale: 2 }).default("0"),
    paymentAmount: decimal("payment_amount", { precision: 15, scale: 2 }).default("0"),
    expensesAmount: decimal("expenses_amount", { precision: 15, scale: 2 }).default("0"),
    balance: decimal("balance", { precision: 15, scale: 2 }).default("0"),
    payerName: varchar("payer_name", { length: 255 }).default(""),
    bank: varchar("bank", { length: 255 }).default(""),
    // Which bank account the money went into, as a real reference rather than
    // only the free-text `bank` string above. That string stays the source of
    // truth for every row written before this column existed, and is still
    // written alongside it, so historical rows keep resolving by account
    // number the way they always did.
    bankAccountId: integer("bank_account_id"),
    // POS or bank deposit — null on every pre-existing row and on rows that
    // are not remittances at all (a pump sale, an expense). See
    // depositChannelEnum for why it is not defaulted.
    depositChannel: depositChannelEnum("deposit_channel"),
    // The two legs of an overpayment moved between trucks share this id, so
    // the pair can be found from either end. Null on an ordinary payment.
    transferGroupId: varchar("transfer_group_id", { length: 64 }),
    /** The other truck and customer, as a label — "BWR810XB · Musa Damaturu". */
    transferCounterparty: varchar("transfer_counterparty", { length: 255 }),
    /**
     * The bank statement line this payment was claimed from.
     *
     * An order's payment has named its credit since the statement feature
     * existed; a truck sale's did not, and the amount, payer and date were
     * typed by hand off a phone screen. NULL on every row written before
     * migration 0044, and on a transfer between trucks — that moves money
     * already on the ledger rather than bringing new money in.
     */
    statementLineId: integer("statement_line_id"),
    /** The bank's own reference, copied off the line. "" on older rows. */
    bankRef: varchar("bank_ref", { length: 255 }).default("").notNull(),
    dateOfPayment: varchar("date_of_payment", { length: 20 }),
    depositStatus: depositStatusEnum("deposit_status").default("pending").notNull(),
    phoneNumber: varchar("phone_number", { length: 30 }).default(""),
    remarks: text("remarks").default(""),
    enteredBy: varchar("entered_by", { length: 255 }).default(""),
    allocationCode: varchar("allocation_code", { length: 100 }),
    collectionAccounts: jsonb("collection_accounts").default(sql`'[]'::jsonb`),
    remittanceAccounts: jsonb("remittance_accounts").default(sql`'[]'::jsonb`),
    paymentMethod: paymentMethodEnum("payment_method").default("manual").notNull(),
    paystackReference: varchar("paystack_reference", { length: 255 }),
    paystackDetails: jsonb("paystack_details"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("delivery_sales_customer_idx").on(table.customerId),
    index("delivery_sales_truck_idx").on(table.truckNumber),
    index("delivery_sales_deposit_channel_idx").on(table.depositChannel),
    uniqueIndex("delivery_sales_paystack_ref_unique_idx")
      .on(table.paystackReference)
      .where(sql`${table.paystackReference} IS NOT NULL AND ${table.paystackReference} != ''`),
  ]
);

module.exports = { deliverySales };
