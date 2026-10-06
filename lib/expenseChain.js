const { isOfficerOf, isStationExpense } = require("./expenseOfficers");
/**
 * The expense approval chain — one place, so adding a stage is a data change.
 *
 * An expense is a payment request that walks four sign-offs, each by a
 * different role, and only becomes spending at the end. Nothing here is
 * duplicated in the views: the views ask this module what is allowed.
 *
 * Roles are this app's own strings. Mapped from the reference implementation:
 *
 *   SuperAdmin (0)           -> super_admin
 *   Admin (1)                -> admin
 *   Audit / CFO (8)          -> finance
 *   Expenditure Officer (19) -> expenditure_officer
 */

const ROLE = {
  SUPER: "super_admin",
  ADMIN: "admin",
  CFO: "finance",
  OFFICER: "expenditure_officer",
};

const STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  AUDIT_APPROVED: "audit_approved",
  ADMIN_APPROVED: "admin_approved",
  PAID: "paid",
  REJECTED: "rejected",
  CHANGES_REQUESTED: "changes_requested",
};

/**
 * Everything that is committed but has not left the bank.
 *
 * Read this rather than listing statuses inline — the same set is needed by
 * the list filters, the summary totals and the cost calculation, and they must
 * never drift apart.
 */
const OPEN_STATES = [
  STATUS.PENDING,
  STATUS.VERIFIED,
  STATUS.AUDIT_APPROVED,
  STATUS.ADMIN_APPROVED,
  STATUS.CHANGES_REQUESTED,
];

/**
 * Named after whoever has to act next, because that is the only thing anyone
 * reads a status for. The four sign-offs are: Expenditure Officer verifies,
 * CFO approves, Admin gives final approval, Expenditure Officer pays.
 */
const STATUS_LABELS = {
  [STATUS.PENDING]: "With Expenditure Officer",
  [STATUS.VERIFIED]: "With CFO",
  [STATUS.AUDIT_APPROVED]: "Awaiting final approval",
  [STATUS.ADMIN_APPROVED]: "Approved — awaiting payment",
  [STATUS.PAID]: "Paid",
  [STATUS.REJECTED]: "Rejected",
  [STATUS.CHANGES_REQUESTED]: "Changes requested",
};

/** Where a status sits in the four-step chain, for a "2 of 4" counter. */
const STATUS_STEP = {
  [STATUS.PENDING]: 0,
  [STATUS.CHANGES_REQUESTED]: 0,
  [STATUS.VERIFIED]: 1,
  [STATUS.AUDIT_APPROVED]: 2,
  [STATUS.ADMIN_APPROVED]: 3,
  [STATUS.PAID]: 4,
};
const TOTAL_STEPS = 4;

/**
 * The whole state machine. Adding a stage means adding a row here plus a stamp
 * pair below — no view logic changes.
 */
const TRANSITIONS = {
  verify: {
    /**
     * The expenditure officer NAMED for the expense verifies it, and pays it
     * at `mark_paid` (lib/expenseOfficers.js, see mayMake below). Admins used
     * to verify too; on 6 Oct 2026 the owner gave each expense one officer —
     * station and LPG plant expenses to one, the rest to another — and only
     * they, or a super admin, may verify or pay it.
     */
    roles: [ROLE.SUPER, ROLE.OFFICER],
    from: [STATUS.PENDING, STATUS.CHANGES_REQUESTED],
    to: STATUS.VERIFIED,
    label: "Verify",
  },
  audit_approve: {
    roles: [ROLE.SUPER, ROLE.CFO],
    from: [STATUS.VERIFIED],
    to: STATUS.AUDIT_APPROVED,
    label: "CFO approve",
  },
  admin_approve: {
    roles: [ROLE.SUPER, ROLE.ADMIN],
    from: [STATUS.AUDIT_APPROVED],
    to: STATUS.ADMIN_APPROVED,
    label: "Give final approval",
  },
  mark_paid: {
    roles: [ROLE.SUPER, ROLE.OFFICER],
    from: [STATUS.ADMIN_APPROVED],
    to: STATUS.PAID,
    label: "Mark paid",
    /**
     * The one transition that records facts of its own. Nobody knows which
     * account the money will leave from, or what will actually clear against
     * the amount requested, until it happens — so the officer supplies both
     * here and the controller refuses the transition without them.
     */
    capturesPayment: true,
  },
  reject: {
    roles: [ROLE.SUPER, ROLE.ADMIN, ROLE.CFO, ROLE.OFFICER],
    from: [
      STATUS.PENDING, STATUS.VERIFIED, STATUS.AUDIT_APPROVED,
      STATUS.ADMIN_APPROVED, STATUS.CHANGES_REQUESTED,
    ],
    to: STATUS.REJECTED,
    label: "Reject",
    requiresNote: true,
  },
  request_changes: {
    roles: [ROLE.SUPER, ROLE.ADMIN, ROLE.CFO, ROLE.OFFICER],
    from: [
      STATUS.PENDING, STATUS.VERIFIED, STATUS.AUDIT_APPROVED, STATUS.ADMIN_APPROVED,
    ],
    to: STATUS.CHANGES_REQUESTED,
    label: "Send back",
    requiresNote: true,
  },
};

/** Landing on a stage writes its own pair, alongside the reviewed_* overwrite. */
const STAGE_STAMPS = {
  [STATUS.VERIFIED]: ["verifiedBy", "verifiedAt"],
  [STATUS.AUDIT_APPROVED]: ["auditApprovedBy", "auditApprovedAt"],
  [STATUS.ADMIN_APPROVED]: ["adminApprovedBy", "adminApprovedAt"],
  [STATUS.PAID]: ["paidBy", "paidAt"],
};

// ── Role sets ────────────────────────────────────────────────────────────────

/**
 * Sees everyone's spending rather than only their own. The Expenditure Officer
 * is here because verification is their job — they cannot verify a queue they
 * cannot see.
 */
const OVERSIGHT_ROLES = [ROLE.SUPER, ROLE.ADMIN, ROLE.CFO, ROLE.OFFICER];

/**
 * Who may read OTHER people's requests. Everyone else sees only what they
 * raised themselves, wherever they are in the app.
 *
 * Deliberately its own list rather than reusing OVERSIGHT_ROLES: that one
 * answers "may you act on the chain", and the two questions have different
 * answers. `audit` is here and is not an actor; `finance` is an actor and is
 * here only because it owns the CFO approval stage — a reviewer who cannot
 * see the queue cannot work it, so removing finance would silently empty
 * that stage rather than tighten anything.
 */
const ALL_EXPENSES_ROLES = [ROLE.SUPER, ROLE.ADMIN, "audit", ROLE.OFFICER, ROLE.CFO];

/** May action their own request. Without this a solo operator is stuck. */
const SELF_ACTION_ROLES = [ROLE.SUPER];

const rolesOf = (user) => {
  const list = Array.isArray(user?.roles) ? user.roles : [];
  return new Set([...list, user?.role].filter(Boolean));
};

const hasAny = (user, allowed) => {
  const mine = rolesOf(user);
  return allowed.some((r) => mine.has(r));
};

/**
 * May this person make this move on this expense?
 *
 * A super admin always may, and the admin and CFO stages work by role as they
 * always have. The expenditure officer's part — verifying, paying, and
 * rejecting or sending back as the officer — belongs to the officer NAMED for
 * the expense (lib/expenseOfficers.js: station and LPG plant expenses to one,
 * everything else to another; the owner's rule of 6 Oct 2026). Holding the
 * expenditure_officer role does not make anybody the officer of an expense
 * they are not named on, and the named officer needs no role to act.
 */
const mayMake = (user, transition, expense) => {
  if (hasAny(user, [ROLE.SUPER])) return true;
  if (hasAny(user, transition.roles.filter((r) => r !== ROLE.OFFICER))) return true;
  return transition.roles.includes(ROLE.OFFICER) && isOfficerOf(user, expense);
};

/** The officer's own steps: the expense waits on them to verify, or to pay. */
const OFFICER_STEPS = new Set(["verify", "mark_paid"]);

const canOversee = (user) => hasAny(user, OVERSIGHT_ROLES);
const canSelfAction = (user) => hasAny(user, SELF_ACTION_ROLES);
/** May read other people's requests — see ALL_EXPENSES_ROLES. */
const canSeeAllExpenses = (user) => hasAny(user, ALL_EXPENSES_ROLES);

/**
 * May read this request and take part in its conversation.
 *
 * Everyone in the chain, plus the person who raised it — they have to be able
 * to answer a query, which is the whole point of the thread. Deliberately not
 * "any authenticated member of staff": salaries and settlements go through
 * here.
 */
const canSeeExpense = (expense, user) => {
  if (canSeeAllExpenses(user)) return true;
  const submitterId = expense?.added_by ?? expense?.addedBy ?? expense?.recorded_by ?? expense?.recordedBy;
  return submitterId != null && Number(submitterId) === Number(user?.id);
};

/**
 * May this viewer edit the request itself — its amount, vendor, account,
 * invoice figures — as opposed to moving it along the chain.
 *
 * Two rules, in this order:
 *
 *   · A paid expense is closed to everyone EXCEPT a super admin. The money has
 *     left the bank, so the figures are a record of what happened rather than
 *     a proposal, and an ordinary edit would silently restate a settled
 *     payment. But records do need correcting — a wrong TIN, an invoice figure
 *     keyed a digit out, an expense booked to the wrong cargo — and the
 *     alternative to allowing it is someone editing the database by hand,
 *     which leaves no trail at all. So one role can, every change is diffed
 *     into the audit trail with `edited_by`, and everything the figure feeds
 *     recomputes from it (nothing downstream is stored — see lib/pfiFinance).
 *   · Otherwise anyone on the request may edit it: the officer who raised it
 *     and every role that has to sign it off. A reviewer who spots a wrong
 *     TIN should fix it rather than bounce the request back a stage and wait.
 *
 * Returns `{ ok }` or `{ ok: false, status, message }` so the caller can send
 * the right HTTP code and the exact reason. `postPayment` comes back true when
 * the edit is a super admin correcting a settled row, so the caller can mark
 * the audit entry as the amendment it is rather than an ordinary edit.
 *
 * The PATCH route had no check of its own at all before this: any
 * authenticated member of staff could rewrite any expense at any stage,
 * including a paid one.
 */
function canEditExpense(expense, user) {
  const status = expense?.status;

  if (status === STATUS.PAID) {
    if (!hasAny(user, [ROLE.SUPER])) {
      return {
        ok: false,
        status: 409,
        message: "This expense is paid and closed — only a super admin can amend a settled record.",
      };
    }
    return { ok: true, postPayment: true };
  }

  if (!canSeeExpense(expense, user)) {
    return {
      ok: false,
      status: 403,
      message: "Only the officer who raised this request, or someone in its approval chain, can edit it.",
    };
  }

  return { ok: true, postPayment: false };
}

/**
 * May this viewer record an expense that is ALREADY PAID, skipping the chain?
 *
 * Super admin alone. The four-stage chain exists so that no single person can
 * move company money on their own say-so, and this is a deliberate hole in it
 * — appropriate for the person who already holds every stage's role and could
 * walk a request through all four unaided anyway, and appropriate for nothing
 * else.
 *
 * It is for money that has already left the bank by some other route and is
 * being written down after the fact: a standing order, a cash payment made at
 * a depot, a historical cost being brought onto the books. Approving a payment
 * that has already happened is theatre, and forcing it produces a chain of
 * rubber-stamps that makes the real approvals harder to trust.
 *
 * What it skips is the CHAIN and the notifications. It does NOT skip the audit
 * row — see createExpense. Nobody asked for an untraceable expense, and one
 * entry saying who booked it, when, and that it bypassed approval is the thing
 * that makes the hole safe to leave open.
 */
const canRecordAsPaid = (user) => hasAny(user, [ROLE.SUPER]);

/**
 * What this viewer may do to this expense, and if nothing, why.
 *
 * The reason matters as much as the list: a row of no buttons with no
 * explanation reads as a broken page, when usually it just means somebody else
 * has to act next.
 */
function availableActions(expense, user) {
  const status = expense.status;

  if (status === STATUS.PAID) {
    return { actions: [], reason: "This expense is paid and closed." };
  }
  if (status === STATUS.REJECTED) {
    return { actions: [], reason: "This request was rejected. Edit it to resubmit." };
  }

  const submitterId = expense.addedBy ?? expense.recordedBy ?? null;
  const isSubmitter = submitterId != null && Number(submitterId) === Number(user?.id);
  if (isSubmitter && !canSelfAction(user)) {
    return { actions: [], reason: "You submitted this — someone else has to action it." };
  }

  const actions = Object.entries(TRANSITIONS)
    .filter(([, t]) => t.from.includes(status) && mayMake(user, t, expense))
    .map(([name]) => name);

  const officerStage = [STATUS.PENDING, STATUS.CHANGES_REQUESTED, STATUS.ADMIN_APPROVED].includes(status);
  if (actions.length === 0 && officerStage && !isOfficerOf(user, expense)) {
    return {
      actions: [],
      reason: isStationExpense(expense)
        ? "Station and LPG plant expenses are verified and paid by their own expenditure officer."
        : "This expense is verified and paid by its expenditure officer.",
    };
  }
  if (actions.length === 0) {
    return {
      actions: [],
      reason: `Your role cannot action a request at the '${STATUS_LABELS[status] || status}' stage.`,
    };
  }
  return { actions, reason: "" };
}

/**
 * Validate a requested transition.
 *
 * Returns `{ ok: true, transition }` or `{ ok: false, status, message, currentStatus }`.
 * The order of checks is deliberate — each yields a different HTTP status and
 * the specific one has to win.
 */
function checkTransition(expense, action, user, note) {
  const transition = TRANSITIONS[action];
  if (!transition) {
    return { ok: false, status: 400, message: `Unknown action '${action}'` };
  }
  if (!mayMake(user, transition, expense)) {
    return {
      ok: false,
      status: 403,
      message: OFFICER_STEPS.has(action) || (transition.roles.includes(ROLE.OFFICER) && hasAny(user, [ROLE.OFFICER]))
        ? `Only this expense's expenditure officer can ${transition.label.toLowerCase()} it`
        : `Your role cannot ${transition.label.toLowerCase()} an expense`,
    };
  }

  const submitterId = expense.addedBy ?? expense.recordedBy ?? null;
  const isSubmitter = submitterId != null && Number(submitterId) === Number(user?.id);
  if (isSubmitter && !canSelfAction(user)) {
    return { ok: false, status: 403, message: "You raised this request — someone else has to action it" };
  }

  // 409, not 400: two people acting from stale screens is the normal case, and
  // returning the current status lets the client refresh straight from the error.
  if (!transition.from.includes(expense.status)) {
    return {
      ok: false,
      status: 409,
      message: `Cannot ${transition.label.toLowerCase()} a request that is '${STATUS_LABELS[expense.status] || expense.status}'`,
      currentStatus: expense.status,
    };
  }

  if (transition.requiresNote && !String(note || "").trim()) {
    return { ok: false, status: 400, message: `A reason is required to ${transition.label.toLowerCase()}` };
  }

  return { ok: true, transition };
}

module.exports = {
  ROLE,
  STATUS,
  OPEN_STATES,
  STATUS_LABELS,
  STATUS_STEP,
  TOTAL_STEPS,
  TRANSITIONS,
  STAGE_STAMPS,
  OVERSIGHT_ROLES,
  ALL_EXPENSES_ROLES,
  canOversee,
  canSelfAction,
  canSeeAllExpenses,
  canSeeExpense,
  canEditExpense,
  canRecordAsPaid,
  availableActions,
  checkTransition,
  rolesOf,
};
