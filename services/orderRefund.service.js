const { eq, and, desc, sql } = require("drizzle-orm");
const { db, client } = require("../db");
const { orders, orderPayments, orderRefunds, customers, bankAccounts } = require("../db/schema");
const { PAYMENT_SOURCE, CONFIRMATION_BASIS } = require("../db/schema/orderPayment");
const { recomputeOrder, httpError } = require("./orderPayment.service");
const auditLogRepo = require("../repositories/auditLog.repository");
const { DUPLICATE_LEGACY_IDS, DUPLICATE_LEGACY_IDS_SQL } = require("../repositories/cfoReport.repository");
const { orderReferenceClient } = require("../lib/orderReferenceSql");
const { generateOrderReference } = require("../utils/helpers");

/**
 * Which refunds a person may see — the rule every list in the app follows
 * (lib/scopeFilter.js scopeCondition), applied through the order:
 *
 *   assigned PFIs   only those PFIs' orders — a PFI assignment is the whole answer
 *   else depots     only orders placed at their depots
 *   else            everything (unrestricted, or nothing assigned)
 *
 * This used to be PFI-only (lib/pfiScope pfiFilter), so staff scoped by depot
 * saw every customer's refund and bank details in the company.
 */
const idsOf = (list) => (list || []).map(Number).filter(Number.isFinite);
const scopeFilter = (user, alias = "o") => {
  if (!user || user.canViewAllLocations) return client``;
  const pfiIds = idsOf(user.scope?.pfiIds);
  if (pfiIds.length) return client`AND ${client.unsafe(alias)}.pfi_id = ANY(${pfiIds}::int[])`;
  const depotIds = idsOf(user.scope?.depotIds);
  if (depotIds.length) return client`AND ${client.unsafe(alias)}.depot_id = ANY(${depotIds}::int[])`;
  return client``;
};

/** An order outside the person's scope reads as not found, as it does on every list. */
const assertOrderInScope = async (user, orderId) => {
  const [row] = await client`SELECT o.id FROM orders o WHERE o.id = ${Number(orderId)} ${scopeFilter(user, "o")}`;
  if (!row) throw httpError(404, "Order not found");
};

/**
 * Payments a person deleted that the 0021 backfill put back.
 *
 * Every section of that migration treats "no such row" as "never recorded",
 * and scripts/apply-unjournaled-migrations.js re-runs every hand-written file
 * on every run — so a payment somebody removed was re-created the next time
 * migrations were applied. 0021 now refuses to do that, but the rows it
 * already re-created are still here, and they are not money we hold.
 *
 * Order 11332 is the case that exposed it: four bank payments totalling
 * exactly its ₦62,400,000 value, plus a resurrected wallet-era duplicate for
 * the whole ₦62,400,000 again — a fully settled order reporting an
 * overpayment of its entire value, twice deleted and twice back.
 *
 * ── Why the rule is this narrow ───────────────────────────────────────────
 *
 * Only rows the BACKFILL wrote (its note names the migration) that came into
 * existence AFTER a person removed the same amount from that order — the id
 * ordering is what says "after". Matching on the amount alone would catch the
 * genuine bank payments too: on order 11293 the real statement rows carry the
 * same ₦36,360,000 and ₦18,180,000 as the duplicates beside them, and are
 * only told apart by which came first.
 *
 * ── Why they are excluded rather than deleted ─────────────────────────────
 *
 * The finance report is audited and reads this table. Deleting rows would move
 * figures that were signed off; leaving them and refusing to count them as
 * refundable moves nothing except the question this page answers — what do we
 * owe a customer back. The rows stay, visible, for somebody to settle
 * deliberately.
 */
const RESURRECTED_PAYMENT_IDS_SQL = `
  SELECT p.id
    FROM order_payments p
   WHERE p.note LIKE '%migration 0021%'
     AND EXISTS (
       SELECT 1 FROM audit_logs al
        WHERE al.entity_type = 'order'
          AND al.action = 'order.payment_removed'
          AND al.entity_id = p.order_id
          AND al.metadata->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$'
          AND al.metadata->>'paymentId' ~ '^[0-9]+$'
          AND (al.metadata->>'amount')::numeric = p.amount
          AND (al.metadata->>'paymentId')::int < p.id
     )
`;
const RESURRECTED_PAYMENT_IDS = client.unsafe(RESURRECTED_PAYMENT_IDS_SQL);

/**
 * Overpayment goes back to the customer.
 *
 * This replaces moving surplus between orders, which is switched off at the
 * API (the 72 transfers already made stay as they are and can still be
 * reviewed or reversed). A refund is two steps, and they are two different
 * facts:
 *
 *   requested  someone has decided this money goes back, to this account.
 *              NOTHING about the order changes — its surplus still shows,
 *              because the money is still with us.
 *   refunded   the money has actually been sent. Only now is a negative
 *              `refund` payment row written, and the order's surplus falls to
 *              zero through the same SUM that produced it.
 *
 * A request that cleared the balance before the money left would report a
 * customer as settled while they are still owed. That is the one mistake this
 * process must not be able to make.
 *
 * ── Refunding real money only ───────────────────────────────────────────────
 *
 * The book reports ₦1.41bn of overpayment across 178 orders. ₦213.8m of that
 * is not money at all: it is the duplicate `legacy` rows migration 0021 gave
 * orders that received a transfer — the same money counted twice. Refunding
 * the raw surplus would pay real cash back against a bookkeeping artefact.
 * Every amount here is computed with those rows read past, by the same rule
 * the CFO report uses (DUPLICATE_LEGACY_IDS). The rows themselves stay — the
 * finance report is audited against them.
 */

const money = (v) => Number(v || 0);
const round2 = (v) => Math.round(money(v) * 100) / 100;
const actorFor = (staffId) => (staffId ? { type: "staff", staffId } : { type: "system" });

/**
 * What an order genuinely holds beyond its value, right now.
 *
 * Received excludes the 0021 duplicates — see the header. Read with the raw
 * client so it can share the duplicate rule verbatim, and inside the caller's
 * transaction where there is one, so a check and the write that follows it
 * see the same book.
 */
/**
 * Surplus this order handed to another order before transfers had payment
 * rows — the wallet era, recorded only as a deposit described "… from order
 * #1234" and allocated to the receiving order.
 *
 * The giving order kept its payment rows, so on them alone it still reads as
 * overpaid by exactly what it gave away. The finance report reconstructs these
 * as transfer_out legs (findFinanceReport); the refund desk did not, and on
 * 2026-09-29 offered to refund ₦95,861,399 across 23 orders that had already
 * passed that money on — every one of them square once the move is counted.
 *
 * Counted per deposit, not per allocation row, so a deposit split across two
 * orders is not taken off twice. Taken off whether or not it lands the order
 * exactly on its value: for a refund, money that left is money not to send.
 */
const WALLET_MOVED_OUT_SQL = (orderIdExpr) => `COALESCE((
  SELECT SUM(dp.amount::numeric) FROM deposits dp
   WHERE dp.description ~ 'from order #[0-9]+'
     AND (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int = ${orderIdExpr}
     AND EXISTS (SELECT 1 FROM order_deposit_allocations a WHERE a.deposit_id = dp.id)
), 0)`;

const realSurplus = async (orderId, trx = db) => {
  /*
   * Through the caller's transaction, deliberately. markRefunded locks the
   * order and then asks this how much it holds; a read on a separate
   * connection would sit outside that lock and could miss a payment being
   * removed at the same moment — and a refund computed against a stale figure
   * leaves the order short by money that has already left.
   */
  const dup = sql.raw(DUPLICATE_LEGACY_IDS_SQL);
  const back = sql.raw(RESURRECTED_PAYMENT_IDS_SQL);
  const result = await trx.execute(sql`
    SELECT o.total_amount::numeric AS total,
           COALESCE((SELECT SUM(op.amount) FROM order_payments op
                      WHERE op.order_id = o.id
                        AND op.id NOT IN (${dup}) AND op.id NOT IN (${back})), 0) AS received,
           COALESCE((SELECT SUM(op.amount) FROM order_payments op
                      WHERE op.order_id = o.id AND op.id IN (${dup})), 0) AS phantom,
           COALESCE((SELECT SUM(op.amount) FROM order_payments op
                      WHERE op.order_id = o.id AND op.id IN (${back})), 0) AS resurrected,
           ${sql.raw(WALLET_MOVED_OUT_SQL("o.id"))} AS moved_out
      FROM orders o WHERE o.id = ${Number(orderId)}`);
  const rows = result.rows ?? result;
  if (!rows.length) throw httpError(404, "Order not found");
  const movedOut = round2(rows[0].moved_out);
  // What the order holds once surplus handed to another order in the wallet
  // era is taken off — see WALLET_MOVED_OUT_SQL.
  const received = round2(rows[0].received - movedOut);
  const total = round2(rows[0].total);
  return {
    total,
    received,
    movedOut,
    phantom: round2(rows[0].phantom),
    /** Deleted by a person, re-created by the backfill — not money we hold. */
    resurrected: round2(rows[0].resurrected),
    surplus: Math.max(0, round2(received - total)),
  };
};

/**
 * Orders that genuinely hold money beyond their value, with any open request.
 *
 * Only real surplus — an order whose whole "overpayment" is a 0021 duplicate
 * does not appear, and one partly inflated shows the true figure with the
 * phantom part stated beside it, so nobody wonders why it is smaller than the
 * finance report's.
 */
const listRefundable = async ({ search = "", limit = 500, scopeUser = null } = {}) => {
  const term = `%${String(search || "").trim()}%`;
  const rows = await client`
    WITH p AS (
      SELECT order_id,
             SUM(amount) FILTER (
               WHERE id NOT IN (${DUPLICATE_LEGACY_IDS})
                 AND id NOT IN (${RESURRECTED_PAYMENT_IDS})
             ) AS received,
             SUM(amount) FILTER (WHERE id IN (${RESURRECTED_PAYMENT_IDS})) AS resurrected,
             SUM(amount) FILTER (WHERE id IN (${DUPLICATE_LEGACY_IDS}))     AS phantom,
             -- Money that reached this order by being moved off another one,
             -- back when surplus was transferred rather than refunded. It is
             -- often the whole reason the order is on this list, and it reads
             -- very differently from a customer having paid twice.
             SUM(amount) FILTER (WHERE source = 'transfer_in')  AS transferred_in,
             SUM(ABS(amount)) FILTER (WHERE source = 'transfer_out') AS transferred_out
        FROM order_payments GROUP BY order_id
    )
    /*
      Wallet-era moves, read ONCE and joined — see WALLET_MOVED_OUT_SQL for why
      they count. Computed per order as a correlated subquery this scanned the
      deposits table with a regex for every order that has a payment, and the
      list took 31 seconds; the page timed out and showed no orders at all.
    */
    , moved_deposits AS (
      SELECT dp.id, dp.amount::numeric AS amount,
             (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int AS from_order_id
        FROM deposits dp
       WHERE dp.description ~ 'from order #[0-9]+'
         AND EXISTS (SELECT 1 FROM order_deposit_allocations a WHERE a.deposit_id = dp.id)
    )
    , mv AS (
      SELECT from_order_id AS order_id, SUM(amount) AS moved_out
        FROM moved_deposits GROUP BY from_order_id
    )
    , mv_to AS (
      SELECT md.from_order_id AS order_id,
             json_agg(DISTINCT jsonb_build_object('id', o2.id, 'company', COALESCE(NULLIF(o2.company_name, ''), c2.company_name, ''))) AS moved_to
        FROM moved_deposits md
        JOIN order_deposit_allocations a ON a.deposit_id = md.id
        JOIN orders o2 ON o2.id = a.order_id
        LEFT JOIN customers c2 ON c2.id = o2.customer_id
       GROUP BY md.from_order_id
    )
    SELECT o.id, ${orderReferenceClient(client, "o", "c")} AS reference,
           COALESCE(mv.moved_out, 0) AS moved_out,
           mv_to.moved_to,
           o.company_name, o.total_amount::numeric AS total,
           o.created_at, o.customer_id, c.name AS customer_name, c.phone AS customer_phone,
           c.company_name AS customer_company,
           COALESCE(p.received, 0) AS received, COALESCE(p.phantom, 0) AS phantom,
           COALESCE(p.resurrected, 0) AS resurrected,
           COALESCE(p.transferred_in, 0) AS transferred_in,
           COALESCE(p.transferred_out, 0) AS transferred_out,
           r.id AS open_refund_id, r.amount AS open_refund_amount, r.requested_at AS open_refund_at,
           sk.id AS skip_id, sk.amount AS skip_amount,
           o.pfi_id, pf.pfi_number, d.name AS depot_name
      FROM orders o
      JOIN p ON p.order_id = o.id
      LEFT JOIN mv ON mv.order_id = o.id
      LEFT JOIN mv_to ON mv_to.order_id = o.id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN pfis pf ON pf.id = o.pfi_id
      LEFT JOIN depots d ON d.id = o.depot_id
      LEFT JOIN order_refunds r ON r.order_id = o.id AND r.status = 'requested'
      LEFT JOIN order_refunds sk ON sk.order_id = o.id AND sk.status = 'skipped'
     WHERE COALESCE(p.received, 0) - COALESCE(mv.moved_out, 0) > o.total_amount::numeric + 0.005
       -- Only orders inside the reader's scope — see scopeFilter above.
       ${scopeFilter(scopeUser, "o")}
       /*
         An order set aside stays off the list only while the decision still
         describes it. If more money has landed since, the surplus no longer
         matches what somebody looked at and waived, so it comes back.
       */
       AND (sk.id IS NULL
            OR COALESCE(p.received, 0) - COALESCE(mv.moved_out, 0) - o.total_amount::numeric > sk.amount::numeric + 0.005)
       ${search ? client`AND (${orderReferenceClient(client, "o", "c")} ILIKE ${term}
                             OR o.order_number ILIKE ${term} OR c.name ILIKE ${term}
                             OR o.company_name ILIKE ${term} OR c.company_name ILIKE ${term})` : client``}
     ORDER BY (COALESCE(p.received, 0) - COALESCE(mv.moved_out, 0) - o.total_amount::numeric) DESC
     LIMIT ${Math.min(1000, Number(limit) || 500)}`;
  return rows.map((r) => ({
    orderId: Number(r.id),
    // The reference every other screen shows — "HA10831", not the internal
    // ORD-BB464940706C, which names an order nobody can look up.
    orderNumber: r.reference,
    companyName: r.company_name || r.customer_company || "",
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    pfiId: r.pfi_id == null ? null : Number(r.pfi_id),
    pfiNumber: r.pfi_number || null,
    depotName: r.depot_name || null,
    orderValue: round2(r.total),
    received: round2(r.received),
    /** Surplus handed to another order in the wallet era, already taken off `surplus`. */
    movedOutEarlier: round2(r.moved_out),
    movedOutTo: (r.moved_to || []).map((m) => generateOrderReference(m.company, m.id)),
    surplus: round2(money(r.received) - money(r.moved_out) - money(r.total)),
    phantomExcluded: round2(r.phantom),
    resurrectedExcluded: round2(r.resurrected),
    createdAt: r.created_at,
    transferredIn: round2(r.transferred_in),
    transferredOut: round2(r.transferred_out),
    openRefund: r.open_refund_id
      ? { id: Number(r.open_refund_id), amount: round2(r.open_refund_amount), requestedAt: r.open_refund_at }
      : null,
    /** Set aside earlier for less than it now holds — so it is back. */
    previouslySkipped: r.skip_id
      ? { id: Number(r.skip_id), amount: round2(r.skip_amount) }
      : null,
  }));
};

/**
 * Every refund, newest first, with who asked, who paid, and which PFI it is on.
 *
 * `from`/`to` are Lagos calendar days and match the refund's latest event —
 * paid, cancelled, or asked for — the same date the list is ordered by.
 * `search` matches the order, the customer and the account the money goes to,
 * which is how somebody holding a bank alert finds the refund it belongs to.
 */
const REFUND_SELECT = (scopeUser, where) => client`
    SELECT r.*, ${orderReferenceClient(client, "o", "c")} AS reference,
           o.company_name, c.name AS customer_name, c.phone AS customer_phone,
           o.pfi_id, pf.pfi_number, d.name AS depot_name, o.total_amount::numeric AS order_total,
           o.created_at AS order_date,
           /* What the order holds beyond its value NOW — the same figure the
              pay step checks. A request larger than this cannot be paid: the
              order's payments changed after it was raised. */
           (COALESCE((SELECT SUM(op.amount) FROM order_payments op
                       WHERE op.order_id = o.id
                         AND op.id NOT IN (${DUPLICATE_LEGACY_IDS})
                         AND op.id NOT IN (${RESURRECTED_PAYMENT_IDS})), 0)
             - ${client.unsafe(WALLET_MOVED_OUT_SQL("o.id"))}
             - o.total_amount::numeric) AS current_surplus,
           ba.bank_name AS paid_from_bank, ba.account_name AS paid_from_name, ba.account_number AS paid_from_number,
           TRIM(COALESCE(rq.first_name,'') || ' ' || COALESCE(rq.surname,'')) AS requested_by_name,
           TRIM(COALESCE(pd.first_name,'') || ' ' || COALESCE(pd.surname,'')) AS paid_by_name,
           TRIM(COALESCE(cx.first_name,'') || ' ' || COALESCE(cx.surname,'')) AS cancelled_by_name,
           ex.status::text AS expense_status, ex.reference_number AS expense_reference
      FROM order_refunds r
      JOIN orders o ON o.id = r.order_id
      LEFT JOIN pfi_expenses ex ON ex.id = r.expense_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN bank_accounts ba ON ba.id = r.paid_from_account_id
      LEFT JOIN staff rq ON rq.id = r.requested_by
      LEFT JOIN staff pd ON pd.id = r.paid_by
      LEFT JOIN staff cx ON cx.id = r.cancelled_by
      LEFT JOIN pfis pf ON pf.id = o.pfi_id
      LEFT JOIN depots d ON d.id = o.depot_id
     WHERE true
     ${scopeFilter(scopeUser, "o")}
     ${where}`;

/**
 * Cancel open refund requests the order can no longer cover — automatically,
 * with the reason on record.
 *
 * Called at the end of every payment write (orderPayment.service
 * recomputeOrder), so the moment a wrong match is removed or surplus moves on,
 * a request for money the order no longer holds stops sitting on the refunds
 * page as though somebody were owed it. SE11866 did exactly that: ₦60,750,000
 * requested on 21 Sep, the wrong ₦250,950,000 match removed on 22 Sep, and the
 * request still read "awaiting payment" a week later over an order holding ₦0.
 *
 * Only a request larger than what is left is cancelled; one still covered is
 * left alone. A request being paid right now — its refund payment row already
 * written, markRefunded's own recompute — is never touched.
 *
 * @returns {Promise<number[]>} the refund ids it cancelled
 */
async function closeUncoveredRequests(orderId, tx) {
  const open = await tx
    .select({ id: orderRefunds.id, amount: orderRefunds.amount, expenseId: orderRefunds.expenseId })
    .from(orderRefunds)
    .where(and(
      eq(orderRefunds.orderId, Number(orderId)),
      eq(orderRefunds.status, "requested"),
      sql`NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.refund_id = ${orderRefunds.id})`,
    ));
  if (!open.length) return [];
  const { surplus } = await realSurplus(orderId, tx);
  const closed = [];
  for (const r of open) {
    if (Number(r.amount) <= surplus + 0.005) continue;
    const why = surplus > 0.005
      ? `Cancelled automatically: the order now holds ₦${surplus.toLocaleString("en-NG")} beyond its value, less than the ₦${Number(r.amount).toLocaleString("en-NG")} requested — its payments changed. Raise a new request for what is still owed.`
      : "Cancelled automatically: the order no longer holds an overpayment — its payments changed after this was requested.";
    await tx.update(orderRefunds).set({
      status: "cancelled", cancelledAt: new Date(), cancelledBy: null, cancelReason: why, updatedAt: new Date(),
    }).where(eq(orderRefunds.id, r.id));
    await withdrawRefundExpense(tx, r.expenseId, why);
    await auditLogRepo.record({
      entityType: "order", entityId: Number(orderId), action: "order.refund_cancelled",
      actor: { type: "system" },
      metadata: { refundId: r.id, amount: r.amount, reason: why, automatic: true, surplusNow: surplus },
    }, tx);
    closed.push(r.id);
  }
  // After this transaction commits, not inside it, so a rolled-back payment
  // write never tells anybody their refund was cancelled.
  if (closed.length) setTimeout(() => closed.forEach((id) => announceRefund(id, "cancelled")), 1500);
  return closed;
}

const lagosDayStart = (day) => client`(${day}::date::timestamp AT TIME ZONE 'Africa/Lagos')`;

const listRefunds = async ({
  status = null, pfiId = null, from = null, to = null, search = "", limit = 500, scopeUser = null,
} = {}) => {
  const term = `%${String(search || "").trim()}%`;
  const at = client`COALESCE(r.paid_at, r.cancelled_at, r.requested_at)`;
  const rows = await client`
    ${REFUND_SELECT(scopeUser, client`
     ${status ? client`AND r.status = ${status}` : client``}
     ${pfiId ? client`AND o.pfi_id = ${Number(pfiId)}` : client``}
     ${from ? client`AND ${at} >= ${lagosDayStart(from)}` : client``}
     ${to ? client`AND ${at} < ${lagosDayStart(to)} + interval '1 day'` : client``}
     ${String(search || "").trim() ? client`AND (
          ${orderReferenceClient(client, "o", "c")} ILIKE ${term} OR o.order_number ILIKE ${term}
          OR c.name ILIKE ${term} OR o.company_name ILIKE ${term} OR c.phone ILIKE ${term}
          OR r.destination_name ILIKE ${term} OR r.destination_number ILIKE ${term}
          OR r.destination_bank ILIKE ${term} OR r.payment_reference ILIKE ${term})` : client``}`)}
     ORDER BY ${at} DESC, r.id DESC
     LIMIT ${Math.min(1000, Number(limit) || 500)}`;
  return rows.map(shapeRefund);
};

/** One refund in full, and every step it went through, from the audit log. */
const getRefund = async ({ refundId, scopeUser = null }) => {
  const [row] = await REFUND_SELECT(scopeUser, client`AND r.id = ${Number(refundId)}`);
  if (!row) throw httpError(404, "Refund not found");
  const history = await client`
    SELECT a.action, a.created_at, a.metadata,
           TRIM(COALESCE(s.first_name, '') || ' ' || COALESCE(s.surname, '')) AS actor_name
      FROM audit_logs a
      LEFT JOIN staff s ON s.id = a.actor_staff_id
     WHERE a.entity_type = 'order'
       AND a.entity_id = ${Number(row.order_id)}
       AND a.action LIKE 'order.refund_%'
       AND a.metadata->>'refundId' = ${String(row.id)}
     ORDER BY a.created_at, a.id`;
  return {
    ...shapeRefund(row),
    history: history.map((h) => ({
      action: h.action.replace(/^order\.refund_/, ""),
      at: h.created_at,
      by: h.actor_name || null,
      reason: h.metadata?.reason || "",
      amount: h.metadata?.amount != null ? round2(h.metadata.amount) : null,
      paymentReference: h.metadata?.paymentReference || "",
    })),
  };
};

const shapeRefund = (r) => ({
    id: Number(r.id),
    orderId: Number(r.order_id),
    orderNumber: r.reference,
    companyName: r.company_name,
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    pfiId: r.pfi_id == null ? null : Number(r.pfi_id),
    pfiNumber: r.pfi_number || null,
    depotName: r.depot_name || null,
    amount: round2(r.amount),
    orderTotal: round2(r.order_total),
    /** When the order was placed — the refund desk's one table is dated by it. */
    orderDate: r.order_date,
    /** What the order holds now, net of refunds paid and money moved on. */
    orderReceived: round2(Number(r.order_total) + Number(r.current_surplus)),
    /** What the order holds beyond its value now (never below 0). */
    currentSurplus: Math.max(0, round2(r.current_surplus)),
    /**
     * An open request the order can no longer cover — its payments changed
     * after it was raised (a wrong match removed, surplus moved on). The pay
     * step refuses it; the page says so instead of offering to pay it.
     */
    stale: r.status === "requested" && round2(r.current_surplus) + 0.005 < round2(r.amount),
    status: r.status,
    destinationBank: r.destination_bank,
    destinationName: r.destination_name,
    destinationNumber: r.destination_number,
    reason: r.reason,
    requestedAt: r.requested_at,
    requestedByName: r.requested_by_name || null,
    paidAt: r.paid_at,
    paidByName: r.paid_by_name || null,
    paymentReference: r.payment_reference,
    paidFrom: r.paid_from_account_id
      ? { id: Number(r.paid_from_account_id), bankName: r.paid_from_bank, accountName: r.paid_from_name, accountNumber: r.paid_from_number }
      : null,
    cancelledAt: r.cancelled_at,
    cancelledByName: r.cancelled_by_name || null,
    cancelReason: r.cancel_reason,
    /**
     * The expense that pays it (migration 0065) and where it stands in the
     * chain. Null on refunds raised before refunds went through expenses —
     * those are still paid from the refund desk.
     */
    expense: r.expense_id
      ? {
          id: Number(r.expense_id),
          reference: r.expense_reference || null,
          status: r.expense_status || null,
          stageLabel: require("../lib/expenseChain").STATUS_LABELS[r.expense_status] || r.expense_status || null,
        }
      : null,
});

/**
 * Raise a refund request. Changes nothing about the order.
 *
 * The amount defaults to the order's whole real surplus — "the overpaid
 * becomes 0" is the point of the process — and may be smaller, never larger.
 * One open request per order; the database enforces it too, so two people
 * raising one at once cannot both succeed.
 */
/**
 * Tell the people a refund concerns. Never throws: the refund is already saved,
 * and a notice that cannot be sent must not turn it into a failed request.
 *
 *   requested   finance on the order's PFI/depot — there is money to send
 *   paid        whoever asked for it
 *   cancelled   whoever asked for it, with the reason (automatic ones too)
 */
async function announceRefund(refundId, event) {
  try {
    const { notify } = require("../notifications");
    const { rolesFor } = require("../notifications/staffChoices");
    const [r] = await client`
      SELECT r.id, r.order_id, r.amount, r.status, r.requested_by, r.destination_name, r.destination_bank,
             r.destination_number, r.payment_reference, r.cancel_reason,
             ${orderReferenceClient(client, "o", "c")} AS reference, c.name AS customer_name,
             TRIM(COALESCE(rq.first_name,'') || ' ' || COALESCE(rq.surname,'')) AS requested_by_name,
             TRIM(COALESCE(pd.first_name,'') || ' ' || COALESCE(pd.surname,'')) AS paid_by_name,
             TRIM(COALESCE(cx.first_name,'') || ' ' || COALESCE(cx.surname,'')) AS cancelled_by_name
        FROM order_refunds r
        JOIN orders o ON o.id = r.order_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN staff rq ON rq.id = r.requested_by
        LEFT JOIN staff pd ON pd.id = r.paid_by
        LEFT JOIN staff cx ON cx.id = r.cancelled_by
       WHERE r.id = ${Number(refundId)}`;
    if (!r) return;
    // Only what actually stuck: a cancel inside a payment write that rolled
    // back leaves the refund requested, and nobody is told otherwise.
    const expected = { requested: "requested", paid: "refunded", cancelled: "cancelled" }[event];
    if (r.status !== expected) return;
    const base = {
      refundId: Number(r.id), orderId: Number(r.order_id), orderNumber: r.reference,
      customerName: r.customer_name || "", amount: Number(r.amount),
    };
    if (event === "requested") {
      notify("staff.refund_requested", {
        to: { roles: rolesFor("refunds_to_pay") },
        data: {
          ...base,
          destinationName: r.destination_name, destinationBank: r.destination_bank,
          destinationNumber: r.destination_number, requestedByName: r.requested_by_name || "",
        },
      });
    } else if (r.requested_by) {
      notify("staff.refund_decided", {
        to: { staffId: Number(r.requested_by) },
        data: {
          ...base,
          outcome: event,
          reason: event === "cancelled" ? r.cancel_reason || "" : "",
          paymentReference: event === "paid" ? r.payment_reference || "" : "",
          actorName: event === "paid" ? r.paid_by_name || "" : r.cancelled_by_name || "",
        },
      });
    }
  } catch (err) {
    console.error(`[refunds] could not announce refund ${refundId} ${event}:`, err.message);
  }
}

// ── Refunds paid through the expense chain (migration 0065) ────────────────
//
// Requesting a refund raises an expense for it, at "With CFO" — refunds skip
// the Expenditure Officer's verification, and walk the rest of the ordinary
// chain: CFO approval, final approval, the Expenditure Officer marking it paid.
// Marking it paid is what records the refund on the order. The two records are
// kept in step here: a rejected expense cancels the refund, a cancelled refund
// withdraws the expense, and one is never paid without the other.

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/** The category refunds are raised under — flagged is_refund, never a cost. */
async function refundCategoryId(tx) {
  const [row] = rowsOf(await tx.execute(sql`SELECT id FROM expense_categories WHERE is_refund ORDER BY id LIMIT 1`));
  if (!row) throw httpError(500, "The Customer Refund expense category is missing — migration 0065 has not been applied.");
  return Number(row.id);
}

const staffName = async (tx, staffId) => {
  if (!staffId) return "";
  const [row] = rowsOf(await tx.execute(sql`
    SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(surname,'')) AS name FROM staff WHERE id = ${Number(staffId)}`));
  return row?.name || "";
};

/** One line on the expense's own trail, in the shape the expense pages read. */
const expenseAudit = (tx, expenseId, action, changes, actorId, actorName) => tx.execute(sql`
  INSERT INTO pfi_expense_audits (expense_id, action, changes, actor_id, actor_name)
  VALUES (${Number(expenseId)}, ${action}, ${JSON.stringify(changes)}, ${actorId ?? null}, ${actorName || ""})`);

/**
 * The expense that pays a refund, raised with it in the same transaction.
 *
 * Booked to the order's PFI, so it is found under that PFI on the expenses
 * page. It is never that PFI's cost: its category is flagged is_refund, and
 * every PFI cost total leaves such expenses out (pfiExpense.repository
 * aggregatesFor, pfiDailyReport). The customer's account is the payee.
 */
async function raiseRefundExpense(tx, { refund, order, staffId }) {
  const [info] = rowsOf(await tx.execute(sql`
    SELECT o.pfi_id, p.pfi_number, c.name AS customer_name,
           COALESCE(NULLIF(o.company_name, ''), c.company_name, '') AS company
      FROM orders o LEFT JOIN pfis p ON p.id = o.pfi_id LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${order.id}`));
  const name = await staffName(tx, staffId);
  const reference = generateOrderReference(info?.company || "", order.id);
  const description = [
    `Overpayment refund — ${reference}${info?.pfi_number ? ` (${info.pfi_number})` : ""}`,
    info?.customer_name ? `to ${info.customer_name}` : "",
    refund.reason ? `· ${refund.reason}` : "",
  ].filter(Boolean).join(" ");
  const [expense] = rowsOf(await tx.execute(sql`
    INSERT INTO pfi_expenses
      (category_id, pfi_id, vendor, description, amount, currency, exchange_rate,
       payee_bank_name, payee_account_number, payee_account_name,
       status, added_by, recorded_by, entered_by)
    VALUES
      (${await refundCategoryId(tx)}, ${info?.pfi_id ?? null}, ${refund.destinationName}, ${description.slice(0, 2000)},
       ${refund.amount}, 'NGN', 1,
       ${refund.destinationBank}, ${refund.destinationNumber}, ${refund.destinationName},
       'verified', ${staffId ?? null}, ${staffId ?? null}, ${name})
    RETURNING *`));
  await expenseAudit(tx, expense.id, "verified", {
    status: [null, "verified"],
    note: "Overpayment refund — goes straight to the CFO",
    refundId: refund.id,
    orderId: order.id,
  }, staffId, name);
  await tx.update(orderRefunds).set({ expenseId: expense.id, updatedAt: new Date() })
    .where(eq(orderRefunds.id, refund.id));
  return { expense, actorName: name };
}

/**
 * Take a refund's expense out of the chain — the refund was cancelled.
 * Rejected rather than deleted, so its trail says what happened. A paid
 * expense is never touched: a paid refund is undone, not cancelled.
 */
async function withdrawRefundExpense(tx, expenseId, reason, actorId = null) {
  if (!expenseId) return null;
  const [row] = rowsOf(await tx.execute(sql`
    UPDATE pfi_expenses
       SET status = 'rejected', review_note = ${reason.slice(0, 2000)}, reviewed_by = ${actorId ?? null},
           reviewed_at = now(), updated_at = now()
     WHERE id = ${Number(expenseId)} AND status NOT IN ('paid', 'rejected') AND deleted_at IS NULL
     RETURNING id, status`));
  if (row) {
    await expenseAudit(tx, expenseId, "rejected", { status: ["open", "rejected"], note: reason, refundCancelled: true },
      actorId, actorId ? await staffName(tx, actorId) : "System");
  }
  return row || null;
}

/**
 * The company account a payment left, from the "Bank · 0123456789" label the
 * expense's Mark paid form writes. The refund row on the order needs the
 * account itself, not its label.
 */
async function accountFromLabel(tx, label) {
  const text = String(label || "");
  const rows = rowsOf(await tx.execute(sql`
    SELECT id, bank_name, account_name, account_number FROM bank_accounts
     WHERE account_number <> '' AND position(account_number IN ${text}) > 0
     ORDER BY length(account_number) DESC LIMIT 1`));
  if (!rows[0]) throw httpError(400, "Choose one of the company's bank accounts as the account this refund was paid from.");
  return { id: Number(rows[0].id), bankName: rows[0].bank_name, accountName: rows[0].account_name, accountNumber: rows[0].account_number };
}

/**
 * Give an open refund raised before migration 0065 its expense, at "With
 * CFO", exactly as a new request would get one — and tell the CFO desk the
 * way a new request does. The requester is the expense's raiser.
 *
 * Refused for a request its order no longer covers: an expense for money that
 * is not owed would walk the whole chain only to be refused at payment.
 */
const raiseExpenseForOpenRefund = async (refundId) => {
  const created = await db.transaction(async (tx) => {
    const [refund] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.id, Number(refundId))).for("update").limit(1);
    if (!refund) throw httpError(404, "Refund not found");
    if (refund.status !== "requested") throw httpError(409, "Only an open request gets an expense.");
    if (refund.expenseId) throw httpError(409, "This refund already has its expense.");
    const [order] = await tx.select({ id: orders.id, customerId: orders.customerId, orderNumber: orders.orderNumber })
      .from(orders).where(eq(orders.id, refund.orderId)).limit(1);
    const { surplus } = await realSurplus(order.id, tx);
    if (round2(refund.amount) > surplus + 0.005) {
      throw httpError(409, `The order now holds ₦${surplus.toLocaleString("en-NG")} beyond its value, less than the ₦${Number(refund.amount).toLocaleString("en-NG")} requested — cancel this request rather than send it for approval.`);
    }
    const raised = await raiseRefundExpense(tx, { refund, order, staffId: refund.requestedBy });
    return { refund, ...raised };
  });
  const { notifyExpenseStage } = require("./expenseNotifications.service");
  await notifyExpenseStage({
    expense: created.expense, stage: "verified",
    note: "Overpayment refund — goes straight to the CFO",
    actorId: created.refund.requestedBy, actorName: created.actorName,
  }).catch((err) => console.error("[refunds] CFO notice failed:", err.message));
  return created.expense;
};

/** The refund an expense pays, if it pays one. */
const refundForExpense = async (expenseId) => {
  const [row] = await db.select().from(orderRefunds).where(eq(orderRefunds.expenseId, Number(expenseId))).limit(1);
  return row || null;
};

const requestRefund = async ({
  orderId, amount = null, destinationBank, destinationName, destinationNumber, reason = "", staffId = null,
}) => {
  const bank = String(destinationBank || "").trim();
  const name = String(destinationName || "").trim();
  const number = String(destinationNumber || "").trim();
  if (!bank || !name || !number) {
    throw httpError(400, "The customer's bank, account name and account number are all needed — they are what the person making the payment works from.");
  }

  const [order] = await db
    .select({ id: orders.id, customerId: orders.customerId, orderNumber: orders.orderNumber })
    .from(orders).where(eq(orders.id, Number(orderId))).limit(1);
  if (!order) throw httpError(404, "Order not found");

  const { surplus, phantom } = await realSurplus(order.id);
  if (!(surplus > 0)) {
    throw httpError(
      409,
      phantom > 0
        ? `${order.orderNumber} shows an overpayment only because of a duplicated legacy payment record (₦${phantom.toLocaleString("en-NG")}) — that money was never received twice, so there is nothing to refund.`
        : `${order.orderNumber} holds no overpayment to refund.`,
    );
  }

  const value = amount == null ? surplus : round2(amount);
  if (!(value > 0)) throw httpError(400, "A refund must be more than ₦0.");
  if (value > surplus + 0.005) {
    throw httpError(400, `${order.orderNumber} holds ₦${surplus.toLocaleString("en-NG")} beyond its value. A refund cannot be larger than that.`);
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [refund] = await tx
        .insert(orderRefunds)
        .values({
          orderId: order.id,
          customerId: order.customerId,
          amount: value.toFixed(2),
          status: "requested",
          destinationBank: bank,
          destinationName: name,
          destinationNumber: number,
          reason: String(reason || "").slice(0, 2000),
          requestedBy: staffId,
        })
        .returning();
      await auditLogRepo.record(
        {
          entityType: "order",
          entityId: order.id,
          action: "order.refund_requested",
          actor: actorFor(staffId),
          metadata: { refundId: refund.id, amount: refund.amount, destination: { bank, name, number }, reason },
        },
        tx,
      );
      const raised = await raiseRefundExpense(tx, { refund, order, staffId });
      return { refund: { ...refund, expenseId: raised.expense.id }, ...raised };
    });
    // The CFO desk hears about it the way it hears about every expense at its
    // stage — the refund desk's own "refund to pay" notice would only repeat it.
    try {
      const { notifyExpenseStage } = require("./expenseNotifications.service");
      notifyExpenseStage({
        expense: created.expense, stage: "verified",
        note: "Overpayment refund — goes straight to the CFO",
        actorId: staffId, actorName: created.actorName,
      }).catch(() => {});
    } catch (err) {
      console.error("[refunds] could not notify the CFO desk:", err.message);
    }
    return created.refund;
  } catch (e) {
    if (String(e?.cause?.code || e?.code) === "23505") {
      throw httpError(409, `${order.orderNumber} already has a refund waiting to be paid. Pay or cancel that one first.`);
    }
    throw e;
  }
};

/**
 * The money has gone. Record it, and clear the overpayment.
 *
 * The surplus is re-read inside the transaction, with the order locked: it can
 * have changed since the request — a payment removed, a transfer reversed —
 * and paying out more than the order holds would leave it short by money that
 * has already left. That is refused, and the desk re-raises at the new figure.
 */
const markRefunded = async (args) => {
  const result = await markRefundedTx(args);
  announceRefund(result.refund.id, "paid");
  return result;
};

const markRefundedTx = async ({ refundId, paidFromAccountId, paymentReference = "", paidAt = null, staffId = null }) => {
  return db.transaction(async (tx) => {
    const [refund] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.id, Number(refundId))).for("update").limit(1);
    if (!refund) throw httpError(404, "Refund not found");
    if (refund.status !== "requested") {
      throw httpError(409, refund.status === "refunded" ? "This refund is already marked paid." : "This refund was cancelled.");
    }
    // Paid through its expense, and only there: two ways to pay one refund is
    // one way to pay it twice.
    if (refund.expenseId) {
      throw httpError(409, "This refund is paid through Expenses — the Expenditure Officer marks its expense paid once it is approved.");
    }

    const [account] = await tx.select().from(bankAccounts)
      .where(eq(bankAccounts.id, Number(paidFromAccountId))).limit(1);
    if (!account) throw httpError(400, "Choose the bank account the refund was paid from.");

    return recordRefundPayment(tx, refund, { account, paymentReference, paidAt, staffId });
  });
};

/**
 * The money has left: the refund row on the order, the recompute, the refund
 * marked paid. Shared by the refund desk (older refunds) and the expense chain.
 * The surplus is re-read with the order locked — see markRefunded.
 */
async function recordRefundPayment(tx, refund, { account, paymentReference = "", paidAt = null, staffId = null }) {
    const [order] = await tx.select({ id: orders.id, orderNumber: orders.orderNumber })
      .from(orders).where(eq(orders.id, refund.orderId)).for("update").limit(1);

    const { surplus } = await realSurplus(refund.orderId, tx);
    const value = round2(refund.amount);
    if (value > surplus + 0.005) {
      throw httpError(
        409,
        `${order.orderNumber} now holds ₦${surplus.toLocaleString("en-NG")} beyond its value, less than the ₦${value.toLocaleString("en-NG")} requested — its payments changed after the request. Cancel this request and raise it again at the current figure.`,
      );
    }

    const when = paidAt ? new Date(paidAt) : new Date();
    const [payment] = await tx.insert(orderPayments).values({
      orderId: refund.orderId,
      amount: (-value).toFixed(2),
      source: PAYMENT_SOURCE.REFUND,
      refundId: refund.id,
      bankAccountId: account.id,
      // The bank date is the day it left, which is when the CFO report counts
      // it against the PFI's inflow.
      txnDate: when,
      depositor: refund.destinationName,
      narration: `Refund to ${refund.destinationName} · ${refund.destinationBank} ${refund.destinationNumber}`,
      bankRef: String(paymentReference || "").trim(),
      bankName: account.bankName,
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      confirmationBasis: CONFIRMATION_BASIS.REFUND_DESK,
      recordedBy: staffId,
      note: refund.reason || "",
    }).returning();

    const after = await recomputeOrder(refund.orderId, tx);

    const [updated] = await tx.update(orderRefunds).set({
      status: "refunded",
      paidFromAccountId: account.id,
      paymentReference: String(paymentReference || "").trim(),
      paidAt: when,
      paidBy: staffId,
      updatedAt: new Date(),
    }).where(eq(orderRefunds.id, refund.id)).returning();

    await auditLogRepo.record({
      entityType: "order",
      entityId: refund.orderId,
      action: "order.refund_paid",
      actor: actorFor(staffId),
      metadata: { refundId: refund.id, paymentId: payment.id, amount: refund.amount, paidFromAccountId: account.id, paymentReference },
    }, tx);

    return { refund: updated, payment, order: after };
}

/**
 * The Expenditure Officer marks a refund's expense paid.
 *
 * One transaction for both records: the refund on the order and the expense
 * marked paid either both happen or neither does. The order's surplus is
 * re-checked first (recordRefundPayment) — a request its order no longer
 * covers is refused here rather than paid.
 *
 * A refund is paid in full. The expense chain lets an ordinary payment settle
 * for less than was approved, with a reason; a refund of part of what was
 * requested would leave the rest looking owed and paid at once.
 */
const payRefundExpense = async ({ expenseId, payment, note = "", actorId = null, actorName = "" }) => {
  const result = await db.transaction(async (tx) => {
    const [refund] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.expenseId, Number(expenseId))).for("update").limit(1);
    if (!refund) throw httpError(404, "No refund is paid by this expense.");
    if (refund.status !== "requested") {
      throw httpError(409, refund.status === "refunded" ? "This refund is already paid." : "This refund was cancelled, so its expense cannot be paid.");
    }
    if (Math.abs(Number(payment.amount_paid) - Number(refund.amount)) > 0.005) {
      throw httpError(400, `A refund is paid in full: ₦${Number(refund.amount).toLocaleString("en-NG")} was approved.`);
    }
    const account = await accountFromLabel(tx, payment.bank_paid_from);
    const paid = await recordRefundPayment(tx, refund, {
      account, paymentReference: payment.payment_reference, paidAt: payment.payment_date, staffId: actorId,
    });
    const [expense] = rowsOf(await tx.execute(sql`
      UPDATE pfi_expenses
         SET status = 'paid', reviewed_by = ${actorId}, reviewed_at = now(), review_note = ${note || ""},
             paid_by = ${actorId}, paid_at = now(), updated_at = now(),
             bank_paid_from = ${payment.bank_paid_from}, amount_paid = ${payment.amount_paid},
             payment_reference = ${payment.payment_reference || ""}, payment_date = ${payment.payment_date},
             payment_method = ${payment.payment_method || ""}, payment_notes = ${payment.payment_notes || ""}
       WHERE id = ${Number(expenseId)} AND status = 'admin_approved' AND deleted_at IS NULL
       RETURNING *`));
    if (!expense) throw httpError(409, "This expense is not approved for payment yet.");
    await expenseAudit(tx, expenseId, "paid", {
      status: ["admin_approved", "paid"], note,
      amount_requested: refund.amount, amount_paid: payment.amount_paid,
      bank_paid_from: payment.bank_paid_from, payment_date: payment.payment_date,
      ...(payment.payment_reference ? { payment_reference: payment.payment_reference } : {}),
      refundId: refund.id, orderId: refund.orderId,
    }, actorId, actorName);
    return { expense, refund: paid.refund, payment: paid.payment, order: paid.order };
  });
  announceRefund(result.refund.id, "paid");
  return result;
};

/**
 * The refund's expense was rejected: the refund is cancelled with the same
 * reason. Nothing about the order moves.
 */
const cancelForRejectedExpense = async ({ expenseId, note = "", actorId = null }) => {
  const refund = await refundForExpense(expenseId);
  if (!refund || refund.status !== "requested") return null;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(orderRefunds).set({
      status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId,
      cancelReason: `Expense rejected: ${note}`.slice(0, 2000), updatedAt: new Date(),
    }).where(and(eq(orderRefunds.id, refund.id), eq(orderRefunds.status, "requested"))).returning();
    if (row) {
      await auditLogRepo.record({
        entityType: "order", entityId: refund.orderId, action: "order.refund_cancelled",
        actor: actorFor(actorId), metadata: { refundId: refund.id, amount: refund.amount, reason: row.cancelReason, expenseId },
      }, tx);
    }
    return row;
  });
  if (updated) announceRefund(updated.id, "cancelled");
  return updated;
};

/**
 * Set an overpayment aside: it will not be refunded, and here is why.
 *
 * For the two kinds of row that otherwise sit on this list for ever — sums too
 * small to be worth a bank transfer, and surplus already settled some other
 * way, usually by moving it to another order back when that was the process.
 *
 * ── What it does and does not do ──────────────────────────────────────────
 *
 * Nothing about the order changes. The money is still there, the order still
 * shows it, every report still counts it. This records a decision not to act,
 * not a correction of the books — waiving a debt is not the same as the debt
 * not existing, and the finance report must keep saying so.
 *
 * The surplus at this moment is stored as the amount. If more money arrives
 * later, the order comes back onto the list, because the decision was taken
 * about a smaller sum than it now holds.
 */
const skipOrder = async ({ orderId, reason = "", staffId = null }) => {
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "Say why this overpayment is not being refunded — the note is the whole point of setting it aside.");

  const [order] = await db
    .select({ id: orders.id, customerId: orders.customerId, orderNumber: orders.orderNumber })
    .from(orders).where(eq(orders.id, Number(orderId))).limit(1);
  if (!order) throw httpError(404, "Order not found");

  const { surplus } = await realSurplus(order.id);
  if (!(surplus > 0)) throw httpError(409, "This order holds no overpayment, so there is nothing to set aside.");

  try {
    return await db.transaction(async (tx) => {
      const [skip] = await tx.insert(orderRefunds).values({
        orderId: order.id,
        customerId: order.customerId,
        amount: surplus.toFixed(2),
        status: "skipped",
        reason: why.slice(0, 2000),
        requestedBy: staffId,
      }).returning();
      await auditLogRepo.record({
        entityType: "order", entityId: order.id, action: "order.refund_skipped",
        actor: actorFor(staffId), metadata: { refundId: skip.id, amount: skip.amount, reason: why },
      }, tx);
      return skip;
    });
  } catch (e) {
    if (String(e?.cause?.code || e?.code) === "23505") {
      throw httpError(409, "This overpayment is already set aside.");
    }
    throw e;
  }
};

/**
 * Put a set-aside overpayment back on the list.
 *
 * The skip is cancelled rather than deleted: somebody decided not to refund
 * this money and somebody decided to look at it again, and both belong on the
 * record. A new skip can then be raised — the unique index only counts live
 * ones.
 */
const restoreSkipped = async ({ refundId, reason = "", staffId = null }) => {
  return db.transaction(async (tx) => {
    const [skip] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.id, Number(refundId))).for("update").limit(1);
    if (!skip) throw httpError(404, "Not found");
    if (skip.status !== "skipped") throw httpError(409, "This is not a set-aside overpayment.");

    const [updated] = await tx.update(orderRefunds).set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: staffId,
      cancelReason: String(reason || "Put back on the refund list").slice(0, 2000),
      updatedAt: new Date(),
    }).where(eq(orderRefunds.id, skip.id)).returning();

    await auditLogRepo.record({
      entityType: "order", entityId: skip.orderId, action: "order.refund_skip_lifted",
      actor: actorFor(staffId), metadata: { refundId: skip.id, amount: skip.amount, reason },
    }, tx);
    return updated;
  });
};

/** Withdraw a request that has not been paid. Nothing about the order moves. */
const cancelRefund = async (args) => {
  const refund = await cancelRefundTx(args);
  announceRefund(refund.id, "cancelled");
  return refund;
};

const cancelRefundTx = async ({ refundId, reason = "", staffId = null }) => {
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "Say why the refund is being cancelled.");
  return db.transaction(async (tx) => {
    const [refund] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.id, Number(refundId))).for("update").limit(1);
    if (!refund) throw httpError(404, "Refund not found");
    if (refund.status !== "requested") {
      throw httpError(409, refund.status === "refunded"
        ? "This refund has been paid. Use Undo refund if it was marked paid by mistake."
        : "This refund is already cancelled.");
    }
    const [updated] = await tx.update(orderRefunds).set({
      status: "cancelled", cancelledAt: new Date(), cancelledBy: staffId, cancelReason: why.slice(0, 2000), updatedAt: new Date(),
    }).where(eq(orderRefunds.id, refund.id)).returning();
    await withdrawRefundExpense(tx, refund.expenseId, `Refund request cancelled: ${why}`, staffId);
    await auditLogRepo.record({
      entityType: "order", entityId: refund.orderId, action: "order.refund_cancelled",
      actor: actorFor(staffId), metadata: { refundId: refund.id, amount: refund.amount, reason: why },
    }, tx);
    return updated;
  });
};

/**
 * A refund marked paid by mistake goes back to requested.
 *
 * The payment row is removed and the order's overpayment reappears, because
 * the claim that the money left is being withdrawn. Needs a reason, and the
 * audit row keeps what was undone — a correction to a money record that
 * leaves no trace is worse than the mistake it corrects.
 */
const undoRefund = async ({ refundId, reason = "", staffId = null }) => {
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "Say why the refund is being undone.");
  return db.transaction(async (tx) => {
    const [refund] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.id, Number(refundId))).for("update").limit(1);
    if (!refund) throw httpError(404, "Refund not found");
    if (refund.status !== "refunded") throw httpError(409, "Only a refund marked paid can be undone.");

    await tx.delete(orderPayments).where(eq(orderPayments.refundId, refund.id));
    const after = await recomputeOrder(refund.orderId, tx);
    const [updated] = await tx.update(orderRefunds).set({
      status: "requested", paidAt: null, paidBy: null, paidFromAccountId: null, paymentReference: "", updatedAt: new Date(),
    }).where(eq(orderRefunds.id, refund.id)).returning();
    // Marked paid by mistake: its expense goes back to awaiting payment, so
    // the two still agree and it can be paid properly.
    if (refund.expenseId) {
      const [back] = rowsOf(await tx.execute(sql`
        UPDATE pfi_expenses SET status = 'admin_approved', paid_by = NULL, paid_at = NULL,
               review_note = ${`Refund undone: ${why}`.slice(0, 2000)}, reviewed_by = ${staffId ?? null},
               reviewed_at = now(), updated_at = now()
         WHERE id = ${Number(refund.expenseId)} AND status = 'paid' RETURNING id`));
      if (back) {
        await expenseAudit(tx, refund.expenseId, "admin_approved",
          { status: ["paid", "admin_approved"], note: `Refund undone: ${why}` }, staffId, await staffName(tx, staffId));
      }
    }

    await auditLogRepo.record({
      entityType: "order", entityId: refund.orderId, action: "order.refund_undone",
      actor: actorFor(staffId),
      metadata: { refundId: refund.id, amount: refund.amount, wasPaidAt: refund.paidAt, paymentReference: refund.paymentReference, reason: why },
    }, tx);
    return { refund: updated, order: after };
  });
};

module.exports = {
  raiseExpenseForOpenRefund,
  payRefundExpense,
  cancelForRejectedExpense,
  refundForExpense,
  closeUncoveredRequests,
  RESURRECTED_PAYMENT_IDS_SQL,
  realSurplus,
  listRefundable,
  listRefunds,
  getRefund,
  assertOrderInScope,
  requestRefund,
  skipOrder,
  restoreSkipped,
  markRefunded,
  cancelRefund,
  undoRefund,
};
