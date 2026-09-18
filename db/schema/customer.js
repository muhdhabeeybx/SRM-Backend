const {
  pgTable,
  serial,
  varchar,
  text,
  decimal,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const { customerStatusEnum, customerCreatedViaEnum } = require("./enums");

const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).default(""),
    phone: varchar("phone", { length: 30 }).notNull(),
    /**
     * Last 10 digits, generated and stored — the same key `contacts` is
     * deduped on, so the two tables identify a person the same way.
     *
     * Not unique (yet). `customers_phone_idx` below is unique on the RAW
     * string, which lets "0803…" and "+234803…" both exist; the live book
     * already has such pairs. They are surfaced for a human to merge rather
     * than dropped by a constraint, because a customer row carries orders and
     * a wallet balance. See migration 0016.
     */
    phoneNormalized: varchar("phone_normalized", { length: 20 }).generatedAlwaysAs(
      sql`RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10)`
    ),
    companyName: varchar("company_name", { length: 255 }).default(""),
    address: text("address").default(""),
    status: customerStatusEnum("status").default("Active").notNull(),
    // Staff-managed suppression for the messaging feature — set from the
    // customer record, respected by segment resolution. Not a self-service
    // unsubscribe; there's no inbound SMS/email loop wired up for that.
    marketingOptOut: boolean("marketing_opt_out").default(false).notNull(),
    // Which surface created this customer. WhatsApp-created customers are
    // Active with phone_verified_at set on creation — the message itself
    // proved phone control, so no OTP was sent.
    createdVia: customerCreatedViaEnum("created_via").default("desk").notNull(),
    balance: decimal("balance", { precision: 15, scale: 2 }).default("0").notNull(),
    deposit: decimal("deposit", { precision: 15, scale: 2 }).default("0").notNull(),
    previousDeposit: decimal("previous_deposit", { precision: 15, scale: 2 }).default("0").notNull(),
    paystackCustomerId: varchar("paystack_customer_id", { length: 100 }).default(""),
    virtualAccountNumber: varchar("virtual_account_number", { length: 30 }).default(""),
    virtualAccountBank: varchar("virtual_account_bank", { length: 100 }).default(""),
    virtualAccountName: varchar("virtual_account_name", { length: 255 }).default(""),
    dvaSubaccountCode: varchar("dva_subaccount_code", { length: 100 }).default(""),
    /**
     * Per-litre commission agreed with this customer, wherever they buy.
     *
     * Overrides depot_product_commissions, which is keyed on the depot and the
     * product and knows nothing about who is buying. Nullable with no default,
     * and the distinction matters: NULL means "no agreement, use the usual
     * rate", while 0 means "this customer earns nothing" — a real agreement
     * somebody made. A NOT NULL DEFAULT 0 would turn every customer in the
     * book into the second one overnight.
     *
     * Only ever decides what the NEXT order snapshots. See
     * services/commission.service.js.
     */
    commissionRate: decimal("commission_rate", { precision: 15, scale: 2 }),
    // Commission payout bank details — where the company sends commission payments.
    commissionBankName: varchar("commission_bank_name", { length: 255 }).default(""),
    commissionAccountName: varchar("commission_account_name", { length: 255 }).default(""),
    commissionAccountNumber: varchar("commission_account_number", { length: 30 }).default(""),
    // Written by verify-otp; cleared by any phone change, which also revokes
    // every session for the customer.
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("customers_phone_idx").on(table.phone),
    index("customers_email_idx").on(table.email),
    index("customers_virtual_account_idx").on(table.virtualAccountNumber),
  ]
);

module.exports = { customers };
