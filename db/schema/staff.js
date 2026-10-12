const {
  pgTable,
  serial,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");

const staff = pgTable(
  "staff",
  {
    id: serial("id").primaryKey(),
    firstName: varchar("first_name", { length: 100 }).notNull(),
    surname: varchar("surname", { length: 100 }).notNull(),
    otherNames: varchar("other_names", { length: 200 }).default(""),
    email: varchar("email", { length: 255 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 30 }),
    // A second number and address, and which of the two each kind of message
    // goes to: 'main', 'alternate' or 'both' (migration 0076; see
    // notifications/recipients.js staffContact).
    altPhoneNumber: varchar("alt_phone_number", { length: 30 }),
    altEmail: varchar("alt_email", { length: 255 }),
    smsTo: varchar("sms_to", { length: 10 }).default("both").notNull(),
    emailTo: varchar("email_to", { length: 10 }).default("both").notNull(),
    password: text("password"),
    isPasswordSet: boolean("is_password_set").default(false).notNull(),
    passwordResetToken: text("password_reset_token"),
    passwordResetExpires: timestamp("password_reset_expires", { withTimezone: true }),
    roles: text("roles").array().default(sql`ARRAY['admin']::text[]`).notNull(),
    // Whether this user sees every depot/LPG-station/PFI, or only the ones
    // assigned via depot_staff/lpg_station_staff/pfi_staff. Defaults true so
    // existing staff are unaffected until an admin explicitly scopes them.
    canViewAllLocations: boolean("can_view_all_locations").default(true).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    suspended: boolean("suspended").default(false).notNull(),
    profilePictureUrl: text("profile_picture_url"),
    profilePicturePublicId: text("profile_picture_public_id"),
    // `refresh_token` removed: refresh tokens live in `sessions`, one row per
    // device, stored only as a domain-separated SHA-256. A single plaintext
    // column per account could not express multiple devices and kept live
    // credential material at rest.
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("staff_email_idx").on(table.email),
  ]
);

module.exports = { staff };
