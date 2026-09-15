const { sql, and, eq, arrayOverlaps, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff, depotStaff, pfiStaff } = require("../db/schema");

/**
 * Not "10 tickets are waiting" — "Usman Ibrahim has these ten to generate".
 *
 * The dashboard could already say how deep each desk's queue was, and the desk
 * nudge could tell the desk about it. Neither could answer the question an
 * admin actually asks, which is who is sitting on it. A count belongs to
 * nobody, so a queue 140 days deep was everybody's and therefore no-one's.
 *
 * ── Responsibility is role plus scope ──────────────────────────────────────
 *
 * A person owes a piece of work when they hold the desk's role AND the work is
 * inside their scope — their PFI assignments, or the depot it was raised at.
 * Both halves are needed. Role alone makes every ticketing officer in the
 * company responsible for Port Harcourt; scope alone makes the Calabar sales
 * manager responsible for gating trucks.
 *
 * ── Work nobody owns is reported, not hidden ───────────────────────────────
 *
 * Where no one on the desk is scoped to a batch, the work is listed under
 * nobody rather than spread across everyone with the role. That is a staffing
 * gap — ten tickets at a depot with no ticketing officer assigned — and it is
 * the most useful thing this service can surface. Quietly attributing it to
 * whoever happened to match would bury exactly the problem worth seeing.
 *
 * ── A closed batch is not pending ──────────────────────────────────────────
 *
 * Finished PFIs are excluded, as are gantry and delivery batches, which have
 * no ticketing desk and no gate at all. Same rule as the badges and the
 * nudges, in one shared fragment, so the three cannot drift.
 */

/** Batches nobody is working any more, and batches with no desk to wait for. */
const LIVE_PFI = sql`NOT EXISTS (
  SELECT 1 FROM pfis p
  WHERE p.id = o.pfi_id AND (p.status = 'finished' OR p.pfi_type IN ('gantry', 'delivery'))
)`;

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/**
 * Orders paid or released whose tickets were never generated.
 *
 * Dated from released_at, falling back to payment_confirmed_at then
 * created_at. released_at alone silently dropped every order still sitting at
 * Paid — that column is only written when an order is released — so the desk's
 * newest and often most urgent work was invisible while the badge counted it.
 */
const unticketedOrders = () => sql`
  SELECT o.id,
         o.order_number  AS "ref",
         o.depot_id      AS "depotId",
         o.pfi_id        AS "pfiId",
         d.name          AS "depotName",
         p.pfi_number    AS "pfiNumber",
         c.name          AS "customerName",
         o.quantity      AS "quantity",
         EXTRACT(EPOCH FROM (now() - COALESCE(o.released_at, o.payment_confirmed_at, o.created_at))) / 3600 AS "hoursWaiting"
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN depots d    ON d.id = o.depot_id
    LEFT JOIN pfis p      ON p.id = o.pfi_id
   WHERE o.status IN ('Paid', 'Released')
     AND o.payment_status IN ('Paid', 'Part Paid')
     AND ${LIVE_PFI}
     AND NOT EXISTS (SELECT 1 FROM order_trucks t WHERE t.order_id = o.id)
   ORDER BY COALESCE(o.released_at, o.payment_confirmed_at, o.created_at) ASC
`;

/** Trucks ticketed but never admitted to the yard. */
const trucksAwaitingEntry = () => sql`
  SELECT t.id,
         t.truck_number  AS "truckRef",
         o.order_number  AS "ref",
         o.depot_id      AS "depotId",
         o.pfi_id        AS "pfiId",
         d.name          AS "depotName",
         p.pfi_number    AS "pfiNumber",
         EXTRACT(EPOCH FROM (now() - t.created_at)) / 3600 AS "hoursWaiting"
    FROM order_trucks t
    JOIN orders o      ON o.id = t.order_id
    LEFT JOIN depots d ON d.id = o.depot_id
    LEFT JOIN pfis p   ON p.id = o.pfi_id
   WHERE t.status = 'pending'
     AND o.status IN ('Released', 'Loading')
     AND ${LIVE_PFI}
   ORDER BY t.created_at ASC
`;

/** Trucks on the yard that never gated out. */
const trucksOnYard = () => sql`
  SELECT t.id,
         t.truck_number  AS "truckRef",
         o.order_number  AS "ref",
         o.depot_id      AS "depotId",
         o.pfi_id        AS "pfiId",
         d.name          AS "depotName",
         p.pfi_number    AS "pfiNumber",
         EXTRACT(EPOCH FROM (now() - COALESCE(t.security_entered_at, t.created_at))) / 3600 AS "hoursWaiting"
    FROM order_trucks t
    JOIN orders o      ON o.id = t.order_id
    LEFT JOIN depots d ON d.id = o.depot_id
    LEFT JOIN pfis p   ON p.id = o.pfi_id
   WHERE t.status IN ('gated_in', 'loaded')
     AND o.status NOT IN ('Cancelled', 'Expired')
     AND ${LIVE_PFI}
   ORDER BY COALESCE(t.security_entered_at, t.created_at) ASC
`;

/**
 * The desks, and the sentence each one's work belongs in.
 *
 * `verb` completes "<name> needs to …", because the panel's whole purpose is to
 * read as an instruction to a person rather than a statistic about a queue.
 */
const DESKS = [
  {
    key: "tickets",
    label: "Loading tickets",
    roles: ["ticketing", "dispatch"],
    verb: "generate tickets for",
    unit: "order",
    fetch: unticketedOrders,
    describe: (r) => r.ref || `order ${r.id}`,
  },
  {
    key: "entry",
    label: "Gate in",
    roles: ["security_entry"],
    verb: "gate in",
    unit: "truck",
    fetch: trucksAwaitingEntry,
    describe: (r) => `${r.truckRef || "a truck"} on ${r.ref || "—"}`,
  },
  {
    key: "exit",
    label: "Gate out",
    roles: ["security_exit"],
    verb: "gate out",
    unit: "truck",
    fetch: trucksOnYard,
    describe: (r) => `${r.truckRef || "a truck"} on ${r.ref || "—"}`,
  },
];

/**
 * Everyone who could own a desk's work, with the scope that decides whether
 * they do.
 *
 * arrayOverlaps rather than a hand-written `&&` fragment: a raw
 * sql`${staff.roles} && ${roles}::text[]` binds the JS array as one scalar and
 * fails with a cast error at run time — the trap notifications/recipients.js
 * documents and deskNudge hit on its first run.
 *
 * Suspended and deactivated accounts are left out. Work cannot belong to
 * somebody who can no longer sign in, and showing it against their name would
 * read as covered when it is not.
 */
const deskStaff = async (desk) => {
  const people = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      surname: staff.surname,
      phoneNumber: staff.phoneNumber,
      roles: staff.roles,
      canViewAllLocations: staff.canViewAllLocations,
    })
    .from(staff)
    .where(
      and(
        arrayOverlaps(staff.roles, desk.roles),
        eq(staff.isActive, true),
        eq(staff.suspended, false),
      ),
    );

  if (people.length === 0) return [];

  const ids = people.map((p) => p.id);
  const [depotRows, pfiRows] = await Promise.all([
    db.select({ staffId: depotStaff.staffId, depotId: depotStaff.depotId })
      .from(depotStaff).where(inArray(depotStaff.staffId, ids)),
    db.select({ staffId: pfiStaff.staffId, pfiId: pfiStaff.pfiId })
      .from(pfiStaff).where(inArray(pfiStaff.staffId, ids)),
  ]);

  const depotsBy = new Map();
  for (const r of depotRows) {
    if (!depotsBy.has(r.staffId)) depotsBy.set(r.staffId, new Set());
    depotsBy.get(r.staffId).add(r.depotId);
  }
  const pfisBy = new Map();
  for (const r of pfiRows) {
    if (!pfisBy.has(r.staffId)) pfisBy.set(r.staffId, new Set());
    pfisBy.get(r.staffId).add(r.pfiId);
  }

  return people.map((p) => ({
    id: p.id,
    name: [p.firstName, p.surname].filter(Boolean).join(" ").trim() || `Staff #${p.id}`,
    phone: p.phoneNumber || null,
    roles: p.roles || [],
    depotIds: depotsBy.get(p.id) ?? new Set(),
    pfiIds: pfisBy.get(p.id) ?? new Set(),
    /**
     * A person with no assignments at all who can see every location.
     *
     * They are a fallback, not an owner. Treating unrestricted visibility as
     * ownership would hand every super admin every unticketed order in the
     * company and drown the real answer.
     */
    unrestricted: Boolean(p.canViewAllLocations) && !depotsBy.has(p.id) && !pfisBy.has(p.id),
  }));
};

/**
 * Does this piece of work fall to this person?
 *
 * PFI assignment is checked first and is the stronger claim: somebody put on a
 * named batch owns that batch's work even at a depot they are not otherwise
 * attached to.
 */
const owns = (person, item) => {
  if (item.pfiId != null && person.pfiIds.has(Number(item.pfiId))) return true;
  if (item.depotId != null && person.depotIds.has(Number(item.depotId))) return true;
  return false;
};

/**
 * One desk's outstanding work, grouped by the person who owes it.
 *
 * Several people can be scoped to the same depot, and the honest answer is
 * that the work falls to all of them — so an item may appear against more than
 * one name. Splitting it arbitrarily would invent an allocation nobody made,
 * and both people genuinely need to see it.
 */
const forDesk = async (desk) => {
  const [items, people] = await Promise.all([
    db.execute(desk.fetch()).then(rowsOf),
    deskStaff(desk),
  ]);

  const byPerson = new Map();
  const orphans = [];

  for (const item of items) {
    const owners = people.filter((p) => owns(p, item));
    if (owners.length === 0) {
      orphans.push(item);
      continue;
    }
    for (const p of owners) {
      if (!byPerson.has(p.id)) byPerson.set(p.id, { person: p, items: [] });
      byPerson.get(p.id).items.push(item);
    }
  }

  const shape = (item) => ({
    id: item.id,
    ref: item.ref || null,
    truckRef: item.truckRef || null,
    label: desk.describe(item),
    depotName: item.depotName || null,
    pfiNumber: item.pfiNumber || null,
    customerName: item.customerName || null,
    quantity: item.quantity != null ? Number(item.quantity) : null,
    hoursWaiting: Math.floor(Number(item.hoursWaiting) || 0),
  });

  /** By depot, so "10 tickets at Liquid Bulk" is readable at a glance. */
  const byLocation = (list) => {
    const m = new Map();
    for (const i of list) {
      const k = i.depotName || "No depot on the order";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count);
  };

  const assignments = [...byPerson.values()]
    .map(({ person, items: own }) => ({
      staffId: person.id,
      name: person.name,
      phone: person.phone,
      roles: person.roles,
      count: own.length,
      /** "needs to generate tickets for" — the panel prints this verbatim. */
      sentence: `${person.name} needs to ${desk.verb}`,
      locations: byLocation(own),
      oldestHours: Math.max(...own.map((i) => Math.floor(Number(i.hoursWaiting) || 0))),
      items: own.map(shape),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    desk: desk.key,
    label: desk.label,
    verb: desk.verb,
    unit: desk.unit,
    roles: desk.roles,
    total: items.length,
    assigned: items.length - orphans.length,
    assignments,
    /**
     * Work with nobody on the desk scoped to it. Named plainly, because this
     * is a staffing gap rather than a queue: it cannot be cleared by chasing
     * anybody, only by assigning somebody.
     */
    unassigned: {
      count: orphans.length,
      locations: byLocation(orphans),
      items: orphans.map(shape),
    },
    /** People on the desk who own nothing, so an admin can see spare capacity. */
    idle: people
      .filter((p) => !byPerson.has(p.id) && !p.unrestricted)
      .map((p) => ({ staffId: p.id, name: p.name })),
  };
};

/** Every desk, for the dashboard panel. */
const allDesks = async () => {
  const out = [];
  for (const desk of DESKS) {
    try {
      out.push(await forDesk(desk));
    } catch (err) {
      console.error(`[desk-assignments] ${desk.key} failed:`, err.message);
      out.push({ desk: desk.key, label: desk.label, failed: true, error: err.message });
    }
  }
  return out;
};

module.exports = { allDesks, forDesk, DESKS };
