const { eq, and, inArray, arrayOverlaps } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff, customers } = require("../db/schema");
const { toPrincipal } = require("../utils/principal");
const { normalizedKey } = require("../utils/phone");

/**
 * Turning a caller's idea of "who should hear this" into concrete recipients.
 *
 * Business code says `{ customerId: 12 }` or `{ roles: ["admin"] }`; this
 * module returns `{ principal, contact }` pairs, where `contact` carries the
 * email / phone / display name the email and SMS channels need. Resolving here
 * — once, in bulk — is what stops the fan-out from doing an N+1 lookup per
 * recipient per channel.
 *
 * A recipient spec is any of:
 *   { customerId }            one customer, looked up
 *   { customer }              a customer row already in hand (no query)
 *   { staffId } / { staff }   the same, for staff
 *   { roles: [...] }          every active staff member holding any of them
 *   { allStaff: true }        every active staff member
 *   { email, phone, name }    a contact with no account behind it
 *
 * Arrays of specs, and single specs, are both accepted.
 */

const clean = (v) => String(v ?? "").trim();

/** The contact details for a customer row. */
const customerContact = (row) => ({
  name: clean(row.name),
  email: clean(row.email),
  phone: clean(row.phone),
  companyName: clean(row.companyName),
  status: row.status,
});

/**
 * Which of a person's two numbers (or two addresses) a message goes to, by
 * their choice on Manage Users: 'main', 'alternate' or 'both'.
 *
 * A choice that names a contact they do not have falls back to the other one,
 * so somebody set to "alternate" with no alternate on file still hears, and
 * somebody whose only number is the alternate is not cut off. The same contact
 * entered twice is sent to once.
 */
const pickContacts = (choice, main, alt, sameKey = (v) => v.toLowerCase()) => {
  const m = clean(main);
  const a = clean(alt);
  let list;
  if (choice === "main") list = [m || a];
  else if (choice === "alternate") list = [a || m];
  else list = [m, a];
  const seen = new Set();
  return list.filter((v) => {
    if (!v) return false;
    const key = sameKey(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Staff have no single `name` column — the display name is built here.
 *
 * `phones` and `emails` are every destination the person chose; `phone` and
 * `email` stay as the first of each, for the gates and logs that only need to
 * know whether there is one.
 */
const staffContact = (row) => {
  const phones = pickContacts(row.smsTo, row.phoneNumber, row.altPhoneNumber, (v) => normalizedKey(v) || v);
  const emails = pickContacts(row.emailTo, row.email, row.altEmail);
  return {
    name: [clean(row.firstName), clean(row.surname)].filter(Boolean).join(" ") || clean(row.email),
    email: emails[0] || "",
    phone: phones[0] || "",
    emails,
    phones,
    // The login address. Password setup and reset mail goes here only — see
    // engine.deliverToRecipient.
    mainEmail: clean(row.email),
    roles: row.roles || [],
    isActive: row.isActive,
  };
};

// ─── Lookups ────────────────────────────────────────────────────────────────

const loadCustomers = async (ids) => {
  if (!ids.length) return new Map();
  const rows = await db.select().from(customers).where(inArray(customers.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
};

const loadStaff = async (ids) => {
  if (!ids.length) return new Map();
  const rows = await db.select().from(staff).where(inArray(staff.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
};

/**
 * Active staff holding any of `roles`.
 *
 * `arrayOverlaps` is Postgres's `&&` — one indexable predicate rather than a
 * chain of ORs, meaning "holds at least one of these roles", which is what an
 * operational broadcast wants.
 *
 * Drizzle's helper is used rather than a hand-written `sql` fragment because a
 * raw `sql\`${staff.roles} && ${roles}::text[]\`` binds a JS array as a single
 * scalar parameter — the query then fails with a cast error at run time, and
 * because notify() swallows its failures, every role broadcast would silently
 * reach nobody. The helper encodes the array literal properly.
 *
 * Suspended and deactivated accounts are excluded: notifying someone whose
 * access was revoked is at best noise, at worst operational detail leaking to
 * a former employee.
 */
const loadStaffByRoles = async (roles) => {
  if (!roles?.length) return [];
  return db
    .select()
    .from(staff)
    .where(
      and(
        arrayOverlaps(staff.roles, roles),
        eq(staff.isActive, true),
        eq(staff.suspended, false)
      )
    );
};

const loadAllActiveStaff = async () =>
  db
    .select()
    .from(staff)
    .where(and(eq(staff.isActive, true), eq(staff.suspended, false)));

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve one or many specs into deduplicated recipients.
 *
 * Deduplication matters more than it looks: a staff member who is both an
 * "admin" and a "finance" role holder appears twice in a two-role broadcast,
 * and without this they would get two identical notifications. Contact-only
 * recipients dedupe on their address instead, since they have no principal.
 *
 * @returns {Promise<Array<{principal: object|null, contact: object}>>}
 */
const resolve = async (specs) => {
  const list = (Array.isArray(specs) ? specs : [specs]).filter(Boolean);
  if (!list.length) return [];

  // Pass 1 — collect what needs loading, and take what is already in hand.
  const customerIds = new Set();
  const staffIds = new Set();
  const roleSet = new Set();
  let wantAllStaff = false;
  const resolved = [];

  for (const spec of list) {
    if (spec.customer?.id) {
      resolved.push({
        principal: toPrincipal("customer", spec.customer.id),
        contact: customerContact(spec.customer),
      });
    } else if (spec.customerId) {
      customerIds.add(Number(spec.customerId));
    }

    if (spec.staff?.id) {
      resolved.push({
        principal: toPrincipal("staff", spec.staff.id),
        contact: staffContact(spec.staff),
      });
    } else if (spec.staffId) {
      staffIds.add(Number(spec.staffId));
    }

    if (Array.isArray(spec.roles)) spec.roles.forEach((r) => roleSet.add(r));
    if (spec.role) roleSet.add(spec.role);
    if (spec.allStaff) wantAllStaff = true;

    // A contact with no account behind it — a password-setup email to an
    // address that cannot yet sign in, for instance.
    if (!spec.customer && !spec.customerId && !spec.staff && !spec.staffId && (spec.email || spec.phone)) {
      resolved.push({
        principal: null,
        contact: { name: clean(spec.name), email: clean(spec.email), phone: clean(spec.phone) },
      });
    }
  }

  // Pass 2 — one query per kind, never one per recipient.
  const [customerRows, staffRows, roleRows, allStaffRows] = await Promise.all([
    loadCustomers([...customerIds]),
    loadStaff([...staffIds]),
    wantAllStaff ? Promise.resolve([]) : loadStaffByRoles([...roleSet]),
    wantAllStaff ? loadAllActiveStaff() : Promise.resolve([]),
  ]);

  for (const id of customerIds) {
    const row = customerRows.get(id);
    if (row) resolved.push({ principal: toPrincipal("customer", row.id), contact: customerContact(row) });
  }
  for (const id of staffIds) {
    const row = staffRows.get(id);
    if (row) resolved.push({ principal: toPrincipal("staff", row.id), contact: staffContact(row) });
  }
  for (const row of [...roleRows, ...allStaffRows]) {
    resolved.push({ principal: toPrincipal("staff", row.id), contact: staffContact(row) });
  }

  // Pass 3 — dedupe. Principals key on their arc identity; contact-only
  // recipients key on the address, which is all they have.
  const seen = new Set();
  const unique = [];
  for (const r of resolved) {
    if (!r.principal && !r.contact.email && !r.contact.phone) continue;
    const key = r.principal
      ? `${r.principal.type}:${r.principal.id}`
      : `contact:${r.contact.email || r.contact.phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique;
};

module.exports = { resolve, customerContact, staffContact, pickContacts, loadStaffByRoles, loadAllActiveStaff };
