const { client, db } = require("../config/db");
const audit = require("./audit.service");
const { notifyAndWait } = require("../notifications");
const { STAGE_RECIPIENTS, cfoDeskIds } = require("./expenseNotifications.service");
const { DESKS: ASSIGNMENT_DESKS } = require("./deskAssignments.service");
const { outstandingReports, shortPfi, dayLabel, REPORT_NAMES } = require("./reportReminders.service");
const { localDateStr, addDaysStr } = require("../lib/zonedDay");
const { CATALOG } = require("../notifications/catalog");

/**
 * Everybody's outstanding work, texted to them every two hours until it is done.
 *
 * The dashboard already knows what is waiting — the sidebar badges, the desk
 * assignments panel, the report reminders page — but only somebody who opens
 * it sees any of that. The desk steps text the next desk once, when an order
 * reaches it, and a text read once and forgotten is how a ticket waits a day.
 * This is the same knowledge pushed out on a clock: each round, every member of
 * staff with something waiting on them gets ONE message listing all of it.
 *
 * ── One message per person, not one per queue ──────────────────────────────
 *
 * An admin can owe five different things at once. Five texts every two hours
 * is thirty a day and a phone set to silent; one text naming all five is a
 * to-do list. A person with nothing waiting gets nothing — silence is what a
 * clear desk sounds like.
 *
 * ── Who owes what ──────────────────────────────────────────────────────────
 *
 * Three rules, one per kind of work:
 *
 *   desk      Work on an order or a load belongs to the desk's officers on its
 *             PFI, the rule the desk-step texts use (notifications/deskOfficers):
 *             role holders on the PFI; else the role's company-wide holders
 *             (no PFIs, and no depots or this one); else the admins, because
 *             work nobody holds is exactly the work that gets stuck.
 *   role      Approvals that belong to a role, not a batch: every active holder
 *             of the role; else the admins.
 *   personal  Work that is one person's own: an expense sent back to them, a
 *             daily report they have not filed.
 *
 * Super admins are never reminded by role — they can do everything, so
 * deriving from what they CAN do would put the whole company on their phone.
 * They are the last fallback when a desk has no admin at all.
 *
 * ── Only what is late ──────────────────────────────────────────────────────
 *
 * An item joins a reminder once it has waited WORK_REMINDER_AFTER_HOURS (2).
 * Trucks on the yard wait WORK_REMINDER_YARD_HOURS (6), because loading takes
 * hours and a truck on the yard at hour three is working, not forgotten.
 * Today's daily report is chased from WORK_REMINDER_REPORT_HOUR (18:00), since
 * most are filed in the evening; yesterday's is chased all day if still missing.
 *
 * ── Sent once per round ────────────────────────────────────────────────────
 *
 * Each message carries the round (the Lagos date and hour) as its dedupe key,
 * so a retried job, a second server, or "Send now" pressed after the scheduled
 * round cannot text the same person twice in the same hour. Every round is an
 * audit row (work_reminder.round) holding who was told what, which is what the
 * Reminders tab on the Messaging page reads back.
 *
 * Every person can be switched off on Manage Users ("Reminders of waiting
 * work", notifications/staffChoices.js). Their own quiet hours apply too.
 */

const NOTICE = "staff.work_reminder";
const ROUND_ACTION = "work_reminder.round";
const ROUND_ENTITY = "work_reminder_round";
const TZ = () => process.env.REPORT_TIMEZONE || "Africa/Lagos";

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The settings, read at call time so a test or an env change takes effect. */
const settings = () => {
  const hours = String(process.env.WORK_REMINDER_HOURS || "8,10,12,14,16,18,20")
    .split(",")
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  return {
    hours: [...new Set(hours)],
    afterHours: num(process.env.WORK_REMINDER_AFTER_HOURS, 2),
    yardHours: num(process.env.WORK_REMINDER_YARD_HOURS, 6),
    reportHour: num(process.env.WORK_REMINDER_REPORT_HOUR, 18),
    /** The switch, separate from the scheduler's own, so reminders can stop alone. */
    enabled: process.env.WORK_REMINDERS_ENABLED !== "false",
    scheduled: process.env.SCHEDULED_JOBS_ENABLED === "true",
  };
};

/** The cron the scheduler registers: on the hour, at each reminder hour. */
const cronExpression = () => {
  const { hours } = settings();
  return `0 ${hours.length ? hours.join(",") : "8"} * * *`;
};

/** The hour of day in Lagos, 0–23. */
const lagosHour = (at = new Date()) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), hour: "2-digit", hourCycle: "h23" }).format(at));

/** "2026-10-05 10:00" — the round a moment belongs to, and its dedupe key. */
const roundKey = (at = new Date()) => `${localDateStr(at, TZ())} ${String(lagosHour(at)).padStart(2, "0")}:00`;

/** When the next scheduled round is, as "2026-10-05 12:00" Lagos, or null with no hours set. */
const nextRound = (at = new Date()) => {
  const { hours } = settings();
  if (!hours.length) return null;
  const today = localDateStr(at, TZ());
  const hour = lagosHour(at);
  const later = hours.find((h) => h > hour);
  return later != null
    ? `${today} ${String(later).padStart(2, "0")}:00`
    : `${addDaysStr(today, 1)} ${String(hours[0]).padStart(2, "0")}:00`;
};

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);
const hoursOf = (v) => Math.max(0, Math.floor(Number(v) || 0));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── Who is on the staff ────────────────────────────────────────────────────

/**
 * Every active member of staff with their roles and assignments, read once per
 * round. Owners are then worked out in memory: eighteen kinds of work over a
 * few dozen people is cheaper to match here than to ask the database per item.
 */
const loadDirectory = async () => {
  const people = await client`
    SELECT id, first_name, surname, phone_number, roles
      FROM staff
     WHERE is_active = true AND suspended = false
  `;
  const ids = people.map((p) => p.id);
  const [pfiRows, depotRows] = ids.length
    ? await Promise.all([
        client`SELECT staff_id, pfi_id FROM pfi_staff WHERE staff_id IN ${client(ids)}`,
        client`SELECT staff_id, depot_id FROM depot_staff WHERE staff_id IN ${client(ids)}`,
      ])
    : [[], []];

  const byId = new Map();
  for (const p of people) {
    const name = [p.first_name, p.surname].filter(Boolean).join(" ").trim() || `Staff #${p.id}`;
    byId.set(Number(p.id), {
      id: Number(p.id),
      name,
      firstName: String(p.first_name || "").trim(),
      phone: p.phone_number || null,
      roles: new Set(p.roles || []),
      pfis: new Set(),
      depots: new Set(),
    });
  }
  for (const r of pfiRows) byId.get(Number(r.staff_id))?.pfis.add(Number(r.pfi_id));
  for (const r of depotRows) byId.get(Number(r.staff_id))?.depots.add(Number(r.depot_id));

  const all = [...byId.values()];
  const holders = (roles) => all.filter((p) => roles.some((r) => p.roles.has(r)));
  const admins = () => {
    const a = holders(["admin"]);
    return a.length ? a : holders(["super_admin"]);
  };

  return { byId, holders, admins };
};

/** The desk's officers for one item — see "Who owes what" above. */
const deskOwners = (dir, roles, item) => {
  const holders = dir.holders(roles);
  if (!holders.length) return dir.admins();
  const pfiId = item.pfiId != null ? Number(item.pfiId) : null;
  const depotId = item.depotId != null ? Number(item.depotId) : null;
  if (pfiId != null) {
    const onPfi = holders.filter((p) => p.pfis.has(pfiId));
    if (onPfi.length) return onPfi;
  }
  const companyWide = holders.filter(
    (p) => p.pfis.size === 0 && (p.depots.size === 0 || (depotId != null && p.depots.has(depotId))),
  );
  return companyWide.length ? companyWide : dir.admins();
};

/** A role's holders, else the admins. */
const roleOwners = (dir, roles) => {
  const holders = dir.holders(roles);
  return holders.length ? holders : dir.admins();
};

/** The CFO desk, by name — the same people expense.verified texts. */
const cfoOwners = (dir) => {
  const named = cfoDeskIds().map((id) => dir.byId.get(id)).filter(Boolean);
  return named.length ? named : roleOwners(dir, STAGE_RECIPIENTS.verified.roles);
};

// ─── What is waiting ────────────────────────────────────────────────────────

/** Rows of a drizzle query from deskAssignments, so tickets and gates count as its panel does. */
const assignmentDesk = (key) => async () => {
  const desk = ASSIGNMENT_DESKS.find((d) => d.key === key);
  return rowsOf(await db.execute(desk.fetch())).map((r) => ({
    pfiId: r.pfiId, depotId: r.depotId, hours: r.hoursWaiting,
  }));
};

const expensesAt = async (status) =>
  client`
    SELECT e.id, e.pfi_id AS "pfiId", COALESCE(e.added_by, e.recorded_by) AS "submitter",
           EXTRACT(EPOCH FROM (now() - COALESCE(
             CASE e.status
               WHEN 'verified' THEN e.verified_at
               WHEN 'audit_approved' THEN e.audit_approved_at
               WHEN 'admin_approved' THEN e.admin_approved_at
               WHEN 'changes_requested' THEN e.reviewed_at
             END,
             CASE WHEN e.status = 'pending' THEN e.created_at END,
             e.updated_at, e.created_at
           ))) / 3600 AS hours
      FROM pfi_expenses e
     WHERE e.deleted_at IS NULL AND e.status::text = ${status}
  `;

/**
 * The kinds of work, in the order a message lists them.
 *
 * `owners` is how an item finds its people: "desk" with `roles`, "role" with
 * `roles`, "cfo", or "personal" where the fetch names the staff itself.
 * `noun` is what one line of the message says about `n` of them. `path` is the
 * page that clears it, for the bell's link and the Reminders tab.
 */
const KINDS = [
  {
    key: "payments",
    label: "Payments to confirm",
    who: "Finance on the order's PFI",
    path: "/payable-orders",
    owners: "desk",
    roles: ["finance"],
    noun: (n) => `${plural(n, "order")} to confirm payment for`,
    fetch: () => client`
      SELECT o.pfi_id AS "pfiId", o.depot_id AS "depotId",
             EXTRACT(EPOCH FROM (now() - o.created_at)) / 3600 AS hours
        FROM orders o
       WHERE o.status = 'Pending'
         AND o.payment_status IN ('Unpaid', 'Part Paid')
         AND NOT EXISTS (SELECT 1 FROM pfis p WHERE p.id = o.pfi_id AND p.status = 'finished')
    `,
  },
  {
    key: "pricing",
    label: "Credit orders to price",
    who: "Finance on the order's PFI",
    path: "/receivables",
    owners: "desk",
    roles: ["finance"],
    noun: (n) => `${plural(n, "credit order")} to price`,
    fetch: () => client`
      SELECT o.pfi_id AS "pfiId", o.depot_id AS "depotId",
             EXTRACT(EPOCH FROM (now() - o.created_at)) / 3600 AS hours
        FROM orders o
       WHERE o.pricing_status = 'pending'
         AND o.status NOT IN ('Cancelled', 'Expired')
    `,
  },
  {
    key: "refunds",
    label: "Refunds to pay",
    who: "Finance on the order's PFI",
    path: "/overpayment-refunds",
    owners: "desk",
    roles: ["finance"],
    noun: (n) => `${plural(n, "refund")} to pay`,
    fetch: () => client`
      SELECT o.pfi_id AS "pfiId", o.depot_id AS "depotId",
             EXTRACT(EPOCH FROM (now() - COALESCE(r.requested_at, r.created_at))) / 3600 AS hours
        FROM order_refunds r
        JOIN orders o ON o.id = r.order_id
       WHERE r.status = 'requested'
    `,
  },
  {
    key: "tickets",
    label: "Orders to ticket",
    who: "Ticketing and dispatch on the order's PFI",
    path: "/ticket",
    owners: "desk",
    roles: ["ticketing", "dispatch"],
    noun: (n) => `${plural(n, "order")} to ticket`,
    fetch: assignmentDesk("tickets"),
  },
  {
    key: "gateIn",
    label: "Trucks to gate in",
    who: "Entrance gate on the order's PFI",
    path: "/security/entry",
    owners: "desk",
    roles: ["security_entry"],
    noun: (n) => `${plural(n, "truck")} to gate in`,
    fetch: assignmentDesk("entry"),
  },
  {
    key: "gateOut",
    label: "Trucks to gate out",
    who: "Exit gate on the order's PFI",
    path: "/security/exit",
    owners: "desk",
    roles: ["security_exit"],
    yard: true,
    noun: (n) => `${plural(n, "truck")} to gate out`,
    fetch: assignmentDesk("exit"),
  },
  {
    key: "trucksToSell",
    label: "Loaded trucks to sell",
    who: "Truck sales on the batch's PFI",
    path: "/delivery-operations",
    owners: "desk",
    roles: ["truck_sales"],
    noun: (n) => `${plural(n, "loaded truck")} to sell`,
    fetch: () => client`
      SELECT di.pfi_id AS "pfiId", p.location_id AS "depotId",
             EXTRACT(EPOCH FROM (now() - di.created_at)) / 3600 AS hours
        FROM delivery_inventory di
        JOIN pfis p ON p.id = di.pfi_id
       WHERE di.loading_status = 'loaded'
         AND di.customer_id IS NULL
         AND p.status <> 'finished'
    `,
  },
  {
    key: "expenseVerify",
    label: "Expenses to verify",
    who: "Expenditure officers and admins",
    path: "/expenses",
    owners: "role",
    roles: STAGE_RECIPIENTS.pending.roles,
    noun: (n) => `${plural(n, "expense")} to verify`,
    fetch: () => expensesAt("pending"),
  },
  {
    key: "expenseCfo",
    label: "Expenses for CFO approval",
    who: "The CFO",
    path: "/expenses",
    owners: "cfo",
    noun: (n) => `${plural(n, "expense")} for your CFO approval`,
    fetch: () => expensesAt("verified"),
  },
  {
    key: "expenseApprove",
    label: "Expenses for final approval",
    who: "Admins",
    path: "/expenses",
    owners: "role",
    roles: STAGE_RECIPIENTS.audit_approved.roles,
    noun: (n) => `${plural(n, "expense")} for final approval`,
    fetch: () => expensesAt("audit_approved"),
  },
  {
    key: "expensePay",
    label: "Approved expenses to pay",
    who: "Expenditure officers",
    path: "/expenses",
    owners: "role",
    roles: STAGE_RECIPIENTS.admin_approved.roles,
    noun: (n) => `${plural(n, "approved expense")} to pay`,
    fetch: () => expensesAt("admin_approved"),
  },
  {
    key: "expenseChanges",
    label: "Expenses sent back for changes",
    who: "Whoever raised the expense",
    path: "/expense-requests",
    owners: "personal",
    noun: (n) => `${plural(n, "expense")} sent back to you for changes`,
    fetch: async () =>
      (await expensesAt("changes_requested"))
        .filter((r) => r.submitter != null)
        .map((r) => ({ ...r, staffIds: [Number(r.submitter)] })),
  },
  {
    key: "reports",
    label: "Daily reports to file",
    who: "Sales managers, product managers, the gate, commissions and IT compliance on each PFI",
    path: "/my-report",
    owners: "personal",
    // Built separately: each line names the report and the PFIs. See reportLines.
  },
  {
    key: "allocations",
    label: "Truck allocations to approve",
    who: "Admins",
    path: "/pfi",
    owners: "role",
    roles: ["admin"],
    noun: (n) => `${plural(n, "truck allocation")} to approve`,
    fetch: () => client`
      SELECT EXTRACT(EPOCH FROM (now() - COALESCE(raised_at, created_at))) / 3600 AS hours
        FROM pfi_truck_allocations
       WHERE status = 'pending'
    `,
  },
  {
    key: "priceChanges",
    label: "Price changes to approve",
    who: "Admins",
    path: "/product-pricing",
    owners: "role",
    roles: ["admin"],
    noun: (n) => `${plural(n, "price change")} to approve`,
    fetch: () => client`
      SELECT EXTRACT(EPOCH FROM (now() - COALESCE(requested_at, created_at))) / 3600 AS hours
        FROM depot_price_changes
       WHERE status = 'pending'
    `,
  },
  {
    key: "pfisToStart",
    label: "PFIs to start",
    who: "Admins",
    path: "/pfi",
    owners: "role",
    roles: ["admin"],
    noun: (n) => `${plural(n, "PFI")} to start`,
    fetch: () => client`
      SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 3600 AS hours
        FROM pfis
       WHERE status = 'not_started'
    `,
  },
  {
    key: "requests",
    label: "Dangote and LPG requests to review",
    who: "Sales managers",
    path: "/dangote-order-request",
    owners: "role",
    roles: ["sales_manager"],
    noun: (n) => `${plural(n, "Dangote or LPG request")} to review`,
    fetch: () => client`
      SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 3600 AS hours
        FROM dangote_order_requests WHERE status = 'Pending Review'
      UNION ALL
      SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 3600 AS hours
        FROM lpg_order_requests WHERE status = 'Pending Review'
    `,
  },
  {
    key: "licences",
    label: "Customer licences to review",
    who: "IT compliance",
    path: "/licence-verification",
    owners: "role",
    roles: ["it_compliance"],
    noun: (n) => `${plural(n, "customer licence")} to review`,
    fetch: () => client`
      SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 3600 AS hours
        FROM customer_licenses WHERE status = 'pending'
    `,
  },
];

/**
 * The daily reports still missing, one entry per officer per report and day.
 *
 * Read through reportReminders.outstandingReports, so the grid is the Reports
 * Hub's own: a desk is filed when anybody filed it, and its officers are the
 * filers scoped to its PFI. A desk nobody is scoped to has no officer and is
 * not chased here — that is a staffing gap, and the hub already shows it.
 */
const reportItems = async (at) => {
  const { reportHour } = settings();
  const today = localDateStr(at, TZ());
  const days = [addDaysStr(today, -1)];
  if (lagosHour(at) >= reportHour) days.push(today);

  const items = [];
  for (const date of days) {
    const state = await outstandingReports(date);
    for (const role of state.roles) {
      for (const desk of role.desks) {
        if (desk.status !== "missing") continue;
        for (const officer of desk.officers) {
          items.push({ staffId: Number(officer.staffId), role: role.type, date, pfiNumber: desk.pfiNumber });
        }
      }
    }
  }
  return items;
};

/** "your gate report for Sun 4 Oct, PFI 47 and PFI 39" — one per report and day. */
const reportLines = (items) => {
  const groups = new Map();
  for (const i of items) {
    const k = `${i.date}|${i.role}`;
    if (!groups.has(k)) groups.set(k, { date: i.date, role: i.role, pfis: [] });
    const label = shortPfi(i.pfiNumber);
    if (!groups.get(k).pfis.includes(label)) groups.get(k).pfis.push(label);
  }
  return [...groups.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((g) => {
      const pfis = g.pfis.length > 1 ? `${g.pfis.slice(0, -1).join(", ")} and ${g.pfis.at(-1)}` : g.pfis[0];
      return `your ${REPORT_NAMES[g.role] || "daily report"} for ${dayLabel(g.date)}, ${pfis}`;
    });
};

/** "6h" or "3 days" — how long the oldest has waited. */
const age = (hours) => (hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours}h`);

// ─── The round ──────────────────────────────────────────────────────────────

/**
 * Who would be reminded of what, right now. Reads only.
 *
 * @param {Date} [at]
 * @param {{staffIds?: number[]}} [opts] only these people (the tests use it)
 * @returns {Promise<{round, people: Array, kinds: Array}>}
 */
const buildRound = async (at = new Date(), { staffIds = null } = {}) => {
  const cfg = settings();
  const dir = await loadDirectory();
  const owed = new Map(); // staffId → Map(kindKey → { count, oldest })
  const kindTotals = {};
  const failures = [];

  const add = (person, kindKey, hours) => {
    if (!owed.has(person.id)) owed.set(person.id, new Map());
    const mine = owed.get(person.id);
    const e = mine.get(kindKey) || { count: 0, oldest: 0 };
    e.count += 1;
    e.oldest = Math.max(e.oldest, hoursOf(hours));
    mine.set(kindKey, e);
  };

  for (const kind of KINDS) {
    if (kind.key === "reports") continue;
    let rows = [];
    try {
      rows = rowsOf(await kind.fetch());
    } catch (err) {
      // One broken query must not cost everybody else their reminder.
      console.error(`[work-reminders] ${kind.key} failed:`, err.message);
      failures.push({ kind: kind.key, error: err.message });
      continue;
    }
    const after = kind.yard ? cfg.yardHours : cfg.afterHours;
    const late = rows.filter((r) => Number(r.hours) >= after);
    kindTotals[kind.key] = late.length;

    for (const item of late) {
      let people;
      if (kind.owners === "desk") people = deskOwners(dir, kind.roles, item);
      else if (kind.owners === "role") people = roleOwners(dir, kind.roles);
      else if (kind.owners === "cfo") people = cfoOwners(dir);
      else people = (item.staffIds || []).map((id) => dir.byId.get(id)).filter(Boolean);
      for (const p of people) add(p, kind.key, item.hours);
    }
  }

  let reports = [];
  try {
    reports = await reportItems(at);
  } catch (err) {
    console.error("[work-reminders] reports failed:", err.message);
    failures.push({ kind: "reports", error: err.message });
  }
  kindTotals.reports = reports.length;
  const reportsBy = new Map();
  for (const r of reports) {
    if (!dir.byId.has(r.staffId)) continue;
    if (!reportsBy.has(r.staffId)) reportsBy.set(r.staffId, []);
    reportsBy.get(r.staffId).push(r);
  }

  const off = await switchedOff();
  const only = staffIds ? new Set(staffIds.map(Number)) : null;
  const ids = new Set([...owed.keys(), ...reportsBy.keys()].filter((id) => !only || only.has(id)));
  const people = [...ids]
    .map((id) => {
      const person = dir.byId.get(id);
      const mine = owed.get(id) || new Map();
      const lines = [];
      for (const kind of KINDS) {
        if (kind.key === "reports") {
          const own = reportsBy.get(id);
          if (own?.length) {
            for (const text of reportLines(own)) lines.push({ kind: "reports", path: kind.path, count: 1, oldestHours: null, text });
          }
          continue;
        }
        const e = mine.get(kind.key);
        if (!e) continue;
        lines.push({
          kind: kind.key,
          path: kind.path,
          count: e.count,
          oldestHours: e.oldest,
          text: `${kind.noun(e.count)}, oldest ${age(e.oldest)}`,
        });
      }
      return {
        staffId: id,
        name: person.name,
        firstName: person.firstName,
        phone: person.phone,
        roles: [...person.roles],
        lines,
        switchedOff: off.has(id),
      };
    })
    .filter((p) => p.lines.length)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { round: roundKey(at), people, kinds: kindTotals, failures };
};

/** Staff switched off reminders on Manage Users. */
const switchedOff = async () => {
  try {
    const rows = await client`
      SELECT staff_id FROM staff_notification_overrides
       WHERE choice = 'work_reminders' AND enabled = false
    `;
    return new Set(rows.map((r) => Number(r.staff_id)));
  } catch {
    return new Set();
  }
};

/** What one person's message says, for the preview — the catalog renders the real one. */
const previewText = (person) => CATALOG[NOTICE].sms(dataFor(person, ""));

const dataFor = (person, round) => ({
  round,
  firstName: person.firstName,
  lines: person.lines.map((l) => l.text),
  total: person.lines.reduce((s, l) => s + l.count, 0),
  path: person.lines[0]?.path || "/",
});

/** Whether this hour's full round has gone out, by the schedule or "Send now". */
const roundAlreadySent = async (round) => {
  const [done] = await client`
    SELECT 1 FROM audit_events
     WHERE action = ${ROUND_ACTION} AND entity_type = ${ROUND_ENTITY} AND entity_id = ${round}
       AND COALESCE((metadata->>'partial')::boolean, false) = false
     LIMIT 1
  `;
  return Boolean(done);
};

/**
 * Send a round: build it, then one notice per person.
 *
 * A scheduled round that already ran this hour is skipped whole. "Send now"
 * builds a fresh round; people already told this hour come back as
 * `duplicate` and are not texted again.
 *
 * @param {{trigger?: "schedule"|"manual", actor?: object, at?: Date, staffIds?: number[]}} opts
 */
const runRound = async ({ trigger = "schedule", actor = null, at = new Date(), staffIds = null } = {}) => {
  const cfg = settings();
  if (!cfg.enabled) return { skipped: true, reason: "Reminders are switched off (WORK_REMINDERS_ENABLED=false)" };

  const round = roundKey(at);
  if (trigger === "schedule" && (await roundAlreadySent(round))) {
    return { skipped: true, reason: `The ${round} round has already gone out`, round };
  }

  const built = await buildRound(at, { staffIds });
  const results = [];
  const queue = [...built.people];
  const worker = async () => {
    while (queue.length) {
      const person = queue.shift();
      const text = previewText(person);
      if (person.switchedOff) {
        results.push({ ...summaryOf(person, text), status: "switched_off" });
        continue;
      }
      let status = "sent";
      let error = null;
      try {
        const res = await notifyAndWait(NOTICE, { to: [{ staffId: person.staffId }], data: dataFor(person, round) });
        const r = res?.results?.[0];
        if (res?.error) [status, error] = ["failed", res.error];
        else if (res?.skipped) [status, error] = ["failed", res.reason || "Not sent"];
        else if (!r) status = "switched_off";
        else if (r.duplicate) status = "duplicate";
        else if (r.error) [status, error] = ["failed", r.error];
        else if (r.channels?.sms === "sent") status = "texted";
        else {
          // Told in the app; why not by text is on the suppression.
          status = "app_only";
          error = r.suppressed?.find((s) => s.channel === "sms")?.reason || r.channelErrors?.sms || null;
        }
      } catch (err) {
        [status, error] = ["failed", err.message];
      }
      results.push({ ...summaryOf(person, text), status, error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  results.sort((a, b) => a.name.localeCompare(b.name));

  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = {
    trigger,
    round,
    // A round for named people only does not stand in for the hour's round.
    partial: Boolean(staffIds),
    people: results.length,
    texted: count("texted"),
    appOnly: count("app_only"),
    duplicates: count("duplicate"),
    switchedOff: count("switched_off"),
    failed: count("failed"),
    kinds: built.kinds,
    failures: built.failures,
  };

  try {
    await audit.record({
      action: ROUND_ACTION,
      actor: actor || {},
      entityType: ROUND_ENTITY,
      entityId: round,
      metadata: { ...summary, results },
    });
  } catch (err) {
    console.error("[work-reminders] could not record the round:", err.message);
  }

  return { ...summary, results };
};

const summaryOf = (person, text) => ({
  staffId: person.staffId,
  name: person.name,
  phone: person.phone,
  lines: person.lines.map((l) => l.text),
  text,
});

/** The last rounds, newest first, for the Reminders tab. */
const recentRounds = async (limit = 20) => {
  const rows = await client`
    SELECT id, actor_name, metadata, created_at
      FROM audit_events
     WHERE action = ${ROUND_ACTION} AND entity_type = ${ROUND_ENTITY}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    by: r.actor_name || "",
    ...(r.metadata || {}),
  }));
};

/** Everything the Reminders tab shows. */
const overview = async (at = new Date()) => {
  const cfg = settings();
  const [built, rounds] = await Promise.all([buildRound(at), recentRounds()]);
  return {
    settings: {
      ...cfg,
      cron: cronExpression(),
      running: cfg.enabled && cfg.scheduled,
      nextRound: cfg.enabled && cfg.scheduled ? nextRound(at) : null,
    },
    kinds: KINDS.map((k) => ({
      key: k.key,
      label: k.label,
      who: k.who,
      path: k.path,
      afterHours: k.key === "reports" ? null : k.yard ? cfg.yardHours : cfg.afterHours,
      waiting: built.kinds[k.key] ?? 0,
    })),
    round: built.round,
    failures: built.failures,
    people: built.people.map((p) => ({
      ...summaryOf(p, previewText(p)),
      roles: p.roles,
      switchedOff: p.switchedOff,
    })),
    rounds,
  };
};

module.exports = {
  runRound,
  roundAlreadySent,
  buildRound,
  overview,
  recentRounds,
  cronExpression,
  roundKey,
  nextRound,
  settings,
  deskOwners,
  KINDS,
  NOTICE,
  ROUND_ACTION,
};
