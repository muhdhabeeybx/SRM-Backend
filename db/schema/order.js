const {
  pgTable,
  serial,
  varchar,
  integer,
  decimal,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");
const {
  orderDeliveryTypeEnum,
  orderPaymentStatusEnum,
  orderStatusEnum,
} = require("./enums");
const { customers } = require("./customer");
const { depots } = require("./depot");
const { products } = require("./product");
const { staff } = require("./staff");
const { pfis } = require("./pfi");

const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: varchar("order_number", { length: 50 }).notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    state: varchar("state", { length: 100 }).notNull(),
    depotId: integer("depot_id")
      .notNull()
      .references(() => depots.id, { onDelete: "restrict" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    price: decimal("price", { precision: 15, scale: 2 }).notNull(),
    totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
    // What has actually been received against this order, across however many
    // instalments it took. `totalAmount - amountPaid` is the balance still
    // expected, and `amountPaid / price` is the quantity that may be ticketed
    // — see releasableQuantity in services/order.service.js.
    //
    // Not capped at totalAmount on purpose: an overpayment is a real thing the
    // finance report reports, and rejecting it here would turn a fact into a
    // failed request. See db/migrations/0020.
    amountPaid: decimal("amount_paid", { precision: 15, scale: 2 }).default("0").notNull(),
    deliveryType: orderDeliveryTypeEnum("delivery_type").notNull(),
    /**
     * How many trucks this order is expected to take, stated when it is
     * raised.
     *
     * order_trucks rows only exist once tickets are generated, so without this
     * nothing knows how many an order is waiting for: every screen counts
     * ORDERS awaiting tickets when the work is per truck, and a six-truck
     * order with two ticketed looks exactly like a two-truck order that is
     * finished.
     *
     * Nullable, and left null rather than guessed. Historic orders have nobody
     * to ask and an order can be raised before the haulage is settled — so the
     * absence of a figure is honest, and the UI says "3 ticketed" instead of
     * inventing a total from litres over a typical truck size.
     */
    expectedTrucks: integer("expected_trucks"),
    // Where the truck goes on a delivery order — free text, the customer's
    // words. Empty for pickup (the depot is the address) and for orders
    // predating the column. `state` above stays the routing/pricing field.
    deliveryAddress: text("delivery_address").default("").notNull(),
    // The company the customer is buying for on this order — may differ from
    // the customer's own registered companyName on their profile.
    companyName: varchar("company_name", { length: 255 }).default("").notNull(),
    pfiId: integer("pfi_id").references(() => pfis.id, { onDelete: "set null" }),
    virtualAccountNumber: varchar("virtual_account_number", { length: 30 }).default(""),
    virtualAccountBank: varchar("virtual_account_bank", { length: 100 }).default(""),
    virtualAccountName: varchar("virtual_account_name", { length: 255 }).default(""),
    paymentStatus: orderPaymentStatusEnum("payment_status").default("Unpaid").notNull(),
    status: orderStatusEnum("status").default("Pending").notNull(),

    // Accountability per stage. These columns — not audit_logs — are the source
    // for customer tracking; the audit log is the system-wide trail. A stage
    // reached at most once, so one timestamp per stage is lossless.
    // payment_confirmed_by is normally null: the webhook (actor_type=system)
    // confirms payment, not a person.
    paymentConfirmedAt: timestamp("payment_confirmed_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: integer("released_by").references(() => staff.id, { onDelete: "set null" }),
    // Stamped when the FIRST truck gates in — the order enters Loading.
    loadingStartedAt: timestamp("loading_started_at", { withTimezone: true }),
    // Stamped when the LAST truck exits — the fuel has physically left.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: integer("cancelled_by").references(() => staff.id, { onDelete: "set null" }),
    cancellationReason: text("cancellation_reason"),
    // Stamped when the expiry sweep lapses an unpaid order (no staff actor —
    // the system expires it, so there is no expiredBy).
    expiredAt: timestamp("expired_at", { withTimezone: true }),

    // Supplied by callers whose requests can be redelivered (the WhatsApp
    // CONFIRM step passes the message's wamid). A second placeOrder with the
    // same key returns the original order instead of creating a duplicate.
    idempotencyKey: varchar("idempotency_key", { length: 128 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("orders_order_number_idx").on(table.orderNumber),
    uniqueIndex("orders_idempotency_key_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("orders_customer_payment_created_idx").on(table.customerId, table.paymentStatus, table.createdAt),
    index("orders_virtual_account_payment_idx").on(table.virtualAccountNumber, table.paymentStatus),
    index("orders_status_idx").on(table.status),
    check("orders_quantity_check", sql`${table.quantity} > 0`),
    check("orders_price_check", sql`${table.price} >= 0`),
    check("orders_total_check", sql`${table.totalAmount} >= 0`),
    check("orders_amount_paid_check", sql`${table.amountPaid} >= 0`),
  ]
);

module.exports = { orders };
