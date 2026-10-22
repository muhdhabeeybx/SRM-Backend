const {
  pgTable,
  smallint,
  integer,
  varchar,
  boolean,
  timestamp,
  primaryKey,
} = require("drizzle-orm/pg-core");
const { staff } = require("./staff");

/**
 * Standard pages per role, and roles given by a PFI slot — migration 0096.
 * See services/rolePages.service.js and services/pfiRoles.service.js.
 */

/** One row: whether role sets decide people's pages, and slots give roles. */
const rolePagesSwitch = pgTable("role_pages_switch", {
  id: smallint("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  seeded: boolean("seeded").notNull().default(false),
  changedBy: integer("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }),
});

/** The pages a role opens. Role 'everyone' is every signed-in staff member. */
const rolePageSets = pgTable(
  "role_page_sets",
  {
    role: varchar("role", { length: 64 }).notNull(),
    routePath: varchar("route_path", { length: 255 }).notNull(),
    viewOnly: boolean("view_only").notNull().default(false),
    updatedBy: integer("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.role, table.routePath] })]
);

/** Roles a person holds only because a PFI names them in a slot. */
const staffPfiRoles = pgTable(
  "staff_pfi_roles",
  {
    staffId: integer("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 64 }).notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.staffId, table.role] })]
);

module.exports = { rolePagesSwitch, rolePageSets, staffPfiRoles };
