const { sql, and, eq, arrayOverlaps } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff } = require("../db/schema");
const { notify } = require("../notifications");
const { sendSMSWithFallback } = require("./sms.service");

/**
 * Tell the desks what is still sitting on them.
 *
 * The work queues already answer "how much is waiting" on the dashboard, but
 * only for somebody who opens the dashboard. These are the same facts pushed
 * the other way, to the role that can actually clear them: tickets to
 * ticketing, arrivals to the entrance gate, departures to the exit gate.
 *
 * ── A digest, not a ping per row ───────────────────────────────────────────
 *
 * One message per role per run, carrying the count and the oldest few. The
 * alternative — a notification per unticketed order — is 75 notifications on
 * the first run and a habit of ignoring the bell by the second. A queue that
 * is 75 deep is one fact about the desk, not 75 facts.
 *
 * ── What counts ────────────────────────────────────────────────────────────
 *
 * The same exclusions the badges use, and for the same reasons: a batch that
 * has been closed is not work, and a gantry or delivery order has no loading
 * desk or gate to wait for. Nudging somebody about either teaches them the
 * nudge is wrong.
 */

/**
 * The work must be on a LIVE batch — stated positively, and that matters.
 *
 * This asked for the absence of a dead batch, which NOT EXISTS grants to any
 * order carrying no pfi_id at all: nothing matches, so nothing is excluded. 31
 * unticketed orders and 20 gate-pending trucks came through that way, all of
 * them between four and seven months old, and they were about to be texted to
 * a gate officer as today's backlog.
 *
 * Live means not finished, and not a gantry or delivery lifting — those have no
 * loading desk and no gate, so nudging anybody about them teaches them the
 * nudge is wrong. Orders with no batch are not nudged at all: they cannot be
 * ticketed, and the dashboard reports them as a records problem instead (see
 * deskAssignments' noBatch bucket).
 */
const LIVE_PFI = sql`EXISTS (
  SELECT 1 FROM pfis p
   WHERE p.id = o.pfi_id
     AND p.status <> 'finished'
     AND p.pfi_type NOT IN ('gantry', 'delivery')
)`;

/**
 * Orders released and paid whose tickets were never generated.
 *
 * Aged, because an order paid ten minutes ago is not a backlog — it is the
 * desk's ordinary in-tray, and calling it late is how a nudge becomes noise.
 */
const unticketedOrders = async (olderThanHours) => {
  const rows = await db.execute(sql`
    SELECT o.id, o.order_number AS "orderNumber", o.quantity, o.released_at AS "releasedAt",
           c.name AS "customerName", d.name AS "depotName",
           EXTRACT(EPOCH FROM (now() - o.released_at)) / 3600 AS "hoursWaiting"
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN depots d ON d.id = o.depot_id
     WHERE o.status IN ('Paid', 'Released')
       AND o.payment_status IN ('Paid', 'Part Paid')
       AND o.released_at < now() - (${olderThanHours} * interval '1 hour')
       AND ${LIVE_PFI}
     ORDER BY o.released_at ASC
  `);
  return rows.rows ?? rows;
};

/** Trucks ticketed but never admitted to the yard. */
const trucksAwaitingEntry = async (olderThanHours) => {
  const rows = await db.execute(sql`
    SELECT t.id, t.truck_number AS "truckNumber", o.order_number AS "orderNumber",
           d.name AS "depotName",
           EXTRACT(EPOCH FROM (now() - t.created_at)) / 3600 AS "hoursWaiting"
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
      LEFT JOIN depots d ON d.id = o.depot_id
     WHERE t.status = 'pending'
       AND o.status IN ('Released', 'Loading')
       AND t.created_at < now() - (${olderThanHours} * interval '1 hour')
       AND ${LIVE_PFI}
     ORDER BY t.created_at ASC
  `);
  return rows.rows ?? rows;
};

/** Trucks on the yard that never gated out. */
const trucksOnYard = async (olderThanHours) => {
  const rows = await db.execute(sql`
    SELECT t.id, t.truck_number AS "truckNumber", o.order_number AS "orderNumber",
           d.name AS "depotName",
           EXTRACT(EPOCH FROM (now() - COALESCE(t.security_entered_at, t.created_at))) / 3600 AS "hoursWaiting"
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
      LEFT JOIN depots d ON d.id = o.depot_id
     WHERE t.status IN ('gated_in', 'loaded')
       AND o.status NOT IN ('Cancelled', 'Expired')
       AND COALESCE(t.security_entered_at, t.created_at) < now() - (${olderThanHours} * interval '1 hour')
       AND ${LIVE_PFI}
     ORDER BY COALESCE(t.security_entered_at, t.created_at) ASC
  `);
  return rows.rows ?? rows;
};

/** "3 days" reads better than "72.4 hours" on a queue this old. */
const waited = (hours) => {
  const h = Math.floor(Number(hours) || 0);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.floor(h / 24)} days`;
};

/**
 * The desks, their queues, and who hears about them.
 *
 * Thresholds differ because the work does. A ticket should be generated the
 * same working day, so six hours is already late. A truck sitting on the yard
 * for six hours is normal — it is loading — but one still there after a day
 * has been forgotten.
 */
const DESKS = [
  {
    key: "tickets",
    type: "staff.tickets_pending",
    roles: ["ticketing", "dispatch"],
    hours: Number(process.env.NUDGE_TICKET_HOURS || 6),
    fetch: unticketedOrders,
    describe: (r) => `${r.orderNumber} · ${r.customerName || "—"} · ${Number(r.quantity).toLocaleString()} litres · waiting ${waited(r.hoursWaiting)}`,
  },
  {
    key: "entry",
    type: "staff.trucks_awaiting_entry",
    roles: ["security_entry"],
    hours: Number(process.env.NUDGE_ENTRY_HOURS || 12),
    fetch: trucksAwaitingEntry,
    describe: (r) => `${r.truckNumber || "—"} on ${r.orderNumber} · waiting ${waited(r.hoursWaiting)}`,
  },
  {
    key: "exit",
    type: "staff.trucks_on_yard",
    roles: ["security_exit"],
    hours: Number(process.env.NUDGE_YARD_HOURS || 24),
    fetch: trucksOnYard,
    describe: (r) => `${r.truckNumber || "—"} on ${r.orderNumber} · on the yard ${waited(r.hoursWaiting)}`,
  },
];

/**
 * Run every desk's sweep and notify the ones with a backlog.
 *
 * A desk with nothing waiting gets no message. Silence is the correct output
 * of a queue that is clear, and a daily "0 orders pending" is the fastest way
 * to train somebody to delete these unread.
 */
const runDeskNudges = async ({ dryRun = false } = {}) => {
  const results = [];

  for (const desk of DESKS) {
    let rows = [];
    try {
      rows = await desk.fetch(desk.hours);
    } catch (err) {
      console.error(`[desk-nudge] ${desk.key} query failed:`, err.message);
      results.push({ desk: desk.key, failed: true, error: err.message });
      continue;
    }

    if (rows.length === 0) {
      results.push({ desk: desk.key, count: 0, notified: false });
      continue;
    }

    const payload = {
      count: rows.length,
      hours: desk.hours,
      oldestHours: Math.floor(Number(rows[0]?.hoursWaiting) || 0),
      // Enough to recognise the work without turning a notification into a
      // report. The page it links to has the rest.
      examples: rows.slice(0, 5).map(desk.describe),
      depots: [...new Set(rows.map((r) => r.depotName).filter(Boolean))].slice(0, 4),
    };

    if (!dryRun) {
      // notify() swallows its own failures by design; one desk's channel being
      // down must not stop the others being told.
      await notify(desk.type, { to: { roles: desk.roles }, data: payload });
    }

    results.push({ desk: desk.key, count: rows.length, notified: !dryRun, ...payload });
  }

  return results;
};

/**
 * Who a desk's work actually belongs to, with a number to reach them on.
 *
 * The in-app nudge lands in a bell somebody has to open. When a queue has been
 * sitting for a hundred and forty-eight days, that is plainly not enough, and
 * the next escalation is a person's phone. This resolves the list so an admin
 * can see exactly who would be texted before anybody is.
 *
 * Staff with no phone number on their record are returned too, marked, rather
 * than quietly dropped — "we texted the desk" meaning four of its six people
 * is worse than knowing two are unreachable.
 */
const deskContacts = async (deskKey) => {
  const desk = DESKS.find((d) => d.key === deskKey);
  if (!desk) return [];

  /**
   * arrayOverlaps, not a hand-written `&&` fragment.
   *
   * A raw sql`${staff.roles} && ${roles}::text[]` binds the JS array as one
   * scalar and fails with a cast error at run time — the same trap
   * notifications/recipients.js documents, and it caught this function too on
   * its first run. The helper encodes the array literal properly.
   *
   * Suspended and deactivated accounts are excluded: texting somebody whose
   * access was revoked is at best noise.
   */
  const rows = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      surname: staff.surname,
      phoneNumber: staff.phoneNumber,
      email: staff.email,
      roles: staff.roles,
    })
    .from(staff)
    .where(
      and(
        arrayOverlaps(staff.roles, desk.roles),
        eq(staff.isActive, true),
        eq(staff.suspended, false),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    name: [r.firstName, r.surname].filter(Boolean).join(" ").trim(),
    phone: r.phoneNumber || null,
    email: r.email || null,
    roles: r.roles || [],
    reachable: Boolean(r.phoneNumber),
  }));
};

/**
 * The text itself. Short on purpose: an SMS is a nudge to open the dashboard,
 * not a report, and every extra line is a page somebody pays for.
 */
const nudgeSms = (deskKey, payload) => {
  const oldest = payload.oldestHours >= 48
    ? `${Math.floor(payload.oldestHours / 24)} days`
    : `${payload.oldestHours}h`;
  if (deskKey === "tickets") {
    return `Soroman: ${payload.count} paid order(s) still have no loading ticket, oldest ${oldest}. Product cannot leave until they are generated. Please action today.`;
  }
  if (deskKey === "entry") {
    return `Soroman: ${payload.count} ticketed truck(s) not yet gated in, oldest ${oldest}. Please record entries as they arrive.`;
  }
  return `Soroman: ${payload.count} truck(s) recorded as still on the yard, oldest ${oldest}. Please gate out the ones that have left.`;
};

/**
 * Text a desk about its backlog. Admin-triggered, never automatic.
 *
 * The daily sweep nudges in-app on its own; sending SMS costs money and
 * interrupts somebody's evening, so it stays a decision a person takes while
 * looking at the queue rather than a rule that fires at 8am.
 */
const smsDesk = async (deskKey, { dryRun = false } = {}) => {
  const desk = DESKS.find((d) => d.key === deskKey);
  if (!desk) throw Object.assign(new Error("Unknown desk"), { status: 400 });

  const rows = await desk.fetch(desk.hours);
  const contacts = await deskContacts(deskKey);
  const reachable = contacts.filter((c) => c.reachable);

  if (rows.length === 0) {
    return { desk: deskKey, count: 0, sent: [], skipped: contacts, message: "Nothing outstanding — nobody texted" };
  }

  const payload = { count: rows.length, oldestHours: Math.floor(Number(rows[0]?.hoursWaiting) || 0) };
  const text = nudgeSms(deskKey, payload);

  if (dryRun) {
    return { desk: deskKey, count: rows.length, text, wouldText: reachable, unreachable: contacts.filter((c) => !c.reachable) };
  }

  const sent = [];
  const failed = [];
  for (const c of reachable) {
    try {
      const res = await sendSMSWithFallback(c.phone, text);
      (res?.success ? sent : failed).push({ ...c, error: res?.success ? undefined : res?.message });
    } catch (err) {
      failed.push({ ...c, error: err.message });
    }
  }

  return {
    desk: deskKey,
    count: rows.length,
    text,
    sent,
    failed,
    unreachable: contacts.filter((c) => !c.reachable),
  };
};

module.exports = {
  runDeskNudges,
  deskContacts,
  smsDesk,
  unticketedOrders,
  trucksAwaitingEntry,
  trucksOnYard,
  DESKS,
};
