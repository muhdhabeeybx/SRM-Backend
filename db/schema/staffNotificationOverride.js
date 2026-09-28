const {
  pgTable,
  serial,
  integer,
  varchar,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { staff } = require("./staff");

/**
 * A per-person exception to the notifications their roles would give them —
 * staff_page_overrides' twin, for notifications instead of pages (migration
 * 0059). `choice` is a key in notifications/staffChoices.js. `enabled: true`
 * sends it to somebody their role would not; `enabled: false` stops it
 * reaching somebody it would. No row means "whatever the role gets".
 */
const staffNotificationOverrides = pgTable(
  "staff_notification_overrides",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    choice: varchar("choice", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("staff_notification_overrides_unique_idx").on(table.staffId, table.choice),
    index("staff_notification_overrides_choice_idx").on(table.choice),
  ]
);

module.exports = { staffNotificationOverrides };
