const { and, eq, inArray, notInArray, count, or, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { orders, orderTrucks, pfiExpenses } = require("../db/schema");
const { outstandingTrucks } = require("./truckProgress.service");

/**
 * How much work is waiting, per desk.
 *
 * One query set feeding two things: the number badges in the sidebar, and the
 * "what is waiting on me" landing page. They are the same question asked twice,
 * so they are answered once — a badge that disagrees with the page it links to
 * is worse than no badge.
 *
 * Every queue is keyed by the NAV PATH it belongs to. The sidebar is then a
 * dumb lookup (`counts[item.path]`) and adding a queue is a change in one
 * place rather than a change here plus a mapping table over there.
 *
 * ── Scoped to the person, and not a permission gate ────────────────────────
 *
 * A badge answers "how much is waiting on ME". Somebody who runs Calabar
 * wants Calabar's two pending tickets, not the company's two thousand — a
 * number they cannot act on is a number they learn to ignore, and once they
 * ignore it the badge is worse than absent.
 *
 * This deliberately does NOT go through lib/scopeFilter. That helper is the
 * authorisation gate, and it was switched off at the owner's instruction in
 * 76d3e95 — every signed-in member of staff may do everything, and that
 * stands. Nothing here stops anyone opening any page or acting on any row.
 * It narrows what gets COUNTED for them, which is a view preference.
 *
 * A user with no depots and no PFIs assigned is not narrowed to nothing: they
 * see the company's queues. Failing closed here would hand somebody an empty
 * dashboard and no clue why, which is the exact defect 76d3e95 records.
 */

/**
 * Build a WHERE from conditions, dropping the empty ones.
 *
 * `scopeCondition` returns NULL for a full-access user, and Drizzle's `and()`
 * strips `undefined` but NOT `null` — a null is bound as a parameter, so
 * `and(a, b, null)` compiles to `a AND b AND $3` with $3 = NULL, and the whole
 * predicate evaluates to NULL. Every count silently came back 0.
 *
 * The rest of this codebase avoids it by pushing into a conditions array and
 * only pushing the scope `if (scope)`. This is that, as a one-liner.
 */
const where = (...conditions) => and(...conditions.filter(Boolean));

/**
 * The rows this person's badges should count.
 *
 * Depots OR PFIs — somebody can hold both, and either should let a row
 * through. Null when they hold neither, which means "count everything": see
 * the note above on why this must not fail closed.
 */
const mine = (user, { depotColumn, pfiColumn } = {}) => {
  const { depotIds = [], pfiIds = [] } = user?.scope || {};
  const clauses = [];
  if (depotColumn && depotIds.length) clauses.push(inArray(depotColumn, depotIds));
  if (pfiColumn && pfiIds.length) clauses.push(inArray(pfiColumn, pfiIds));
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
};

/**
 * Work on a closed batch is not work.
 *
 * A finished PFI has been closed out: its orders are history, and an order
 * sitting at Paid on a batch closed months ago is nobody's queue. Counting
 * them put 2,562 orders behind the ticketing badge against a real queue of
 * 124 — a four-figure number that never went down, which is how a badge stops
 * being read.
 *
 * NOT EXISTS rather than a join, so an order with no PFI at all still counts:
 * it is not on a closed batch, it is on no batch, and that is somebody's work
 * either way.
 */
const notOnClosedPfi = (pfiColumn) => sql`NOT EXISTS (
  SELECT 1 FROM pfis p WHERE p.id = ${pfiColumn} AND p.status = 'finished'
)`;

/**
 * A gantry lifting and a delivery batch have no loading desk and no gate.
 *
 * Nobody at this depot issues their tickets or admits their trucks, so an
 * order of theirs sitting in those queues is work that will never be done.
 * They complete on payment now (see completeDesklessOrder), which keeps new
 * ones out — this keeps the ones raised before that change out too, so the
 * badge is right today rather than after a backfill.
 */
const notDeskless = (pfiColumn) => sql`NOT EXISTS (
  SELECT 1 FROM pfis p WHERE p.id = ${pfiColumn} AND p.pfi_type IN ('gantry', 'delivery')
)`;

/** Orders that have taken money and are on their way — not finished, not dead. */
const AWAITING_TICKETING = ["Paid", "Released"];
/** Order lifecycle states where a payment can still be confirmed. */
const PAYABLE_STATUSES = ["Pending", "Paid", "Released", "Loading"];
/** An order whose trucks the gate should still expect to see. */
const GATE_LIVE_STATUSES = ["Released", "Loading"];
/** An order that is over — its trucks are history, not a queue. */
const ORDER_DEAD_STATUSES = ["Cancelled", "Expired"];

/**
 * The queues, declared once.
 *
 * `label` is what the landing page calls it — deliberately a sentence about
 * work ("Orders awaiting payment"), not a page name, because the page's job is
 * to tell somebody what to do next.
 *
 * `emptyLabel` is what it says when the count is zero, and it is not "0 orders
 * awaiting payment" — an empty queue is good news and should read as such.
 */
const QUEUES = [
  {
    key: "payableOrders",
    path: "/payable-orders",
    label: "Orders awaiting payment",
    emptyLabel: "No orders waiting on payment",
    action: "Confirm against the bank statement",
    count: (user) =>
      db
        .select({ n: count() })
        .from(orders)
        .where(
          where(
            inArray(orders.paymentStatus, ["Unpaid", "Part Paid"]),
            inArray(orders.status, PAYABLE_STATUSES),
            notOnClosedPfi(orders.pfiId),
            mine(user, { depotColumn: orders.depotId, pfiColumn: orders.pfiId }),
          ),
        ),
  },
  {
    key: "awaitingTicketing",
    path: "/ticket",
    label: "Orders awaiting loading tickets",
    emptyLabel: "Every paid order has been ticketed",
    action: "Generate tickets for the loading desk",
    /**
     * Counted in orders, and the truck figure carried beside it.
     *
     * The badge stays an order count because that is what the page it links to
     * lists, and a badge that disagrees with its page is worse than no badge.
     * But an order is not a unit of work — one might need six trucks and have
     * two — so `trucks` rides along and the landing page shows both. See
     * truckProgress.outstandingTrucks.
     */
    trucks: async () => {
      const t = await outstandingTrucks();
      return { toTicket: t.toTicket, undeclaredOrders: t.undeclared };
    },
    count: (user) =>
      db
        .select({ n: count() })
        .from(orders)
        .where(
          where(
            inArray(orders.status, AWAITING_TICKETING),
            notOnClosedPfi(orders.pfiId),
            notDeskless(orders.pfiId),
            mine(user, { depotColumn: orders.depotId, pfiColumn: orders.pfiId }),
          ),
        ),
  },
  {
    key: "awaitingGateIn",
    path: "/security/entry",
    label: "Trucks expected at the gate",
    emptyLabel: "No trucks expected at the gate",
    action: "Gate them in as they arrive",
    /**
     * Only trucks on a LIVE order. 5,236 truck rows sit at 'pending' against
     * orders that were cancelled, expired or long since completed — they are
     * never coming, and counting them would put a permanent four-figure badge
     * on a page whose real queue is a couple of hundred.
     */
    count: (user) =>
      db
        .select({ n: count() })
        .from(orderTrucks)
        .innerJoin(orders, eq(orders.id, orderTrucks.orderId))
        .where(
          where(
            eq(orderTrucks.status, "pending"),
            inArray(orders.status, GATE_LIVE_STATUSES),
            notOnClosedPfi(orders.pfiId),
            notDeskless(orders.pfiId),
            mine(user, { depotColumn: orders.depotId, pfiColumn: orders.pfiId }),
          ),
        ),
  },
  {
    key: "awaitingGateOut",
    path: "/security/exit",
    label: "Trucks on the yard",
    emptyLabel: "The yard is clear",
    action: "Clear them out once loaded",
    // Gated in or loaded: physically inside, and somebody has to let them
    // out. Excludes dead orders only — a truck on the yard is on the yard
    // whatever happened to the paperwork behind it.
    count: (user) =>
      db
        .select({ n: count() })
        .from(orderTrucks)
        .innerJoin(orders, eq(orders.id, orderTrucks.orderId))
        .where(
          where(
            inArray(orderTrucks.status, ["gated_in", "loaded"]),
            notInArray(orders.status, ORDER_DEAD_STATUSES),
            notOnClosedPfi(orders.pfiId),
            notDeskless(orders.pfiId),
            mine(user, { depotColumn: orders.depotId, pfiColumn: orders.pfiId }),
          ),
        ),
  },
  {
    key: "pendingExpenses",
    path: "/expenses",
    label: "Expenses awaiting approval",
    emptyLabel: "No expenses waiting on a decision",
    action: "Review and approve or decline",
    /**
     * Final approval genuinely rests with admin and super admin — nobody else
     * can clear this queue. It is therefore the one queue that is personally
     * theirs, and the landing page words it that way for them while wording
     * every other queue as something the business is waiting on rather than
     * something they are personally holding up.
     */
    approverRoles: [0, 1],
    count: (user) =>
      db
        .select({ n: count() })
        .from(pfiExpenses)
        .where(
          where(
            eq(pfiExpenses.status, "pending"),
            notOnClosedPfi(pfiExpenses.pfiId),
            mine(user, { pfiColumn: pfiExpenses.pfiId }),
          ),
        ),
  },
];

/**
 * Every queue's depth for this user.
 *
 * Runs the counts concurrently — three cheap COUNTs, and the sidebar asks for
 * them on every page load, so serialising them would put three round trips in
 * front of the nav rendering.
 *
 * A failing queue yields 0 rather than taking the whole response down with it:
 * this feeds decoration and a landing page, and a badge that cannot be
 * computed is a badge that should not appear, not a 500 on every screen.
 */
const getWorkQueues = async (user) => {
  const results = await Promise.all(
    QUEUES.map(async (q) => {
      try {
        const [row] = await q.count(user);
        // A queue may carry a second figure in a different unit — tickets are
        // counted in orders for the badge and in trucks for the person doing
        // the work. Best-effort: it decorates, it does not gate.
        let detail = null;
        if (q.trucks) {
          try { detail = await q.trucks(); } catch { detail = null; }
        }
        return { ...q, n: Number(row?.n ?? 0), detail };
      } catch (err) {
        console.error(`[work-queues] ${q.key} failed:`, err.message);
        return { ...q, n: 0, failed: true };
      }
    }),
  );

  /** Keyed by nav path, for the sidebar's lookup. Zero counts are omitted. */
  const counts = {};
  for (const q of results) {
    if (q.n > 0) counts[q.path] = q.n;
  }

  return {
    counts,
    queues: results.map(({ key, path, label, emptyLabel, action, approverRoles, n, detail, failed }) => ({
      key,
      path,
      label,
      emptyLabel,
      action,
      /** A second unit for the same queue, where one is meaningful. */
      detail: detail ?? null,
      /** Roles that personally clear this queue; absent where nobody owns it. */
      approverRoles: approverRoles ?? null,
      count: n,
      failed: Boolean(failed),
    })),
  };
};

module.exports = { getWorkQueues, QUEUES };
