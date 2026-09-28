const { client } = require("../config/db");
const { pfiRepo } = require("../repositories");
const { toIso } = require("../repositories/pfiFile.repository");

/**
 * One staff member's PFI record: what they are on now, what they have been on
 * before, and every change in between — read from pfi_assignment_log
 * (migration 0060), the append-only record the pfi_staff trigger writes.
 *
 * Three views of the same facts, for three questions:
 *
 *   current   what they are assigned to today, since when, by whom
 *   past      each assignment that has ended: from, to, who began it, who
 *             ended it, how, and for how long
 *   events    every row of the log, in order, with where each change came
 *             from — the evidence the two summaries are built from
 *
 * pfi_staff is the truth for "today", and the summary is checked against it:
 * an assignment present there with no record of its beginning is still shown
 * as current, flagged, rather than silently missing. The same the other way —
 * a period the log thinks is open but pfi_staff no longer holds is closed as
 * "ended, not recorded". Neither should happen; if one does, it shows.
 *
 * Alongside, the PFIs that name this person as one of their officers, and
 * whether they have access to each — being named on a PFI and being assigned
 * to it are different facts, and a PFI naming an officer who cannot open it is
 * worth seeing.
 */

/** How a change was made, in words. Keys are the log's `source` values. */
const SOURCE_LABELS = {
  manage_users: "Manage Users",
  pfi_activation: "PFI activation",
  account_deleted: "Account deleted",
  pfi_deleted: "PFI deleted",
  history_start: "In place when the record began",
  unattributed: "Outside the app (not attributed)",
};

/** The officer roles a PFI can name, with the words its own screens use. */
const OFFICER_ROLES = [
  { column: "audit_officer_id", label: "Finance / Audit Officer" },
  { column: "sales_manager_id", label: "Sales Manager" },
  { column: "product_officer_id", label: "Product Manager" },
  { column: "commission_officer_id", label: "Commission Officer" },
  { column: "it_compliance_officer_id", label: "IT Compliance Officer" },
  { column: "security_exit_officer_id", label: "Security Exit Officer" },
];

const DAY = 86_400_000;
const daysBetween = (from, to) => {
  const a = from ? new Date(from).getTime() : NaN;
  const b = to ? new Date(to).getTime() : Date.now();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.floor((b - a) / DAY)) : null;
};

const toEvent = (r) => ({
  id: Number(r.id),
  action: r.action,
  occurredAt: toIso(r.occurredAt),
  recordedAt: toIso(r.recordedAt),
  dateIsApproximate: Boolean(r.dateIsApproximate),
  pfiId: Number(r.pfiId),
  pfiNumber: r.pfiNumber,
  actorStaffId: r.actorStaffId == null ? null : Number(r.actorStaffId),
  actorName: r.actorName || "",
  source: r.source,
  sourceLabel: SOURCE_LABELS[r.source] || r.source,
  note: r.note || "",
  ipAddress: r.ipAddress || "",
  userAgent: r.userAgent || "",
});

/**
 * @param {number} staffId
 * @returns {Promise<{current: object[], past: object[], events: object[], namedAsOfficer: object[]}>}
 */
const recordFor = async (staffId) => {
  const id = Number(staffId);

  const [rows, held, named] = await Promise.all([
    client`
      SELECT id, action, occurred_at AS "occurredAt", recorded_at AS "recordedAt",
             date_is_approximate AS "dateIsApproximate", pfi_id AS "pfiId", pfi_number AS "pfiNumber",
             actor_staff_id AS "actorStaffId", actor_name AS "actorName", source, note,
             ip_address AS "ipAddress", user_agent AS "userAgent"
        FROM pfi_assignment_log
       WHERE staff_id = ${id}
       ORDER BY occurred_at, id`,
    client`SELECT pfi_id AS "pfiId", created_at AS "createdAt" FROM pfi_staff WHERE staff_id = ${id}`,
    client`
      SELECT id, pfi_number AS "pfiNumber",
             ${client.unsafe(OFFICER_ROLES.map((r) => `${r.column} = ${id} AS "${r.column}"`).join(", "))}
        FROM pfis
       WHERE ${client.unsafe(OFFICER_ROLES.map((r) => `${r.column} = ${id}`).join(" OR "))}`,
  ]);

  const events = rows.map(toEvent);
  const heldIds = new Set(held.map((h) => Number(h.pfiId)));

  // Officer roles this person holds on each PFI, by PFI.
  const rolesOn = new Map();
  for (const p of named) {
    rolesOn.set(Number(p.id), OFFICER_ROLES.filter((r) => p[r.column]).map((r) => r.label));
  }

  // Walk the log into periods, per PFI, in order.
  const open = new Map();
  const periods = [];
  const close = (period, event) => {
    period.removedAt = event.occurredAt;
    period.removedBy = event.actorName;
    period.removedVia = event.sourceLabel;
    period.removedNote = event.note;
    periods.push(period);
  };
  for (const e of events) {
    if (e.action === "assigned") {
      // Assigned twice with no removal between is not a new period — the
      // first beginning stands.
      if (!open.has(e.pfiId)) {
        open.set(e.pfiId, {
          pfiId: e.pfiId,
          pfiNumber: e.pfiNumber,
          assignedAt: e.occurredAt,
          assignedAtApproximate: e.dateIsApproximate,
          assignedBy: e.actorName,
          assignedVia: e.sourceLabel,
          assignedNote: e.note,
        });
      }
    } else {
      const period = open.get(e.pfiId) || {
        // Ended with no recorded beginning: it began before the record did.
        pfiId: e.pfiId,
        pfiNumber: e.pfiNumber,
        assignedAt: null,
        assignedAtApproximate: true,
        assignedBy: "",
        assignedVia: "Before the record began",
        assignedNote: "",
      };
      open.delete(e.pfiId);
      close(period, e);
    }
  }

  // What the log thinks is open, checked against what pfi_staff holds.
  const current = [];
  for (const period of open.values()) {
    if (heldIds.has(period.pfiId)) current.push(period);
    else {
      periods.push({
        ...period,
        removedAt: null,
        removedBy: "",
        removedVia: "Ended, not recorded",
        removedNote: "No longer assigned, but the record holds no removal.",
      });
    }
  }
  for (const h of held) {
    if (!open.has(Number(h.pfiId))) {
      current.push({
        pfiId: Number(h.pfiId),
        pfiNumber: "",
        assignedAt: toIso(h.createdAt),
        assignedAtApproximate: true,
        assignedBy: "",
        assignedVia: "Not recorded",
        assignedNote: "Assigned, but the record holds no entry for it.",
      });
    }
  }

  // The PFIs as they are now, for their status, product and place — or null
  // when the PFI has since been deleted.
  const pfiIds = [...new Set([...current, ...periods].map((p) => p.pfiId).concat(named.map((n) => Number(n.id))))];
  const now = new Map((await pfiRepo.findByIds(pfiIds)).map((p) => [Number(p.id), p]));
  const describe = (pfiId) => {
    const p = now.get(pfiId);
    return p
      ? {
          exists: true,
          status: p.status,
          pfiType: p.pfiType,
          productName: p.productName || "",
          locationName: p.locationName || "",
        }
      : { exists: false, status: "deleted", pfiType: "", productName: "", locationName: "" };
  };
  const finish = (p) => ({
    ...p,
    pfiNumber: p.pfiNumber || now.get(p.pfiId)?.pfiNumber || `PFI #${p.pfiId}`,
    pfi: describe(p.pfiId),
    officerRoles: rolesOn.get(p.pfiId) || [],
    days: daysBetween(p.assignedAt, p.removedAt),
  });

  return {
    current: current.map(finish).sort((a, b) => String(b.assignedAt).localeCompare(String(a.assignedAt))),
    past: periods.map(finish).sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt))),
    events: events.reverse(),
    namedAsOfficer: named.map((p) => ({
      pfiId: Number(p.id),
      pfiNumber: p.pfiNumber,
      roles: rolesOn.get(Number(p.id)) || [],
      hasAccess: heldIds.has(Number(p.id)),
      pfi: describe(Number(p.id)),
    })),
  };
};

module.exports = { recordFor, SOURCE_LABELS, OFFICER_ROLES };
