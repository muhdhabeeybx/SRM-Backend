const { eq, and, desc, sql } = require("drizzle-orm");
const { db, client } = require("../db");
const { orders, orderPayments, orderRefunds, customers, bankAccounts } = require("../db/schema");
const { PAYMENT_SOURCE, CONFIRMATION_BASIS } = require("../db/schema/orderPayment");
const { recomputeOrder, httpError } = require("./orderPayment.service");
const auditLogRepo = require("../repositories/auditLog.repository");
const { DUPLICATE_LEGACY_IDS, DUPLICATE_LEGACY_IDS_SQL } = require("../repositories/cfoReport.repository");
const { orderReferenceClient } = require("../lib/orderReferenceSql");
const { pfiFilter } = require("../lib/pfiScope");

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
                      WHERE op.order_id = o.id AND op.id IN (${back})), 0) AS resurrected
      FROM orders o WHERE o.id = ${Number(orderId)}`);
  const rows = result.rows ?? result;
  if (!rows.length) throw httpError(404, "Order not found");
  const received = round2(rows[0].received);
  const total = round2(rows[0].total);
  return {
    total,
    received,
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
    SELECT o.id, ${orderReferenceClient(client, "o", "c")} AS reference,
           o.company_name, o.total_amount::numeric AS total,
           o.created_at, o.customer_id, c.name AS customer_name, c.phone AS customer_phone,
           c.company_name AS customer_company,
           COALESCE(p.received, 0) AS received, COALESCE(p.phantom, 0) AS phantom,
           COALESCE(p.resurrected, 0) AS resurrected,
           COALESCE(p.transferred_in, 0) AS transferred_in,
           COALESCE(p.transferred_out, 0) AS transferred_out,
           r.id AS open_refund_id, r.amount AS open_refund_amount, r.requested_at AS open_refund_at,
           sk.id AS skip_id, sk.amount AS skip_amount
      FROM orders o
      JOIN p ON p.order_id = o.id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_refunds r ON r.order_id = o.id AND r.status = 'requested'
      LEFT JOIN order_refunds sk ON sk.order_id = o.id AND sk.status = 'skipped'
     WHERE COALESCE(p.received, 0) > o.total_amount::numeric + 0.005
       -- Staff assigned to a PFI see only that PFI's orders. See lib/pfiScope.js.
       ${pfiFilter(scopeUser, "o.pfi_id")}
       /*
         An order set aside stays off the list only while the decision still
         describes it. If more money has landed since, the surplus no longer
         matches what somebody looked at and waived, so it comes back.
       */
       AND (sk.id IS NULL
            OR COALESCE(p.received, 0) - o.total_amount::numeric > sk.amount::numeric + 0.005)
       ${search ? client`AND (${orderReferenceClient(client, "o", "c")} ILIKE ${term}
                             OR o.order_number ILIKE ${term} OR c.name ILIKE ${term}
                             OR o.company_name ILIKE ${term} OR c.company_name ILIKE ${term})` : client``}
     ORDER BY (COALESCE(p.received, 0) - o.total_amount::numeric) DESC
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
    orderValue: round2(r.total),
    received: round2(r.received),
    surplus: round2(money(r.received) - money(r.total)),
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

/** Every refund, newest first, with who asked and who paid. */
const listRefunds = async ({ status = null, limit = 500, scopeUser = null } = {}) => {
  const rows = await client`
    SELECT r.*, ${orderReferenceClient(client, "o", "c")} AS reference,
           o.company_name, c.name AS customer_name, c.phone AS customer_phone,
           ba.bank_name AS paid_from_bank, ba.account_name AS paid_from_name, ba.account_number AS paid_from_number,
           TRIM(COALESCE(rq.first_name,'') || ' ' || COALESCE(rq.surname,'')) AS requested_by_name,
           TRIM(COALESCE(pd.first_name,'') || ' ' || COALESCE(pd.surname,'')) AS paid_by_name,
           TRIM(COALESCE(cx.first_name,'') || ' ' || COALESCE(cx.surname,'')) AS cancelled_by_name
      FROM order_refunds r
      JOIN orders o ON o.id = r.order_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN bank_accounts ba ON ba.id = r.paid_from_account_id
      LEFT JOIN staff rq ON rq.id = r.requested_by
      LEFT JOIN staff pd ON pd.id = r.paid_by
      LEFT JOIN staff cx ON cx.id = r.cancelled_by
     WHERE true
     ${status ? client`AND r.status = ${status}` : client``}
     ${pfiFilter(scopeUser, "o.pfi_id")}
     ORDER BY COALESCE(r.paid_at, r.cancelled_at, r.requested_at) DESC, r.id DESC
     LIMIT ${Math.min(1000, Number(limit) || 500)}`;
  return rows.map((r) => ({
    id: Number(r.id),
    orderId: Number(r.order_id),
    orderNumber: r.reference,
    companyName: r.company_name,
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    amount: round2(r.amount),
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
  }));
};

/**
 * Raise a refund request. Changes nothing about the order.
 *
 * The amount defaults to the order's whole real surplus — "the overpaid
 * becomes 0" is the point of the process — and may be smaller, never larger.
 * One open request per order; the database enforces it too, so two people
 * raising one at once cannot both succeed.
 */
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
    return await db.transaction(async (tx) => {
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
      return refund;
    });
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
const markRefunded = async ({ refundId, paidFromAccountId, paymentReference = "", paidAt = null, staffId = null }) => {
  return db.transaction(async (tx) => {
    const [refund] = await tx.select().from(orderRefunds)
      .where(eq(orderRefunds.id, Number(refundId))).for("update").limit(1);
    if (!refund) throw httpError(404, "Refund not found");
    if (refund.status !== "requested") {
      throw httpError(409, refund.status === "refunded" ? "This refund is already marked paid." : "This refund was cancelled.");
    }

    const [account] = await tx.select().from(bankAccounts)
      .where(eq(bankAccounts.id, Number(paidFromAccountId))).limit(1);
    if (!account) throw httpError(400, "Choose the bank account the refund was paid from.");

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
  });
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
const cancelRefund = async ({ refundId, reason = "", staffId = null }) => {
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

    await auditLogRepo.record({
      entityType: "order", entityId: refund.orderId, action: "order.refund_undone",
      actor: actorFor(staffId),
      metadata: { refundId: refund.id, amount: refund.amount, wasPaidAt: refund.paidAt, paymentReference: refund.paymentReference, reason: why },
    }, tx);
    return { refund: updated, order: after };
  });
};

module.exports = {
  realSurplus,
  listRefundable,
  listRefunds,
  requestRefund,
  skipOrder,
  restoreSkipped,
  markRefunded,
  cancelRefund,
  undoRefund,
};
