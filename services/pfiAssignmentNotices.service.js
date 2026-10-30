const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { notify } = require("../notifications");
const { PFI_SLOTS } = require("../lib/pfiSlots");

/**
 * The text an officer gets when a PFI is put in their hands.
 *
 * Naming somebody in a PFI's slot makes them answerable for it, and until
 * 29 Oct 2026 nobody was told: PFI 55's four officers were named at Start
 * selling and heard nothing. Now each one hears which PFI, as what, and the
 * account its money comes into, which is the account its customers pay.
 *
 *   started     every officer the PFI names, for every slot they hold
 *   slot moved  on a PFI already selling, only the person newly named, and
 *               only for the slots that are new to them
 *
 * A PFI not started yet tells nobody. It has no account until Start selling,
 * its officers can still change, and Start selling texts them all.
 *
 * Fire-and-forget, and never throws: the PFI is already saved, and a phone
 * network must not turn that into an error.
 */

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/** staffId → the slot labels they hold, in the PFI form's order. */
const slotsHeld = (pfi) => {
  const held = new Map();
  for (const slot of PFI_SLOTS) {
    const id = Number(pfi?.[slot.idKey]);
    if (!Number.isInteger(id) || id <= 0) continue;
    held.set(id, [...(held.get(id) || []), slot.label]);
  }
  return held;
};

/** The slots somebody was put into by an edit: filled now, by someone else before. */
const slotsGained = (before, after) => {
  const gained = new Map();
  for (const slot of PFI_SLOTS) {
    const id = Number(after?.[slot.idKey]);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (id === Number(before?.[slot.idKey])) continue;
    gained.set(id, [...(gained.get(id) || []), slot.label]);
  }
  return gained;
};

/** The active accounts collecting for the PFI. */
const accountsFor = async (pfiId) =>
  rowsOf(
    await db.execute(sql`
      SELECT bank_name AS "bankName", account_number AS "accountNumber", account_name AS "accountName"
        FROM bank_accounts
       WHERE jsonb_typeof(pfi_ids) = 'array'
         AND pfi_ids @> ${JSON.stringify([Number(pfiId)])}::jsonb
         AND COALESCE(status, 'Active') = 'Active'
       ORDER BY is_default DESC, id
    `),
  );

/** staffId → first name, for the people still able to act. */
const firstNames = async (staffIds) => {
  if (!staffIds.length) return new Map();
  const rows = rowsOf(
    await db.execute(sql`
      SELECT id, first_name AS "firstName"
        FROM staff
       WHERE id IN (${sql.join(staffIds.map((id) => sql`${id}`), sql`, `)})
         AND is_active = true AND COALESCE(suspended, false) = false
    `),
  );
  return new Map(rows.map((r) => [Number(r.id), String(r.firstName || "").trim()]));
};

/** One text per person, naming every slot of theirs that is news. */
const tell = async (pfi, byStaff) => {
  if (!byStaff.size) return [];
  const [accounts, names] = await Promise.all([accountsFor(pfi.id), firstNames([...byStaff.keys()])]);
  const sent = [];
  for (const [staffId, roles] of byStaff) {
    if (!names.has(staffId)) continue;
    const data = { firstName: names.get(staffId), pfiId: pfi.id, pfiNumber: pfi.pfiNumber, roles, accounts };
    await notify("staff.pfi_assigned", { to: { staffId }, data });
    sent.push({ staffId, ...data });
  }
  return sent;
};

const later = (label, fn) => {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.error(`[pfiAssignmentNotices] ${label} failed:`, err.message));
};

/** A PFI started selling: every officer it names hears it. */
const pfiStarted = (pfi) => later("pfiStarted", () => tell(pfi, slotsHeld(pfi)));

/** A PFI's slots were edited: anybody newly named on a selling PFI hears it. */
const officersChanged = (before, after) => {
  if (after?.status !== "active") return;
  later("officersChanged", () => tell(after, slotsGained(before, after)));
};

module.exports = { pfiStarted, officersChanged, slotsHeld, slotsGained, accountsFor, tell };
