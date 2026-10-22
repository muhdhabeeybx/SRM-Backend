const { and, eq, inArray, sql } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { staff, staffPfiRoles, pfiStaff } = require("../db/schema");
const { PFI_SLOTS, officersOn } = require("../lib/pfiSlots");
const { setAssignmentContext } = require("../lib/pfiAssignmentContext");
const auditLogRepo = require("../repositories/auditLog.repository");
const rolePages = require("./rolePages.service");

/**
 * Roles given by naming somebody on a PFI (migration 0096).
 *
 * Name a person in one of a PFI's officer slots and they hold that slot's
 * role (lib/pfiSlots.js) — and with it the role's pages — for as long as the
 * PFI is open. Take them out of the slot, or close the PFI, and the role goes,
 * unless they hold it in their own right too.
 *
 * ── Where the roles live ──────────────────────────────────────────────────
 *
 * In staff.roles, beside the person's own. Every desk, text, reminder and
 * gate reads staff.roles, so a role a PFI gives works everywhere a role
 * typed in Manage Users does, with nothing else changed. staff_pfi_roles
 * remembers which of them came from a PFI, so those — and only those — are
 * taken back. A person's own roles are staff.roles less those.
 *
 * ── When a PFI stops giving roles ─────────────────────────────────────────
 *
 * When it is closed with Close on its file (closure_date set). Selling out is
 * not closing: a sold-out PFI still has trucks to ticket and gate, so its
 * officers keep their roles until somebody closes it.
 *
 * Only while the Role pages switch is on (services/rolePages.service.js).
 * Turning it off takes every PFI-given role back.
 */

const OPEN_SQL = "(p.status <> 'finished' OR p.closure_date IS NULL)";
const SLOT_VALUES = PFI_SLOTS.map((s) => `('${s.role}', '${s.label}', p.${s.column})`).join(", ");
const SLOT_ORDER = PFI_SLOTS.map((s) => s.role);

/** The PFI assignment sources a slot writes. A PFI ticked in Manage Users is not one. */
const SLOT_SOURCES = new Set(["pfi_activation", "pfi_officers"]);

const toIds = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/**
 * Every slot naming these people (everybody when `staffIds` is null), and
 * whether its PFI still gives the role.
 */
const slotsNaming = async (staffIds = null) => {
  const ids = staffIds === null ? null : toIds(staffIds);
  if (ids && !ids.length) return [];
  const rows = await client`
    SELECT x.staff_id AS "staffId", x.role, x.label, p.id AS "pfiId", p.pfi_number AS "pfiNumber", p.status,
           ${client.unsafe(OPEN_SQL)} AS "open"
      FROM pfis p
      CROSS JOIN LATERAL (VALUES ${client.unsafe(SLOT_VALUES)}) AS x(role, label, staff_id)
     WHERE x.staff_id IS NOT NULL
       ${ids ? client`AND x.staff_id = ANY(${ids}::int[])` : client``}
     ORDER BY p.pfi_number, x.label`;
  return rows.map((r) => ({
    staffId: Number(r.staffId),
    role: r.role,
    label: r.label,
    pfiId: Number(r.pfiId),
    pfiNumber: r.pfiNumber,
    status: r.status,
    open: Boolean(r.open),
  }));
};

/** The roles open slots give each person, and the PFIs giving each. */
const wantedBy = (slots) => {
  const wanted = new Map();
  for (const s of slots) {
    if (!s.open) continue;
    if (!wanted.has(s.staffId)) wanted.set(s.staffId, new Map());
    const roles = wanted.get(s.staffId);
    if (!roles.has(s.role)) roles.set(s.role, []);
    if (!roles.get(s.role).includes(s.pfiNumber)) roles.get(s.role).push(s.pfiNumber);
  }
  return wanted;
};

/** The roles each of these people holds only because a PFI names them. */
const givenRolesFor = async (staffIds) => {
  const ids = toIds(staffIds);
  const byStaff = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byStaff;
  const rows = await db
    .select({ staffId: staffPfiRoles.staffId, role: staffPfiRoles.role })
    .from(staffPfiRoles)
    .where(inArray(staffPfiRoles.staffId, ids));
  for (const r of rows) byStaff.get(Number(r.staffId))?.push(r.role);
  return byStaff;
};

/**
 * Bring one person's roles in line with what their slots give.
 *
 * `wanted` is a Map of role -> PFI numbers. `own`, when given, replaces the
 * roles they hold in their own right (a save from Manage Users); otherwise
 * those stay as they are. The staff row is locked for the read-and-write, so a
 * Manage Users save and a PFI change cannot interleave and lose one another.
 *
 * Never leaves anybody with no role at all. Returns what changed, or null.
 */
const reconcile = async (staffId, wanted, { own = undefined, actorId = null, action = "staff.roles_from_pfis" } = {}) =>
  db.transaction(async (tx) => {
    const [row] = await tx.select({ roles: staff.roles }).from(staff).where(eq(staff.id, staffId)).for("update").limit(1);
    if (!row) return null;
    const given = (await tx.select({ role: staffPfiRoles.role }).from(staffPfiRoles).where(eq(staffPfiRoles.staffId, staffId)))
      .map((r) => r.role);

    const current = row.roles || [];
    const mine = own ?? current.filter((r) => !given.includes(r));
    const fromPfis = [...wanted.keys()].filter((r) => !mine.includes(r)).sort((a, b) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b));
    const next = [...new Set([...mine, ...fromPfis])];
    if (!next.length) return null;

    const added = next.filter((r) => !current.includes(r));
    const removed = current.filter((r) => !next.includes(r));
    const sameRoles = next.length === current.length && next.every((r, i) => r === current[i]);
    const sameGiven = fromPfis.length === given.length && fromPfis.every((r) => given.includes(r));
    if (sameRoles && sameGiven) return { added, removed };

    if (!sameRoles) await tx.update(staff).set({ roles: next, updatedAt: new Date() }).where(eq(staff.id, staffId));
    const takeBack = given.filter((r) => !fromPfis.includes(r));
    if (takeBack.length) {
      await tx.delete(staffPfiRoles).where(and(eq(staffPfiRoles.staffId, staffId), inArray(staffPfiRoles.role, takeBack)));
    }
    const give = fromPfis.filter((r) => !given.includes(r));
    if (give.length) {
      await tx.insert(staffPfiRoles).values(give.map((role) => ({ staffId, role }))).onConflictDoNothing();
    }

    if (added.length || removed.length) {
      await auditLogRepo.record({
        entityType: "staff",
        entityId: staffId,
        action,
        actor: actorId ? { type: "staff", staffId: actorId } : { type: "system" },
        metadata: {
          added,
          removed,
          // Which PFI gives each role it gave, in the words of its slot.
          fromPfis: Object.fromEntries(fromPfis.map((r) => [r, wanted.get(r) || []])),
        },
      }, tx);
    }
    return { added, removed };
  });

/**
 * Give and take back PFI roles for these people — everybody named anywhere,
 * or holding a role a PFI gave, when `staffIds` is null. Does nothing while
 * the switch is off. Returns who changed.
 */
const recompute = async ({ staffIds = null, actorId = null } = {}) => {
  if (!(await rolePages.isOn())) return [];
  const wanted = wantedBy(await slotsNaming(staffIds));
  let ids = staffIds === null ? null : toIds(staffIds);
  if (ids === null) {
    const holders = await db.selectDistinct({ staffId: staffPfiRoles.staffId }).from(staffPfiRoles);
    ids = toIds([...wanted.keys(), ...holders.map((h) => h.staffId)]);
  }
  const changes = [];
  for (const id of ids) {
    const result = await reconcile(id, wanted.get(id) || new Map(), { actorId });
    if (result && (result.added.length || result.removed.length)) changes.push({ staffId: id, ...result });
  }
  return changes;
};

/** The switch going off: every role a PFI gave is taken back. */
const takeBackAll = async ({ actorId = null } = {}) => {
  const holders = await db.selectDistinct({ staffId: staffPfiRoles.staffId }).from(staffPfiRoles);
  const changes = [];
  for (const { staffId } of holders) {
    const result = await reconcile(Number(staffId), new Map(), { actorId });
    if (result && result.removed.length) changes.push({ staffId: Number(staffId), ...result });
  }
  return changes;
};

/**
 * A save from Manage Users: `own` are the roles they hold in their own right.
 * The roles their PFIs give are kept on top while the switch is on.
 */
const saveOwnRoles = async (staffId, own, { actorId = null } = {}) => {
  const wanted = (await rolePages.isOn()) ? wantedBy(await slotsNaming([staffId])).get(Number(staffId)) : null;
  return reconcile(Number(staffId), wanted || new Map(), { own, actorId, action: "staff.roles_changed" });
};

/**
 * Who can see the PFI follows its slots once it trades.
 *
 * Activation gives every named officer sight of the PFI (pfi.repository
 * activate). A slot changed after that did nothing, so a new officer could
 * not open the PFI they were answerable for and the one replaced still could.
 * Now the new one is given it, and the one taken off loses it — unless a slot
 * is not why they have it: a PFI ticked on them in Manage Users stays theirs.
 */
const syncSight = async ({ before, after, context = {} }) => {
  if (!after || after.status !== "active") return;
  const had = officersOn(before);
  const has = officersOn(after);
  const gained = has.filter((id) => !had.includes(id));
  const lost = had.filter((id) => !has.includes(id));
  if (!gained.length && !lost.length) return;

  await db.transaction(async (tx) => {
    await setAssignmentContext(tx, context);
    for (const staffId of gained) {
      await tx.insert(pfiStaff).values({ pfiId: after.id, staffId }).onConflictDoNothing();
    }
    for (const staffId of lost) {
      const result = await tx.execute(sql`
        SELECT source FROM pfi_assignment_log
         WHERE pfi_id = ${after.id} AND staff_id = ${staffId} AND action = 'assigned'
         ORDER BY id DESC LIMIT 1`);
      const last = (result.rows ?? result)[0];
      if (last && SLOT_SOURCES.has(last.source)) {
        await tx.delete(pfiStaff).where(and(eq(pfiStaff.pfiId, after.id), eq(pfiStaff.staffId, staffId)));
      }
    }
  });
};

/**
 * The PFIs a person sees because a slot names them on one that has traded —
 * held now, so a save from Manage Users does not take them away.
 */
const slotPfiIdsHeld = async (staffId) => {
  const named = (await slotsNaming([staffId])).filter((s) => s.status !== "not_started").map((s) => s.pfiId);
  if (!named.length) return [];
  const held = await db
    .select({ pfiId: pfiStaff.pfiId })
    .from(pfiStaff)
    .where(and(eq(pfiStaff.staffId, Number(staffId)), inArray(pfiStaff.pfiId, named)));
  return toIds(held.map((h) => h.pfiId));
};

/**
 * For Manage Users: each person's slots, and which of their roles a PFI gave.
 * `slots` lists only PFIs that are still open.
 */
const forStaff = async (staffIds) => {
  const ids = toIds(staffIds);
  const [slots, given] = await Promise.all([slotsNaming(ids), givenRolesFor(ids)]);
  const byStaff = new Map(ids.map((id) => [id, { pfiRoles: given.get(id) || [], pfiSlots: [] }]));
  for (const s of slots) {
    if (!s.open) continue;
    byStaff.get(s.staffId)?.pfiSlots.push({ pfiId: s.pfiId, pfiNumber: s.pfiNumber, label: s.label, role: s.role });
  }
  return byStaff;
};

module.exports = {
  slotsNaming,
  recompute,
  takeBackAll,
  saveOwnRoles,
  syncSight,
  slotPfiIdsHeld,
  forStaff,
};
