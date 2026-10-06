const { client, db } = require("../config/db");
const audit = require("./audit.service");
const { notifyAndWait } = require("../notifications");
const { DESKS: ASSIGNMENT_DESKS } = require("./deskAssignments.service");
const { cfoDeskIds } = require("./expenseNotifications.service");
const { officerIdsFor, stationOfficerIds, generalOfficerIds } = require("../lib/expenseOfficers");
const { shortPfi, dayLabel, FILER_ROLES, REPORT_NAMES } = require("./reportReminders.service");
const { localDateStr, addDaysStr } = require("../lib/zonedDay");
const { CATALOG } = require("../notifications/catalog");

/**
 * Reminders of work waiting on someone — the owner's rules of 6 Oct 2026.
 *
 * These reminders and nothing else:
 *
 *   Expenses        each stage to whoever's turn it is: the expenditure
 *                   officer to verify and to pay, the CFO to approve, the
 *                   admins for final approval, the raiser when sent back
 *   Finance         orders on their PFIs still waiting for payment confirmation
 *   Ticketing       orders on their PFIs paid for but not ticketed yet
 *   Exit gate       trucks on their PFIs ticketed but not gated out yet
 *     — every two hours in the working day (WORK_REMINDER_HOURS, 8–20),
 *       once the work has waited WORK_REMINDER_AFTER_HOURS (2)
 *
 *   Daily report    "please enter your report", at 20:00 and 22:00
 *                   (WORK_REMINDER_REPORT_HOURS), to each officer whose
 *                   report for today is not in
 *   No orders       "no orders today — what is the issue?", at 18:00
 *                   (WORK_REMINDER_NO_ORDERS_HOUR), to every officer on an
 *                   active depot-sales PFI that has raised none today
 *
 * ── Assigned, or nothing ───────────────────────────────────────────────────
 *
 * A reminder reaches a person only when they hold the role AND are named on
 * the PFI as an officer (pfi_staff). Work on a PFI with nobody on that desk is
 * sent to nobody — not to the role's other holders, not to the admins. The
 * expense chain is the one thing not tied to a PFI: each stage goes to the
 * people whose turn it is (see DESK_KINDS). Super admins get only what their
 * other roles and assignments bring them.
 *
 * ── One text per person per kind ───────────────────────────────────────────
 *
 * The work reminders are one text listing everything on the person's desks,
 * each named by PFI. The report reminder and the no-orders alert are their
 * own texts, because they say one thing each. Each carries the round (the
 * Lagos date and hour) in its dedupe key, so a retried job or "Send now" in
 * the same hour sends nothing twice. Every round is an audit row
 * (work_reminder.round), which the Reminders tab on the Messaging page reads.
 *
 * ON unless WORK_REMINDERS_ENABLED=false (switched on by the owner 6 Oct 2026,
 * after a day paused). Each person can be switched off
 * on Manage Users ("Reminders of waiting work"); their quiet hours apply too.
 */

const NOTICES = {
  desk: "staff.work_reminder",
  report: "staff.report_reminder",
  noOrders: "staff.no_orders_alert",
};
const ROUND_ACTION = "work_reminder.round";
const ROUND_ENTITY = "work_reminder_round";
const TZ = () => process.env.REPORT_TIMEZONE || "Africa/Lagos";

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const hoursFrom = (value, fallback) => {
  const hours = String(value || fallback)
    .split(",")
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  return [...new Set(hours)];
};

/** The settings, read at call time so a test or an env change takes effect. */
const settings = () => {
  const deskHours = hoursFrom(process.env.WORK_REMINDER_HOURS, "8,10,12,14,16,18,20");
  const reportHours = hoursFrom(process.env.WORK_REMINDER_REPORT_HOURS, "20,22");
  const noOrdersHour = num(process.env.WORK_REMINDER_NO_ORDERS_HOUR, 18);
  return {
    deskHours,
    reportHours,
    noOrdersHour,
    /** Every hour a round runs at — the scheduler's cron. */
    hours: [...new Set([...deskHours, ...reportHours, noOrdersHour])].sort((a, b) => a - b),
    afterHours: num(process.env.WORK_REMINDER_AFTER_HOURS, 2),
    /** On unless switched off — the owner switched them on on 6 Oct 2026. */
    enabled: process.env.WORK_REMINDERS_ENABLED !== "false",
    scheduled: process.env.SCHEDULED_JOBS_ENABLED === "true",
  };
};

/** The cron the scheduler registers: on the hour, at each round's hour. */
const cronExpression = () => `0 ${settings().hours.join(",") || "8"} * * *`;

/** The hour of day in Lagos, 0–23. */
const lagosHour = (at = new Date()) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), hour: "2-digit", hourCycle: "h23" }).format(at));

/** "2026-10-05 10:00" — the round a moment belongs to, and its dedupe key. */
const roundKey = (at = new Date()) => `${localDateStr(at, TZ())} ${String(lagosHour(at)).padStart(2, "0")}:00`;

/** When the next scheduled round is, as "2026-10-05 12:00" Lagos. */
const nextRound = (at = new Date()) => {
  const { hours } = settings();
  if (!hours.length) return null;
  const today = localDateStr(at, TZ());
  const later = hours.find((h) => h > lagosHour(at));
  return later != null
    ? `${today} ${String(later).padStart(2, "0")}:00`
    : `${addDaysStr(today, 1)} ${String(hours[0]).padStart(2, "0")}:00`;
};

/**
 * Which reminders a round sends.
 *
 * A scheduled round sends what is due at its hour. "Send now" sends the work
 * reminders, and the report and no-orders ones only from their hour on, so a
 * press in the morning cannot text "no orders today" before the day is out.
 * The preview shows all three.
 */
const dueKinds = (at, trigger) => {
  const cfg = settings();
  const hour = lagosHour(at);
  if (trigger === "preview") return { desk: true, report: true, noOrders: true };
  if (trigger === "manual") {
    return {
      desk: true,
      report: cfg.reportHours.length > 0 && hour >= cfg.reportHours[0],
      noOrders: hour >= cfg.noOrdersHour,
    };
  }
  return {
    desk: cfg.deskHours.includes(hour),
    report: cfg.reportHours.includes(hour),
    noOrders: hour === cfg.noOrdersHour,
  };
};

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);
const pfiKey = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");

// ─── Who is on which desk ───────────────────────────────────────────────────

/**
 * Every active member of staff with their roles and the PFIs they are named
 * on. Depot assignments are not read: a reminder follows the PFI's officers.
 */
const loadDirectory = async () => {
  const people = await client`
    SELECT id, first_name, surname, phone_number, roles
      FROM staff
     WHERE is_active = true AND suspended = false
  `;
  const ids = people.map((p) => p.id);
  const pfiRows = ids.length
    ? await client`SELECT staff_id, pfi_id FROM pfi_staff WHERE staff_id IN ${client(ids)}`
    : [];

  const byId = new Map();
  for (const p of people) {
    byId.set(Number(p.id), {
      id: Number(p.id),
      name: [p.first_name, p.surname].filter(Boolean).join(" ").trim() || `Staff #${p.id}`,
      firstName: String(p.first_name || "").trim(),
      phone: p.phone_number || null,
      roles: new Set(p.roles || []),
      pfis: new Set(),
    });
  }
  for (const r of pfiRows) byId.get(Number(r.staff_id))?.pfis.add(Number(r.pfi_id));

  const all = [...byId.values()];
  return {
    byId,
    /** Holders of any of these roles. */
    holders: (roles) => all.filter((p) => roles.some((r) => p.roles.has(r))),
    /** Holders of any of these roles named on this PFI — nobody else. Any role when `roles` is null. */
    onPfi: (roles, pfiId) =>
      pfiId == null ? [] : all.filter((p) => p.pfis.has(Number(pfiId)) && (!roles || roles.some((r) => p.roles.has(r)))),
  };
};

/** The PFIs a reminder can name, with the label the desks use ("PFI 47"). */
const loadPfis = async () => {
  const rows = await client`
    SELECT id, pfi_number, pfi_type, status, location_name FROM pfis WHERE status <> 'finished'`;
  return new Map(rows.map((p) => [Number(p.id), {
    id: Number(p.id),
    number: p.pfi_number || "",
    label: shortPfi(p.pfi_number) || `PFI ${p.id}`,
    type: p.pfi_type || "coastal",
    status: p.status,
    location: p.location_name || "",
  }]));
};

// ─── What is waiting ────────────────────────────────────────────────────────

/** Orders still waiting for their payment to be confirmed. */
const pendingPayments = () => client`
  SELECT o.pfi_id AS "pfiId", EXTRACT(EPOCH FROM (now() - o.created_at)) / 3600 AS hours
    FROM orders o
    JOIN pfis p ON p.id = o.pfi_id
   WHERE o.status = 'Pending'
     AND o.payment_status IN ('Unpaid', 'Part Paid')
     AND p.status <> 'finished'
`;

/** Orders paid for and released, with no ticket yet — the ticketing desk's own query. */
const unticketedOrders = async () => {
  const desk = ASSIGNMENT_DESKS.find((d) => d.key === "tickets");
  return rowsOf(await db.execute(desk.fetch())).map((r) => ({ pfiId: r.pfiId, hours: r.hoursWaiting }));
};

/** Trucks with a ticket that have not been gated out. */
const trucksNotExited = () => client`
  SELECT o.pfi_id AS "pfiId", EXTRACT(EPOCH FROM (now() - t.created_at)) / 3600 AS hours
    FROM order_trucks t
    JOIN orders o ON o.id = t.order_id
    JOIN pfis p   ON p.id = o.pfi_id
   WHERE t.status IN ('pending', 'gated_in', 'loaded')
     AND o.status NOT IN ('Cancelled', 'Expired')
     AND p.status <> 'finished'
     AND p.pfi_type NOT IN ('gantry', 'delivery')
`;

/**
 * Expense requests at one stage of the approval chain, aged from when they
 * reached it, with whoever raised them (for the stage that is theirs).
 */
const expensesAt = (status) => client`
  SELECT COALESCE(added_by, recorded_by) AS "raisedBy",
         delivery_customer_id, lpg_station_id,
         EXTRACT(EPOCH FROM (now() - COALESCE(
           CASE status::text
             WHEN 'pending'           THEN created_at
             WHEN 'verified'          THEN verified_at
             WHEN 'audit_approved'    THEN audit_approved_at
             WHEN 'admin_approved'    THEN admin_approved_at
             WHEN 'changes_requested' THEN reviewed_at
           END,
           updated_at, created_at
         ))) / 3600 AS hours
    FROM pfi_expenses
   WHERE deleted_at IS NULL AND status::text = ${status}
`;

/** The expenditure officer named for this expense, if active. */
const officersOf = (dir, expense) => officerIdsFor(expense).map((id) => dir.byId.get(id)).filter(Boolean);

/** Who the named desks are, by name, for the Reminders tab. */
const namedDesks = (dir) => {
  const names = (ids) => ids.map((id) => dir.byId.get(id)?.name).filter(Boolean).join(" and ") || "nobody (not an active member of staff)";
  return {
    officers: `${names(stationOfficerIds())} for station and LPG plant expenses; ${names(generalOfficerIds())} for the rest`,
    cfo: `The CFO, ${names(cfoDeskIds())}`,
  };
};

/**
 * The work reminders — in the order a text lists them.
 *
 * `ownersOf` says who an item is waiting on. The expense chain is the
 * company's, not a PFI's: each stage reaches the people whose turn it is —
 * the expenditure officer named for the expense to verify and to pay
 * (lib/expenseOfficers.js: station and plant expenses to one, the rest to
 * another), the CFO by name
 * (EXPENSE_CFO_STAFF_IDS, as the stage's own notice is sent), the admins for
 * final approval, and whoever raised a request sent back to them. The order
 * desks reach the role's officers on the order's PFI. Nobody else, ever.
 */
const DESK_KINDS = [
  {
    key: "expenseVerify", label: "Expense requests to verify", who: (n) => n.officers,
    fetch: () => expensesAt("pending"), ownersOf: (dir, item) => officersOf(dir, item), path: "/expenses",
  },
  {
    key: "expenseCfo", label: "Expense requests for CFO approval", who: (n) => n.cfo,
    fetch: () => expensesAt("verified"),
    ownersOf: (dir) => cfoDeskIds().map((id) => dir.byId.get(id)).filter(Boolean),
    path: "/expenses",
  },
  {
    key: "expenseFinal", label: "Expense requests for final approval", who: "Admins",
    fetch: () => expensesAt("audit_approved"), ownersOf: (dir) => dir.holders(["admin"]), path: "/expenses",
  },
  {
    key: "expensePay", label: "Approved expense requests to pay", who: (n) => n.officers,
    fetch: () => expensesAt("admin_approved"), ownersOf: (dir, item) => officersOf(dir, item), path: "/expenses",
  },
  {
    key: "expenseChanges", label: "Expense requests sent back for changes", who: "Whoever raised the request",
    fetch: () => expensesAt("changes_requested"),
    ownersOf: (dir, item) => [dir.byId.get(Number(item.raisedBy))].filter(Boolean),
    path: "/expense-requests",
  },
  {
    key: "payments", label: "Payments to confirm", who: "Finance officers on the order's PFI", byPfi: true,
    fetch: pendingPayments, ownersOf: (dir, item) => dir.onPfi(["finance"], item.pfiId), path: "/payable-orders",
  },
  {
    key: "tickets", label: "Paid orders not ticketed", who: "Ticketing officers on the order's PFI", byPfi: true,
    fetch: unticketedOrders, ownersOf: (dir, item) => dir.onPfi(["ticketing"], item.pfiId), path: "/ticket",
  },
  {
    key: "exits", label: "Ticketed trucks not gated out", who: "Exit gate officers on the order's PFI", byPfi: true,
    fetch: trucksNotExited, ownersOf: (dir, item) => dir.onPfi(["security_exit"], item.pfiId), path: "/security/exit",
  },
];

/** Active PFIs that sell from the depot — every type but trucking, whose loads are sold off the truck. */
const depotSalesPfis = (pfis) => [...pfis.values()].filter((p) => p.status === "active" && p.type !== "trucking");

// ─── Building a round ───────────────────────────────────────────────────────

/**
 * The messages a round would send. Reads only.
 *
 * @param {Date} at
 * @param {{trigger?: "schedule"|"manual"|"preview", staffIds?: number[]}} [opts]
 * @returns {Promise<{round, messages, totals, failures}>}
 */
const buildRound = async (at = new Date(), { trigger = "preview", staffIds = null } = {}) => {
  const cfg = settings();
  const due = dueKinds(at, trigger);
  const [dir, pfis] = await Promise.all([loadDirectory(), loadPfis()]);
  const failures = [];
  const totals = {};
  const only = staffIds ? new Set(staffIds.map(Number)) : null;
  const wanted = (id) => !only || only.has(Number(id));
  const pfiLabel = (id) => pfis.get(Number(id))?.label || `PFI ${id}`;
  const today = localDateStr(at, TZ());
  const messages = [];

  // ── The work reminders: one text per person, every desk they are behind on.
  if (due.desk) {
    const owed = new Map(); // staffId → { expenseFinal: n, payments: Map(pfiId → n), … }
    const add = (person, kind, pfiId) => {
      if (!owed.has(person.id)) owed.set(person.id, {});
      const mine = owed.get(person.id);
      if (kind.byPfi) {
        mine[kind.key] ??= new Map();
        mine[kind.key].set(pfiId, (mine[kind.key].get(pfiId) || 0) + 1);
      } else {
        mine[kind.key] = (mine[kind.key] || 0) + 1;
      }
    };
    for (const kind of DESK_KINDS) {
      let rows = [];
      try {
        rows = rowsOf(await kind.fetch());
      } catch (err) {
        console.error(`[work-reminders] ${kind.key} failed:`, err.message);
        failures.push({ kind: kind.key, error: err.message });
        continue;
      }
      const late = rows.filter((r) => Number(r.hours) >= cfg.afterHours);
      totals[kind.key] = late.length;
      for (const item of late) {
        for (const p of kind.ownersOf(dir, item)) add(p, kind, item.pfiId);
      }
    }
    for (const [staffId, mine] of owed) {
      if (!wanted(staffId)) continue;
      const person = dir.byId.get(staffId);
      const byPfi = (m) => (m ? [...m.entries()].map(([id, count]) => ({ pfi: pfiLabel(id), count })) : []);
      const data = { firstName: person.firstName };
      for (const k of DESK_KINDS) data[k.key] = k.byPfi ? byPfi(mine[k.key]) : mine[k.key] || 0;
      data.path = DESK_KINDS.find((k) => (k.byPfi ? data[k.key].length : data[k.key] > 0))?.path || "/";
      messages.push({ kind: "desk", person, data });
    }
  }

  // ── The daily report: the officers of every report not in for today.
  if (due.report) {
    try {
      const sheets = await client`
        SELECT report_type::text AS role, pfi_number FROM daily_reports WHERE report_date = ${today}`;
      const filed = new Set(sheets.map((s) => `${s.role}|${pfiKey(s.pfi_number)}`));
      const missing = new Map(); // staffId → Map(reportType → [pfi labels])
      let count = 0;
      for (const pfi of depotSalesPfis(pfis)) {
        for (const [type, roles] of Object.entries(FILER_ROLES)) {
          if (filed.has(`${type}|${pfiKey(pfi.number)}`)) continue;
          const officers = dir.onPfi(roles, pfi.id);
          if (officers.length) count += 1;
          for (const p of officers) {
            if (!missing.has(p.id)) missing.set(p.id, new Map());
            const mine = missing.get(p.id);
            mine.set(type, [...(mine.get(type) || []), pfi.label]);
          }
        }
      }
      totals.reports = count;
      for (const [staffId, mine] of missing) {
        if (!wanted(staffId)) continue;
        const person = dir.byId.get(staffId);
        messages.push({
          kind: "report",
          person,
          data: {
            firstName: person.firstName,
            day: dayLabel(today),
            reports: [...mine.entries()].map(([type, list]) => ({ name: REPORT_NAMES[type] || "daily report", pfis: list })),
            path: "/my-report",
          },
        });
      }
    } catch (err) {
      console.error("[work-reminders] reports failed:", err.message);
      failures.push({ kind: "reports", error: err.message });
    }
  }

  // ── No orders today on an active depot-sales PFI: every officer on it.
  if (due.noOrders) {
    try {
      const counts = await client`
        SELECT pfi_id, COUNT(*)::int AS n FROM orders
         WHERE pfi_id IS NOT NULL AND (created_at AT TIME ZONE ${TZ()})::date = ${today}::date
         GROUP BY pfi_id`;
      const raised = new Map(counts.map((c) => [Number(c.pfi_id), c.n]));
      const quiet = depotSalesPfis(pfis).filter((p) => !raised.get(p.id));
      totals.noOrders = quiet.length;
      const told = new Map(); // staffId → [pfi]
      for (const pfi of quiet) {
        for (const p of dir.onPfi(null, pfi.id)) told.set(p.id, [...(told.get(p.id) || []), pfi]);
      }
      for (const [staffId, list] of told) {
        if (!wanted(staffId)) continue;
        const person = dir.byId.get(staffId);
        messages.push({
          kind: "noOrders",
          person,
          data: {
            firstName: person.firstName,
            day: dayLabel(today),
            pfis: list.map((p) => ({ pfi: p.label, location: p.location })),
            path: "/orders",
          },
        });
      }
    } catch (err) {
      console.error("[work-reminders] no-orders check failed:", err.message);
      failures.push({ kind: "noOrders", error: err.message });
    }
  }

  const off = await switchedOff();
  const order = { desk: 0, report: 1, noOrders: 2 };
  messages.sort((a, b) => a.person.name.localeCompare(b.person.name) || order[a.kind] - order[b.kind]);
  return {
    round: roundKey(at),
    totals,
    failures,
    names: namedDesks(dir),
    messages: messages.map((m) => ({ ...m, switchedOff: off.has(m.person.id), text: textOf(m) })),
  };
};

/** Staff switched off reminders on Manage Users. */
const switchedOff = async () => {
  try {
    const rows = await client`
      SELECT staff_id FROM staff_notification_overrides
       WHERE choice = 'work_reminders' AND enabled = false`;
    return new Set(rows.map((r) => Number(r.staff_id)));
  } catch {
    return new Set();
  }
};

/** The SMS exactly as the catalog will word it. */
const textOf = (m) => CATALOG[NOTICES[m.kind]].sms(m.data);

const summaryOf = (m) => ({
  staffId: m.person.id,
  name: m.person.name,
  phone: m.person.phone,
  kind: m.kind,
  text: m.text,
});

// ─── Sending a round ────────────────────────────────────────────────────────

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
 * Send a round: build it, then one notice per message.
 *
 * A scheduled round that already ran this hour is skipped whole. "Send now"
 * builds a fresh round; anyone already sent the same kind this hour comes back
 * as `duplicate` and is not texted again.
 *
 * @param {{trigger?: "schedule"|"manual", actor?: object, at?: Date, staffIds?: number[]}} opts
 */
const runRound = async ({ trigger = "schedule", actor = null, at = new Date(), staffIds = null } = {}) => {
  if (!settings().enabled) {
    return { skipped: true, reason: "Reminders are switched off (WORK_REMINDERS_ENABLED=false)" };
  }

  const round = roundKey(at);
  if (trigger === "schedule" && (await roundAlreadySent(round))) {
    return { skipped: true, reason: `The ${round} round has already gone out`, round };
  }

  const built = await buildRound(at, { trigger, staffIds });
  const results = [];
  const queue = [...built.messages];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      if (m.switchedOff) {
        results.push({ ...summaryOf(m), status: "switched_off" });
        continue;
      }
      let status = "texted";
      let error = null;
      try {
        const res = await notifyAndWait(NOTICES[m.kind], { to: [{ staffId: m.person.id }], data: { ...m.data, round } });
        const r = res?.results?.[0];
        if (res?.error) [status, error] = ["failed", res.error];
        else if (res?.skipped) [status, error] = ["failed", res.reason || "Not sent"];
        else if (!r) status = "switched_off";
        else if (r.duplicate) status = "duplicate";
        else if (r.error) [status, error] = ["failed", r.error];
        else if (r.channels?.sms !== "sent") {
          // Told in the app; why not by text is on the suppression.
          status = "app_only";
          error = r.suppressed?.find((s) => s.channel === "sms")?.reason || r.channelErrors?.sms || null;
        }
      } catch (err) {
        [status, error] = ["failed", err.message];
      }
      results.push({ ...summaryOf(m), status, error });
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
    messages: results.length,
    people: new Set(results.map((r) => r.staffId)).size,
    texted: count("texted"),
    appOnly: count("app_only"),
    duplicates: count("duplicate"),
    switchedOff: count("switched_off"),
    failed: count("failed"),
    totals: built.totals,
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

/** The last rounds, newest first, for the Reminders tab. */
const recentRounds = async (limit = 20) => {
  const rows = await client`
    SELECT id, actor_name, metadata, created_at
      FROM audit_events
     WHERE action = ${ROUND_ACTION} AND entity_type = ${ROUND_ENTITY}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({ id: r.id, at: r.created_at, by: r.actor_name || "", ...(r.metadata || {}) }));
};

const hourList = (hours) => hours.map((h) => `${h}:00`).join(", ");

/** "Every 2 hours, 8:00 to 20:00" where the hours are evenly spaced, else the list. */
const deskWhen = (hours) => {
  const gaps = new Set(hours.slice(1).map((h, i) => h - hours[i]));
  return hours.length > 2 && gaps.size === 1
    ? `Every ${[...gaps][0]} hours, ${hours[0]}:00 to ${hours[hours.length - 1]}:00`
    : hourList(hours);
};

/** The rules as the Reminders tab states them, with how much each has waiting now. */
const rulesOf = (cfg, totals, names) => [
  ...DESK_KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    who: typeof k.who === "function" ? k.who(names) : k.who,
    when: `${deskWhen(cfg.deskHours)}, once waiting ${cfg.afterHours} hour${cfg.afterHours === 1 ? "" : "s"}`,
    path: k.path,
    waiting: totals[k.key] ?? 0,
  })),
  {
    key: "reports",
    label: "Daily report not entered",
    who: "The officers on each active depot-sales PFI who file that report",
    when: `${hourList(cfg.reportHours).replace(/, ([^,]*)$/, " and $1")}, while today's report is not in`,
    path: "/my-report",
    waiting: totals.reports ?? 0,
  },
  {
    key: "noOrders",
    label: "No orders raised today",
    who: "Every officer on an active depot-sales PFI",
    when: `${cfg.noOrdersHour}:00, when the PFI has raised no order today`,
    path: "/orders",
    waiting: totals.noOrders ?? 0,
  },
];

/** Everything the Reminders tab shows. */
const overview = async (at = new Date()) => {
  const cfg = settings();
  const [built, rounds] = await Promise.all([buildRound(at, { trigger: "preview" }), recentRounds()]);
  return {
    settings: {
      ...cfg,
      cron: cronExpression(),
      running: cfg.enabled && cfg.scheduled,
      nextRound: cfg.enabled && cfg.scheduled ? nextRound(at) : null,
    },
    rules: rulesOf(cfg, built.totals, built.names),
    round: built.round,
    failures: built.failures,
    messages: built.messages.map((m) => ({
      ...summaryOf(m),
      roles: [...m.person.roles],
      switchedOff: m.switchedOff,
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
  dueKinds,
  DESK_KINDS,
  NOTICES,
  ROUND_ACTION,
};
