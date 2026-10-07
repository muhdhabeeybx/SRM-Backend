const { and, eq, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff, staffNotificationOverrides, orders, pfiStaff, depotStaff } = require("../db/schema");
const { toPrincipal } = require("../utils/principal");
const { staffContact } = require("./recipients");

/**
 * Which notifications each member of staff gets.
 *
 * Not everybody needs every notice. "Order placed" went to every sales and
 * finance manager for every order in the company, so a manager assigned to
 * one PFI had an inbox of 1,600 rows about other people's cargo. This is the
 * one list an admin ticks per person on Manage Users, and the one list the
 * senders read their audience from, so the form can never show a default the
 * sender does not use.
 *
 * ── Two kinds of choice ────────────────────────────────────────────────────
 *
 *   Sent by role   `roles` is who gets it by default — the senders pass
 *                  rolesFor(key) straight to notify(). An admin can take
 *                  somebody out of it, or add somebody whose role would not
 *                  get it.
 *
 *   Personal       sent because it concerns the person: an expense they
 *                  raised or must approve, their desk's backlog, a report they
 *                  submitted. Everyone involved gets it by default. It can be
 *                  switched off for somebody, not on — there is nothing to
 *                  send them unless they are involved.
 *
 * A choice can cover a small family of types ("expenses" is every stage of
 * the approval chain), because nobody wants eight ticks for one idea.
 *
 * Types not listed here — sign-in alerts, password setup, the scheduled report
 * emails — are not the admin's to switch off, and are never touched.
 *
 * ── How a choice is applied ────────────────────────────────────────────────
 *
 * At send time, in the engine (engine.js, dispatch): after the recipients are
 * resolved, anybody with this choice switched off is dropped — from every
 * channel, the bell, push and email alike — and on a role choice anybody with
 * it switched on is added. The inbox also hides rows of a type somebody has
 * since had switched off (mutedTypesFor), so unticking takes effect at once
 * rather than after their backlog of old rows is read.
 *
 * ── Order notices follow the reader's scope ────────────────────────────────
 *
 * A notice about one order (`orderScoped`) reaches a person only when that
 * order is inside their scope, by the rule their order list uses
 * (lib/scopeFilter.js): their PFIs if they have any, else their depots, else
 * everything. Ticking "payments received" for a manager on one PFI brings
 * them that PFI's payments, not the company's.
 *
 * ── The defaults ───────────────────────────────────────────────────────────
 *
 * The company-wide order feeds — every order placed, every payment confirmed —
 * go to admins by default and to nobody else. They ran at about 200 a day per
 * person; the desks that act on an order find it in their work queue, and
 * anybody who does want the feed is ticked on for it, per person. Until
 * 2026-09-27 both also went to every sales manager.
 */

/** Reviewers of the operations paperwork: daily reports, fleet changes. */
const OPERATIONS_REVIEWERS = ["admin", "super_admin", "operations_manager"];
/** Incidents go to the same reviewers, and to safety. */
const INCIDENT_REVIEWERS = [...OPERATIONS_REVIEWERS, "hse_officer", "safety_officer"];

const CHOICES = [
  // ── Sent by role ──────────────────────────────────────────────────────────
  {
    key: "orders_placed",
    label: "New orders",
    description: "An order is placed — customer, product, quantity and value. Only orders within their PFIs or depots.",
    types: ["staff.order_placed"],
    // finance_manager is who the email is written for ("payment processing
    // required"); nobody holds the role today, so it costs nothing to keep.
    roles: ["admin", "super_admin", "finance_manager"],
    orderScoped: true,
  },
  {
    key: "payments_received",
    label: "Payments received",
    description: "An order's payment is confirmed and it is ready to release. Only orders within their PFIs or depots.",
    types: ["staff.payment_received"],
    roles: ["admin", "super_admin"],
    orderScoped: true,
  },
  {
    key: "refunds_to_pay",
    label: "Refunds to pay",
    description: "A refund of an overpayment is requested and waiting to be sent. Only orders within their PFIs or depots.",
    types: ["staff.refund_requested"],
    roles: ["finance", "super_admin"],
    orderScoped: true,
  },
  {
    // Sent to the named approvers and super admins (lib/transferApprovers);
    // the roles here only decide who may switch it off.
    key: "transfers_to_approve",
    label: "Surplus transfers to approve",
    description: "Finance asks to move an overpayment from one order to another, and it waits for approval.",
    types: ["staff.transfer_requested"],
    roles: ["finance", "admin", "super_admin"],
  },
  {
    key: "requests_submitted",
    label: "Dangote and LPG requests",
    description: "A Dangote or LPG request is submitted.",
    types: ["staff.request_submitted"],
    roles: ["admin", "super_admin", "sales_manager"],
  },
  {
    key: "pfi_allocations",
    label: "Truck allocations to approve",
    description: "Trucks are allocated off a PFI and wait for approval before the order and the trucking PFI are made.",
    types: ["staff.pfi_allocation_raised"],
    roles: ["admin", "super_admin"],
  },
  {
    key: "daily_reports",
    label: "Daily reports submitted",
    description: "A desk submits its daily report for review.",
    types: ["staff.daily_report_submitted"],
    roles: OPERATIONS_REVIEWERS,
  },
  {
    key: "incidents",
    label: "Incidents reported",
    description: "An incident is logged for review.",
    types: ["staff.incident_submitted"],
    roles: INCIDENT_REVIEWERS,
  },
  {
    key: "fleet_changes",
    label: "Fleet changes",
    description: "A truck is added, changed or taken off the fleet.",
    types: ["staff.fleet_updated"],
    roles: [...OPERATIONS_REVIEWERS, "fleet_manager"],
  },
  {
    key: "report_failures",
    label: "Reports that failed to send",
    description: "A scheduled report email could not be delivered.",
    types: ["staff.report_send_failed"],
    roles: ["admin", "super_admin"],
  },

  // ── Personal ──────────────────────────────────────────────────────────────
  {
    key: "expenses",
    label: "Expense requests",
    description: "Requests they raised or must act on, as they move through approval.",
    types: [
      "expense.pending", "expense.verified", "expense.audit_approved", "expense.admin_approved",
      "expense.progress", "expense.paid", "expense.rejected", "expense.changes_requested", "expense.comment",
    ],
    personal: true,
  },
  {
    key: "desk_reminders",
    label: "Desk reminders",
    description: "Orders waiting for tickets, trucks waiting at the gate or still on the yard.",
    types: ["staff.tickets_pending", "staff.trucks_awaiting_entry", "staff.trucks_on_yard"],
    personal: true,
  },
  {
    // Every two hours, one text listing everything waiting on the person —
    // see services/workReminders.service.js for who owes what.
    key: "work_reminders",
    label: "Reminders of waiting work",
    description:
      "Texts about work on their own desks: expense requests at their stage, payments to confirm, orders to ticket, trucks to gate out; their daily report at 20:00 and 22:00; no orders by 18:00 on their PFI.",
    types: ["staff.work_reminder", "staff.report_reminder", "staff.no_orders_alert"],
    personal: true,
  },
  {
    // Sent to the officers of the next desk on the order's PFI, by text as
    // well as the bell — see notifications/deskOfficers.js for who that is.
    key: "desk_steps",
    label: "Order and truck steps for their desk",
    description:
      "A text when an order or truck on their PFI reaches their desk: an order to confirm, tickets to write, trucks at the gate, truck payments to confirm.",
    types: [
      "desk.order_to_confirm", "desk.order_to_ticket", "desk.trucks_to_admit", "desk.trucks_on_yard",
      "desk.order_completed", "desk.order_cancelled", "desk.trucks_to_sell", "desk.truck_payment",
    ],
    personal: true,
  },
  {
    key: "own_submissions",
    label: "Updates on what they submitted",
    description: "Their daily report approved or sent back, an incident or offline sale they logged updated, trucks they allocated approved or rejected.",
    types: [
      "staff.daily_report_approved", "staff.daily_report_rejected",
      "staff.incident_updated", "staff.offline_sale_updated",
      "staff.pfi_allocation_decided", "staff.refund_decided", "staff.transfer_decided",
    ],
    personal: true,
  },
];

const BY_KEY = new Map(CHOICES.map((c) => [c.key, c]));
const BY_TYPE = new Map(CHOICES.flatMap((c) => c.types.map((t) => [t, c])));
const KEYS = CHOICES.map((c) => c.key);

/** The choice a notification type belongs to, or undefined when it has none. */
const choiceForType = (type) => BY_TYPE.get(type);

/** Who gets a role choice by default — what its sender passes to notify(). */
const rolesFor = (key) => {
  const choice = BY_KEY.get(key);
  if (!choice?.roles) throw new Error(`No role choice "${key}" in notifications/staffChoices.js`);
  return [...choice.roles];
};

/** Whether somebody with these (backend) roles gets a choice when nobody has said otherwise. */
const defaultFor = (choice, roles = []) =>
  choice.personal ? true : choice.roles.some((r) => roles.includes(r));

/** The list the Manage Users form draws, without the internal type names. */
const publicChoices = () =>
  CHOICES.map(({ key, label, description, roles, personal }) => ({
    key,
    label,
    description,
    personal: Boolean(personal),
    roles: roles ? [...roles] : [],
  }));

/**
 * The recipients an order notice may reach: those whose scope holds the order.
 *
 * The same rule as scopeCondition (lib/scopeFilter.js), asked of many people
 * at once: somebody who sees every location keeps it; somebody with PFIs keeps
 * it when the order is on one of them; otherwise somebody with depots keeps it
 * when the order is at one of them; somebody assigned nothing keeps it.
 */
const withinOrderScope = async (resolved, orderId) => {
  const id = Number(orderId);
  if (!Number.isFinite(id)) return resolved;
  const [order] = await db
    .select({ pfiId: orders.pfiId, depotId: orders.depotId })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) return resolved;

  const staffIds = resolved.filter((r) => r.principal?.type === "staff").map((r) => Number(r.principal.id));
  if (!staffIds.length) return resolved;

  const [people, pfiRows, depotRows] = await Promise.all([
    db
      .select({ id: staff.id, roles: staff.roles, canViewAllLocations: staff.canViewAllLocations })
      .from(staff)
      .where(inArray(staff.id, staffIds)),
    db.select({ staffId: pfiStaff.staffId, id: pfiStaff.pfiId }).from(pfiStaff).where(inArray(pfiStaff.staffId, staffIds)),
    db.select({ staffId: depotStaff.staffId, id: depotStaff.depotId }).from(depotStaff).where(inArray(depotStaff.staffId, staffIds)),
  ]);

  const byStaff = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(Number(r.staffId), [...(m.get(Number(r.staffId)) || []), Number(r.id)]);
    return m;
  };
  const pfisOf = byStaff(pfiRows);
  const depotsOf = byStaff(depotRows);

  const sees = new Set();
  for (const p of people) {
    // A super admin sees everything by role (staffScope.repository.getAuthContext).
    const everywhere = (p.roles || []).includes("super_admin") || (p.canViewAllLocations ?? true);
    const assignedPfis = pfisOf.get(Number(p.id)) || [];
    const assignedDepots = depotsOf.get(Number(p.id)) || [];
    const ok = everywhere
      ? true
      : assignedPfis.length
        ? order.pfiId != null && assignedPfis.includes(Number(order.pfiId))
        : assignedDepots.length
          ? order.depotId != null && assignedDepots.includes(Number(order.depotId))
          : true;
    if (ok) sees.add(Number(p.id));
  }
  return resolved.filter((r) => r.principal?.type !== "staff" || sees.has(Number(r.principal.id)));
};

/**
 * Apply everybody's choices to one send's recipients.
 *
 * @param {string} type       the notification type being sent
 * @param {Array} resolved    recipients.resolve() output
 * @param {object} [data]     the send's data — an order notice's orderId
 * @returns {Promise<Array>}  the recipients who should actually get it
 */
const apply = async (type, resolved, data = {}) => {
  const choice = choiceForType(type);
  if (!choice) return resolved;

  let out = resolved;
  const rows = await db
    .select({ staffId: staffNotificationOverrides.staffId, enabled: staffNotificationOverrides.enabled })
    .from(staffNotificationOverrides)
    .where(eq(staffNotificationOverrides.choice, choice.key));

  if (rows.length) {
    const isStaff = (r) => r.principal?.type === "staff";
    const off = new Set(rows.filter((r) => !r.enabled).map((r) => Number(r.staffId)));
    out = out.filter((r) => !(isStaff(r) && off.has(Number(r.principal.id))));

    // Somebody added to a role notice their role would not bring them. Never
    // a personal one: there is nothing about them to tell.
    if (!choice.personal) {
      const present = new Set(out.filter(isStaff).map((r) => Number(r.principal.id)));
      const add = rows.filter((r) => r.enabled && !present.has(Number(r.staffId))).map((r) => Number(r.staffId));
      if (add.length) {
        // Suspended and deactivated accounts are left out, as a role send
        // leaves them out (recipients.loadStaffByRoles).
        const extra = await db
          .select()
          .from(staff)
          .where(and(inArray(staff.id, add), eq(staff.isActive, true), eq(staff.suspended, false)));
        out = [...out, ...extra.map((row) => ({ principal: toPrincipal("staff", row.id), contact: staffContact(row) }))];
      }
    }
  }

  if (choice.orderScoped && data?.orderId != null) out = await withinOrderScope(out, data.orderId);
  return out;
};

/**
 * The notification types this person has had switched off — for hiding rows
 * already in their inbox, so an untick takes effect at once.
 */
const mutedTypesFor = async (staffId) => {
  if (!staffId) return [];
  // The bell and the dashboard call this on every load. If it cannot answer —
  // the table not yet migrated on a fresh deploy — they show everything, as
  // they did before, rather than failing.
  try {
    const rows = await db
      .select({ choice: staffNotificationOverrides.choice })
      .from(staffNotificationOverrides)
      .where(and(eq(staffNotificationOverrides.staffId, Number(staffId)), eq(staffNotificationOverrides.enabled, false)));
    return rows.flatMap((r) => BY_KEY.get(r.choice)?.types || []);
  } catch (err) {
    console.error("[staffChoices] could not read switched-off notifications:", err.message);
    return [];
  }
};

/**
 * Before migration 0059 has run, Manage Users must still open: reads answer
 * "no exceptions" rather than failing, so the backend can be deployed ahead
 * of the migration.
 */
const orNone = async (read, empty) => {
  try {
    return await read();
  } catch (err) {
    console.error("[staffChoices] could not read notification choices:", err.message);
    return empty;
  }
};

/** One person's exceptions, as the form sends and receives them. */
const overridesFor = (staffId) =>
  orNone(
    () =>
      db
        .select({ choice: staffNotificationOverrides.choice, enabled: staffNotificationOverrides.enabled })
        .from(staffNotificationOverrides)
        .where(eq(staffNotificationOverrides.staffId, Number(staffId))),
    [],
  );

/** The same, for the admin list, which opens the edit form without refetching. */
const overridesForStaffIds = async (staffIds) => {
  const byStaff = new Map(staffIds.map((id) => [id, []]));
  if (!staffIds.length) return byStaff;
  const rows = await orNone(
    () =>
      db
        .select({
          staffId: staffNotificationOverrides.staffId,
          choice: staffNotificationOverrides.choice,
          enabled: staffNotificationOverrides.enabled,
        })
        .from(staffNotificationOverrides)
        .where(inArray(staffNotificationOverrides.staffId, staffIds)),
    [],
  );
  for (const r of rows) byStaff.get(r.staffId)?.push({ choice: r.choice, enabled: r.enabled });
  return byStaff;
};

/**
 * Replace one person's exceptions. Unknown keys are dropped rather than
 * stored, so a stale form cannot write a choice nothing reads.
 */
const setOverrides = async (staffId, overrides = []) => {
  const clean = new Map();
  for (const o of overrides) if (BY_KEY.has(o.choice)) clean.set(o.choice, Boolean(o.enabled));
  await db.transaction(async (tx) => {
    await tx.delete(staffNotificationOverrides).where(eq(staffNotificationOverrides.staffId, Number(staffId)));
    if (clean.size) {
      await tx.insert(staffNotificationOverrides).values(
        [...clean].map(([choice, enabled]) => ({ staffId: Number(staffId), choice, enabled }))
      );
    }
  });
};

module.exports = {
  CHOICES,
  KEYS,
  OPERATIONS_REVIEWERS,
  INCIDENT_REVIEWERS,
  choiceForType,
  rolesFor,
  defaultFor,
  publicChoices,
  apply,
  mutedTypesFor,
  overridesFor,
  overridesForStaffIds,
  setOverrides,
};
