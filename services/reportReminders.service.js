const { client } = require("../db");
const audit = require("./audit.service");
const { sendSMSWithFallback } = require("./sms.service");
const { ROLE_ORDER, ROLE_LABELS } = require("../notifications/templates/roleFields");

/**
 * Who has not filed their daily report, per desk and PFI, and the SMS that
 * chases them.
 *
 * ── The grid is the report's own ───────────────────────────────────────────
 *
 * The same batches as STAFF REPORTS in the Sales & Operations Report — every
 * active PFI that is not trucking — under the same five desks. A desk on a
 * batch is FILED when any sheet of that type was filed against the batch for
 * the day, whoever filed it, exactly as the report reads it. So this page and
 * the report's "Not reported" rows can never disagree about which desk is
 * outstanding.
 *
 * ── Who owes it is role plus scope ─────────────────────────────────────────
 *
 * The rule deskAssignments.service uses for the ticketing and gate desks: a
 * person owes a sheet when they hold a role that files it AND the batch is in
 * their scope — assigned to the PFI itself (pfi_staff), or to the depot it is
 * sold from (depot_staff). Someone who can see every location but is assigned
 * nowhere is not an owner; treating visibility as ownership would text every
 * sales manager in the company about every batch. A desk nobody is scoped to
 * is reported as having no officer, because that is a staffing gap a reminder
 * cannot close.
 *
 * ── Reminders are recorded ─────────────────────────────────────────────────
 *
 * Each SMS is an audit_events row (action daily_report.reminder, entity the
 * day), so the page can say who was already texted and when, and a second
 * admin does not text the same person twice in ten minutes without knowing.
 */

/** Which staff roles file which report. Mirrors ROLE_REPORT in soromanfe's my-report config. */
const FILER_ROLES = {
  sales_manager: ["sales_manager"],
  product_manager: ["product_manager"],
  security_gate: ["security_entry"],
  commissions: ["commissions", "commission_officer"],
  it_compliance: ["it_compliance"],
};

const REMINDER_ACTION = "daily_report.reminder";
const REMINDER_ENTITY = "daily_report_day";

const pfiKey = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
const nameOf = (s) => [s.first_name, s.surname].filter(Boolean).join(" ").trim() || `Staff #${s.id}`;

/**
 * "Mon 29 Sep" — the day as a text says it. Short because an SMS is billed by
 * the 160 characters, and the long form alone pushed an ordinary reminder
 * onto a second page.
 */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// By hand: en-GB writes September "Sept", and the ICU data differs by Node build.
const dayLabel = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/**
 * The day's desks, each with who filed it or who has not.
 *
 * @param {string} dateStr YYYY-MM-DD, a Lagos calendar day
 */
const outstandingReports = async (dateStr) => {
  const [pfiRows, sheetRows, staffRows, reminderRows] = await Promise.all([
    client`
      SELECT id, pfi_number, location_id, location_name
        FROM pfis
       WHERE status = 'active' AND pfi_type::text <> 'trucking'
       ORDER BY id DESC`,
    client`
      SELECT id, report_type::text AS role, pfi_number, submitted_by, submitted_by_name,
             status::text AS status, created_at
        FROM daily_reports
       WHERE report_date = ${dateStr}
       ORDER BY created_at ASC`,
    client`
      SELECT id, first_name, surname, phone_number, roles
        FROM staff
       WHERE is_active = true AND suspended = false`,
    client`
      SELECT actor_name, metadata, created_at
        FROM audit_events
       WHERE action = ${REMINDER_ACTION}
         AND entity_type = ${REMINDER_ENTITY}
         AND entity_id = ${dateStr}
       ORDER BY created_at ASC`,
  ]);

  const allFilerRoles = new Set(Object.values(FILER_ROLES).flat());
  const filers = staffRows.filter((s) => (s.roles || []).some((r) => allFilerRoles.has(r)));
  const ids = filers.map((s) => s.id);

  const [pfiLinks, depotLinks] = ids.length
    ? await Promise.all([
        client`SELECT staff_id, pfi_id FROM pfi_staff WHERE staff_id IN ${client(ids)}`,
        client`SELECT staff_id, depot_id FROM depot_staff WHERE staff_id IN ${client(ids)}`,
      ])
    : [[], []];

  const setsBy = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.staff_id)) m.set(r.staff_id, new Set());
      m.get(r.staff_id).add(Number(r[key]));
    }
    return m;
  };
  const pfisBy = setsBy(pfiLinks, "pfi_id");
  const depotsBy = setsBy(depotLinks, "depot_id");

  const owns = (person, pfi) =>
    Boolean(pfisBy.get(person.id)?.has(Number(pfi.id)))
    || (pfi.location_id != null && Boolean(depotsBy.get(person.id)?.has(Number(pfi.location_id))));

  // The texts already sent today, by person and desk.
  const remindedBy = new Map();
  for (const r of reminderRows) {
    const m = r.metadata || {};
    if (!m.ok) continue;
    for (const d of m.desks || []) {
      const k = `${m.staffId}|${d.role}|${d.pfiId}`;
      if (!remindedBy.has(k)) remindedBy.set(k, []);
      remindedBy.get(k).push({ at: r.created_at, by: r.actor_name || "" });
    }
  }

  const roles = ROLE_ORDER.map((type) => {
    const holders = filers.filter((s) => (s.roles || []).some((r) => FILER_ROLES[type].includes(r)));
    const desks = pfiRows.map((p) => {
      const sheets = sheetRows.filter((s) => s.role === type && pfiKey(s.pfi_number) === pfiKey(p.pfi_number));
      const officers = holders
        .filter((s) => owns(s, p))
        .map((s) => ({
          staffId: s.id,
          name: nameOf(s),
          phone: s.phone_number || null,
          filed: sheets.some((sh) => sh.submitted_by === s.id),
          reminders: remindedBy.get(`${s.id}|${type}|${p.id}`) || [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        pfiId: p.id,
        pfiNumber: p.pfi_number,
        location: p.location_name || "",
        status: sheets.length ? "filed" : "missing",
        filedBy: sheets.map((sh) => ({
          name: sh.submitted_by_name || "",
          status: sh.status,
          at: sh.created_at,
        })),
        officers,
      };
    });
    return { type, label: ROLE_LABELS[type], desks };
  });

  const all = roles.flatMap((r) => r.desks);
  const missing = all.filter((d) => d.status === "missing");
  const toRemind = new Set(missing.flatMap((d) => d.officers.filter((o) => o.phone).map((o) => o.staffId)));

  return {
    date: dateStr,
    pfis: pfiRows.map((p) => ({ id: p.id, pfiNumber: p.pfi_number, location: p.location_name || "" })),
    roles,
    summary: {
      desks: all.length,
      filed: all.length - missing.length,
      missing: missing.length,
      unassigned: missing.filter((d) => d.officers.length === 0).length,
      officersToRemind: toRemind.size,
    },
  };
};

/** What each desk calls its sheet — the titles on the officer's own My report page. */
const REPORT_NAMES = {
  sales_manager: "daily sales report",
  product_manager: "product manager's report",
  security_gate: "gate report",
  commissions: "commission report",
  it_compliance: "compliance report",
};

/**
 * "PFI/47/26/MT LESTE/CALABAR/17KT" → "PFI 47": how the desks say it, and a
 * fifth of the length in a message billed by the page. The full number is
 * kept wherever two of a person's batches would shorten to the same thing.
 */
const shortPfi = (pfiNumber) => {
  const m = String(pfiNumber || "").match(/^PFI[\s/-]*(\d+[A-Z]?)/i);
  return m ? `PFI ${m[1].toUpperCase()}` : String(pfiNumber || "");
};

/**
 * One text per person, naming every report and batch they are behind on.
 *
 * Short on purpose — it is a nudge to open the dashboard, not a report — but
 * specific: "your report" with no batch named gets the answer "which one?".
 */
const reminderText = ({ firstName, date, desks, note }) => {
  // Two DIFFERENT batches that shorten alike; the same batch under two
  // reports is not a clash.
  const shorts = [...new Set(desks.map((d) => d.pfiNumber))].map(shortPfi);
  const clash = new Set(shorts.filter((v, i) => shorts.indexOf(v) !== i));
  const label = (d) => (clash.has(shortPfi(d.pfiNumber)) ? d.pfiNumber : shortPfi(d.pfiNumber));

  const byRole = new Map();
  for (const d of desks) {
    if (!byRole.has(d.role)) byRole.set(d.role, []);
    const l = label(d);
    if (!byRole.get(d.role).includes(l)) byRole.get(d.role).push(l);
  }
  const hello = firstName ? `Hello ${firstName}, ` : "";
  const day = dayLabel(date);
  const entries = [...byRole.entries()];
  const body = entries.length === 1
    ? `your ${REPORT_NAMES[entries[0][0]] || "daily report"} for ${day} is not in yet for ${entries[0][1].join(", ")}.` +
      ` Please file it on the dashboard.`
    : `your reports for ${day} are not in yet: ` +
      entries.map(([role, pfis]) => `${REPORT_NAMES[role] || role} for ${pfis.join(", ")}`).join("; ") +
      `. Please file them on the dashboard.`;
  const extra = String(note || "").trim();
  const text = `${hello}${body}${extra ? ` ${extra}` : ""}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Text the chosen officers about the desks they have not filed.
 *
 * The targets are checked against a fresh read, not trusted: a desk filed in
 * the minute since the page loaded is dropped rather than chased, and a
 * person not on a desk cannot be texted through it. Each person gets one SMS
 * however many desks they are behind on.
 *
 * @param {{date: string, targets: Array<{staffId: number, role: string, pfiId: number}>, note?: string, dryRun?: boolean}} input
 * @param {{actor: object}} ctx
 */
const sendReminders = async ({ date, targets, note, dryRun = false }, { actor } = {}) => {
  const state = await outstandingReports(date);

  const people = new Map();
  const skipped = [];
  for (const t of targets) {
    const role = state.roles.find((r) => r.type === t.role);
    const desk = role?.desks.find((d) => Number(d.pfiId) === Number(t.pfiId));
    const officer = desk?.officers.find((o) => Number(o.staffId) === Number(t.staffId));
    if (!desk || !officer) {
      skipped.push({ ...t, reason: "Not an officer on this desk" });
      continue;
    }
    if (desk.status === "filed") {
      skipped.push({ ...t, name: officer.name, reason: "Already filed" });
      continue;
    }
    if (!people.has(officer.staffId)) people.set(officer.staffId, { officer, desks: [] });
    const entry = people.get(officer.staffId);
    if (!entry.desks.some((d) => d.role === t.role && d.pfiId === desk.pfiId)) {
      entry.desks.push({ role: t.role, pfiId: desk.pfiId, pfiNumber: desk.pfiNumber });
    }
  }

  const messages = [...people.values()].map(({ officer, desks }) => ({
    staffId: officer.staffId,
    name: officer.name,
    phone: officer.phone,
    desks,
    text: reminderText({ firstName: officer.name.split(" ")[0], date, desks, note }),
  }));

  if (dryRun) return { date, messages, skipped };

  const results = [];
  const queue = [...messages];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      let ok = false;
      let error = null;
      if (!m.phone) {
        error = "No phone number on their staff record";
      } else {
        try {
          const res = await sendSMSWithFallback(m.phone, m.text);
          ok = Boolean(res?.success);
          if (!ok) error = res?.message || "SMS not accepted";
        } catch (err) {
          error = err.message || "SMS failed";
        }
      }
      results.push({ ...m, ok, error });
      try {
        await audit.record({
          action: REMINDER_ACTION,
          actor,
          entityType: REMINDER_ENTITY,
          entityId: date,
          metadata: { staffId: m.staffId, name: m.name, phone: m.phone, desks: m.desks, ok, error, text: m.text },
        });
      } catch (err) {
        console.error("[report-reminders] audit write failed:", err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  results.sort((a, b) => a.name.localeCompare(b.name));
  return { date, results, skipped };
};

module.exports = { outstandingReports, sendReminders, reminderText, shortPfi, dayLabel, FILER_ROLES, REPORT_NAMES };
