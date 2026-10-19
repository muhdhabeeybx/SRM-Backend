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
 * A per-user exception to the role-derived default page list. A row means
 * "for this user, this route is allowed/denied regardless of what their role
 * would otherwise show" — `allowed: true` grants a page their role wouldn't,
 * `allowed: false` hides a page their role would. No row for a route means
 * "fall back to whatever the role grants." `viewOnly` on an allowed row means
 * they may look and download but not change anything there.
 */
const staffPageOverrides = pgTable(
  "staff_page_overrides",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    routePath: varchar("route_path", { length: 100 }).notNull(),
    allowed: boolean("allowed").notNull(),
    /** Allowed to open and download, not to change (migration 0090). */
    viewOnly: boolean("view_only").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("staff_page_overrides_unique_idx").on(table.staffId, table.routePath),
    index("staff_page_overrides_staff_idx").on(table.staffId),
  ]
);

module.exports = { staffPageOverrides };
