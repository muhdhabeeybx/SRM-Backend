const {
  pgTable,
  bigserial,
  varchar,
  text,
  integer,
  decimal,
  timestamp,
  index,
} = require("drizzle-orm/pg-core");

/**
 * Every message the platform sent — SMS, email, WhatsApp — with Termii's
 * charge for each SMS. Written at the provider boundary and completed from
 * Termii's history. See db/migrations/0064 and services/messageLog.service.js.
 */
const messageLog = pgTable(
  "message_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    channel: varchar("channel", { length: 16 }).notNull(),
    provider: varchar("provider", { length: 20 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 255 }).default("").notNull(),
    recipient: varchar("recipient", { length: 255 }).default("").notNull(),
    recipientName: varchar("recipient_name", { length: 255 }).default("").notNull(),
    audience: varchar("audience", { length: 20 }).default("unknown").notNull(),
    staffId: integer("staff_id"),
    customerId: integer("customer_id"),
    category: varchar("category", { length: 20 }).default("transactional").notNull(),
    type: varchar("type", { length: 64 }).default("").notNull(),
    campaignId: integer("campaign_id"),
    route: varchar("route", { length: 20 }).default("").notNull(),
    sender: varchar("sender", { length: 64 }).default("").notNull(),
    subject: text("subject").default("").notNull(),
    body: text("body").default("").notNull(),
    status: varchar("status", { length: 24 }).default("sent").notNull(),
    providerStatus: varchar("provider_status", { length: 64 }).default("").notNull(),
    error: text("error"),
    amount: decimal("amount", { precision: 12, scale: 4 }),
    currency: varchar("currency", { length: 8 }).default("").notNull(),
    origin: varchar("origin", { length: 20 }).default("app").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    costSyncedAt: timestamp("cost_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("message_log_sent_idx").on(table.sentAt),
    index("message_log_channel_sent_idx").on(table.channel, table.sentAt),
  ]
);

module.exports = { messageLog };
