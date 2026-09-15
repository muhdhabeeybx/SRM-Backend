const { eq, and, sql, inArray, asc } = require("drizzle-orm");
const { db } = require("../config/db");
const { orderReferenceSql } = require("../lib/orderReferenceSql");
const {
  orders,
  orderPayments,
  orderPaymentTransfers,
  bankStatementLines,
  PAYMENT_SOURCE,
  CONFIRMATION_BASIS,
} = require("../db/schema");
const bankAccountRepo = require("../repositories/bankAccount.repository");
const auditLogRepo = require("../repositories/auditLog.repository");
// Required lazily inside the transfer path rather than at the top: orderStatus
// reaches the notification engine, which reads orders back through this module.
const orderStatus = () => require("./orderStatus.service");

/**
 * Money received against an ORDER, matched to a bank statement line.
 *
 * This is the whole payment path. There is no customer wallet in it: nothing
 * here reads or writes `customers.balance`, `deposits` or `wallet_holds`, and
 * no code path draws on a balance to cover a shortfall. An order is paid by
 * naming the bank rows that paid for it, or it is not paid.
 *
 * That is a deliberate reversal. The previous design credited a customer's
 * wallet from the statement and then debited the wallet for the order, which
 * meant the link between a bank row and an order was never recorded — only
 * inferred afterwards, oldest-credit-first, and printed on the finance report
 * as though it were fact. See db/migrations/0021.
 *
 * ── The invariant everything else rests on ─────────────────────────────────
 *
 *   orders.amount_paid = SUM(order_payments.amount) for that order
 *
 * maintained by recomputeOrder() inside the same transaction as every write.
 * `amount_paid` is a cache of the rows, never an independent figure, so the
 * finance report and the order screens cannot disagree.
 */

const money = (value) => Number(value || 0);
const asDecimal = (value) => money(value).toFixed(2);
const round2 = (value) => Math.round(money(value) * 100) / 100;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * The audit actor for a staff id that may not be there.
 *
 * `actorColumns` rejects a staff actor with no id outright, which is right —
 * an audit row naming a member of staff who cannot be identified is worse than
 * one that admits it was the system. Every entry point here takes staffId as
 * optional (a script, a migration repair, a test), so the distinction has to
 * be made once, here, rather than at each of the six call sites.
 */
const actorFor = (staffId) => (staffId ? { type: "staff", staffId } : { type: "system" });

/**
 * What an order has received, and how that sits against its value.
 *
 * `received` nets transfers: an order that gave its surplus away shows what it
 * kept, not what briefly passed through it.
 */
const summarize = (orderTotal, rows) => {
  const received = round2(rows.reduce((sum, r) => sum + money(r.amount), 0));
  const total = round2(orderTotal);
  return {
    received,
    orderTotal: total,
    /** What the order's value is actually settled by — never more than it. */
    applied: Math.min(received, total),
    /** Money on this order beyond its value. Stays here until moved. */
    surplus: Math.max(0, round2(received - total)),
    /** Money still owed. */
    shortfall: Math.max(0, round2(total - received)),
    /** No bank statement line behind any of it. */
    reconciled: rows.some((r) => r.source === PAYMENT_SOURCE.STATEMENT),
  };
};

/**
 * Re-derive the order's money columns from its payment rows.
 *
 * Called inside the transaction of every write that touches them, so the cache
 * can never be stale. Returns the summary so callers do not re-query.
 *
 * `paymentConfirmedAt` is stamped on the first payment and never moved by a
 * later one — the finance report's date filter runs on it, and an instalment
 * in September must not drag an order out of the August report it belongs to.
 * It is cleared only when the last payment is removed.
 */
const recomputeOrder = async (orderId, tx) => {
  const [order] = await tx
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      paymentStatus: orders.paymentStatus,
      paymentConfirmedAt: orders.paymentConfirmedAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update")
    .limit(1);
  if (!order) throw httpError(404, "Order not found");

  const rows = await tx
    .select({ amount: orderPayments.amount, source: orderPayments.source })
    .from(orderPayments)
    .where(eq(orderPayments.orderId, orderId));

  const s = summarize(order.totalAmount, rows);

  // Compared at kobo scale rather than with >=, so a total that does not
  // divide cleanly cannot leave an order a fraction of a kobo short of Paid
  // and stuck reporting a balance nobody can settle.
  const fullyPaid = Math.round(s.received * 100) >= Math.round(s.orderTotal * 100);
  const paymentStatus = s.received <= 0 ? "Unpaid" : fullyPaid ? "Paid" : "Part Paid";

  await tx
    .update(orders)
    .set({
      amountPaid: asDecimal(s.received),
      paymentStatus,
      paymentConfirmedAt:
        s.received <= 0 ? null : order.paymentConfirmedAt || new Date(),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, orderId));

  return { ...s, paymentStatus, wasFullyPaid: order.paymentStatus === "Paid" };
};

/**
 * Record payment on an order from bank statement lines.
 *
 * Each selected line becomes one payment row carrying that line's own details,
 * at the line's FACE value. Nothing is summed into a single row and nothing is
 * trimmed to fit the order: if a line is larger than what the order still
 * owes, the surplus lands on the order and shows there, which is what the desk
 * needs to see in order to move it somewhere sensible.
 *
 * The claim is a guarded UPDATE (`WHERE status = 'UNMATCHED'`), so two staff
 * racing for an overlapping set of lines cannot both win — the loser gets back
 * fewer claimed rows than asked for and the whole transaction rolls back
 * rather than half-recording a payment.
 *
 * Amounts are never taken from the client. Each comes from the claimed line.
 */
const recordFromStatementLines = async (
  { orderId, bankAccountId, lineIds, staffId = null, note = "" },
  tx,
) => {
  if (!Array.isArray(lineIds) || !lineIds.length) {
    throw httpError(400, "No statement lines were selected");
  }
  if (!bankAccountId) {
    throw httpError(400, "A bank account is required to claim statement lines");
  }

  const run = async (trx) => {
    const [order] = await trx
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) throw httpError(404, "Order not found");

    const bankAccount = await bankAccountRepo.findById(bankAccountId);

    const claimed = await trx
      .update(bankStatementLines)
      .set({
        status: "MATCHED",
        matchedBy: staffId,
        matchedAt: new Date(),
        // The line is claimed FOR this order, now. Under the old shape this
        // was stamped and then never read, which is how an order confirmed
        // against one specific credit came to be written up as slices of
        // three unrelated ones.
        matchedOrderId: orderId,
      })
      .where(
        and(
          inArray(bankStatementLines.id, lineIds.map(Number)),
          eq(bankStatementLines.bankAccountId, Number(bankAccountId)),
          eq(bankStatementLines.status, "UNMATCHED"),
        ),
      )
      .returning();

    // Throwing, not returning a failure: Drizzle would still commit the
    // transaction on a plain return, leaving whichever lines DID get claimed
    // stuck in MATCHED with no payment behind them.
    if (claimed.length !== lineIds.length) {
      throw httpError(
        409,
        "One or more of those lines were already matched to another order — refresh and try again.",
      );
    }

    const created = [];
    for (const line of claimed) {
      const [payment] = await trx
        .insert(orderPayments)
        .values({
          orderId,
          statementLineId: line.id,
          bankAccountId: Number(bankAccountId),
          amount: asDecimal(line.amount),
          source: PAYMENT_SOURCE.STATEMENT,
          // There is no other route to this code path: reaching it means a
          // person picked these lines for this order. See migration 0023.
          confirmationBasis: CONFIRMATION_BASIS.BANK_MATCHED,
          // The statement, verbatim. Copied rather than joined — see the
          // schema comment on this table for the three ways the join lied.
          txnDate: line.txnDate,
          depositor: line.depositor || "",
          narration: line.narration || "",
          bankRef: line.bankRef || "",
          bankName: bankAccount?.bankName || "",
          accountName: bankAccount?.accountName || "",
          accountNumber: bankAccount?.accountNumber || "",
          recordedBy: staffId,
          note,
        })
        .returning();
      created.push(payment);
    }

    const summary = await recomputeOrder(orderId, trx);

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.payment_recorded",
        actor: actorFor(staffId),
        metadata: {
          lineIds: claimed.map((l) => l.id),
          amount: asDecimal(claimed.reduce((sum, l) => sum + money(l.amount), 0)),
          received: asDecimal(summary.received),
          surplus: asDecimal(summary.surplus),
          paymentStatus: summary.paymentStatus,
        },
      },
      trx,
    );

    return { payments: created, summary };
  };

  return tx ? run(tx) : db.transaction(run);
};

/**
 * Take a payment back off an order and return its statement line to the pool.
 *
 * This is the correction path, and it exists because the previous design had
 * none: a MATCHED line could never be released, so a line matched to the wrong
 * order was wrong forever and the finance report named the wrong payment for
 * that order permanently.
 *
 * The row is deleted rather than reversed. A payment that was never made is
 * not a fact worth keeping, and the audit log records the removal with the
 * amount and the line — which is the trail an auditor actually follows. A
 * transfer leg cannot be removed this way; undo the transfer instead, so the
 * two legs can never come apart.
 */
const removePayment = async ({ paymentId, staffId = null, reason = "" }, tx) => {
  const run = async (trx) => {
    const [payment] = await trx
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.id, paymentId))
      .for("update")
      .limit(1);
    if (!payment) throw httpError(404, "Payment not found");

    if (payment.transferId) {
      throw httpError(
        400,
        "This is one leg of a transfer between orders. Reverse the transfer instead, so both legs move together.",
      );
    }

    await trx.delete(orderPayments).where(eq(orderPayments.id, paymentId));

    if (payment.statementLineId) {
      await trx
        .update(bankStatementLines)
        .set({
          status: "UNMATCHED",
          matchedOrderId: null,
          matchedDepositId: null,
          matchedBy: null,
          matchedAt: null,
        })
        .where(eq(bankStatementLines.id, payment.statementLineId));
    }

    const summary = await recomputeOrder(payment.orderId, trx);

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: payment.orderId,
        action: "order.payment_removed",
        actor: actorFor(staffId),
        metadata: {
          paymentId,
          amount: payment.amount,
          statementLineId: payment.statementLineId,
          bankRef: payment.bankRef,
          reason,
          paymentStatus: summary.paymentStatus,
        },
      },
      trx,
    );

    return { removed: payment, summary };
  };

  return tx ? run(tx) : db.transaction(run);
};

/**
 * Move surplus from one order to another.
 *
 * The one sanctioned way for money to move between orders, replacing a wallet
 * debit-plus-credit whose only record of the destination was a sentence typed
 * into a description field.
 *
 * Guarded on the SOURCE order's actual surplus, computed here under a row
 * lock: an order can only give away what it has over and above its own value.
 * Without that guard a transfer would quietly push the source order into
 * shortfall, which is how money "disappears" from a report.
 */
const transferSurplus = async (
  { fromOrderId, toOrderId, amount, reason = "", staffId = null },
  tx,
) => {
  const value = round2(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw httpError(400, "Transfer amount must be greater than zero");
  }
  if (Number(fromOrderId) === Number(toOrderId)) {
    throw httpError(400, "Cannot transfer an order's surplus to itself");
  }

  const run = async (trx) => {
    // Locked in id order, always. Two transfers running in opposite directions
    // between the same pair of orders would otherwise be able to deadlock.
    const ids = [Number(fromOrderId), Number(toOrderId)].sort((a, b) => a - b);
    const locked = await trx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        totalAmount: orders.totalAmount,
        // Read under the same lock as the money, so the release decision below
        // cannot act on a status another transaction has since moved.
        status: orders.status,
      })
      .from(orders)
      .where(inArray(orders.id, ids))
      .orderBy(asc(orders.id))
      .for("update");

    const from = locked.find((o) => o.id === Number(fromOrderId));
    const to = locked.find((o) => o.id === Number(toOrderId));
    if (!from) throw httpError(404, "The order the money is coming from was not found");
    if (!to) throw httpError(404, "The order the money is going to was not found");

    const fromRows = await trx
      .select({ amount: orderPayments.amount, source: orderPayments.source })
      .from(orderPayments)
      .where(eq(orderPayments.orderId, from.id));
    const fromSummary = summarize(from.totalAmount, fromRows);

    if (value > fromSummary.surplus + 0.001) {
      throw httpError(
        400,
        `${from.orderNumber} only has ₦${fromSummary.surplus.toLocaleString()} of surplus to move, and ₦${value.toLocaleString()} was asked for. An order cannot give away money it needs for its own value.`,
      );
    }

    const [transfer] = await trx
      .insert(orderPaymentTransfers)
      .values({
        fromOrderId: from.id,
        toOrderId: to.id,
        amount: asDecimal(value),
        reason,
        recordedBy: staffId,
      })
      .returning();

    // Both legs, from the transfer row itself, so a leg can never disagree
    // with the movement it belongs to.
    await trx.insert(orderPayments).values([
      {
        orderId: from.id,
        amount: asDecimal(-value),
        source: PAYMENT_SOURCE.TRANSFER_OUT,
        transferId: transfer.id,
        recordedBy: staffId,
        // A deliberate movement, as against the 17 that migration 0021
        // converted out of the old wallet draws — those are transfer_auto and
        // the report must not present the two as the same thing.
        confirmationBasis: CONFIRMATION_BASIS.TRANSFER_DESK,
        note: `Surplus moved to ${to.orderNumber}${reason ? ` — ${reason}` : ""}`,
      },
      {
        orderId: to.id,
        amount: asDecimal(value),
        source: PAYMENT_SOURCE.TRANSFER_IN,
        transferId: transfer.id,
        recordedBy: staffId,
        confirmationBasis: CONFIRMATION_BASIS.TRANSFER_DESK,
        note: `Surplus received from ${from.orderNumber}${reason ? ` — ${reason}` : ""}`,
      },
    ]);

    const fromAfter = await recomputeOrder(from.id, trx);
    const toAfter = await recomputeOrder(to.id, trx);

    /**
     * A transfer is money arriving, so it releases the receiving order exactly
     * as a bank payment would.
     *
     * Payment is the only condition for release in this business, and this is
     * one of the two ways an order gets funded — but it was the one that never
     * touched the state machine. An order paid entirely by transfer therefore
     * committed as Paid and sat at Pending forever, invisible to a ticketing
     * desk that only sees Released/Loading, with no screen able to move it:
     * Released is not reachable from Pending, so even the manual release button
     * returned 409.
     *
     * `isLegal` is the whole guard, as it is on the statement-line path in
     * order.service.js. It is only true from Pending, so a transfer onto an
     * already-released or delivered order moves money and nothing else, and a
     * second transfer cannot re-release.
     *
     * Part payments release too — capped at the quantity paid for, which
     * generate-tickets enforces — so this asks whether any money is now on the
     * order, not whether it is fully covered.
     *
     * The source order is deliberately NOT de-released. transferSurplus can
     * only move genuine surplus, so `from` never drops below its own value.
     */
    if (toAfter.received > 0 && orderStatus().isLegal(to.status, "Paid")) {
      const shared = { tx: trx, actor: actorFor(staffId), metadata: { via: "transfer", transferId: transfer.id } };
      await orderStatus().transition(to.id, "Paid", { ...shared, action: "order.paid", set: {} });
      await orderStatus().releaseOnPayment(to.id, shared);
    }

    for (const [orderId, summary, direction] of [
      [from.id, fromAfter, "out"],
      [to.id, toAfter, "in"],
    ]) {
      await auditLogRepo.record(
        {
          entityType: "order",
          entityId: orderId,
          action: "order.payment_transferred",
          actor: actorFor(staffId),
          metadata: {
            transferId: transfer.id,
            direction,
            amount: asDecimal(value),
            fromOrder: from.orderNumber,
            toOrder: to.orderNumber,
            reason,
            paymentStatus: summary.paymentStatus,
          },
        },
        trx,
      );
    }

    return { transfer, from: fromAfter, to: toAfter };
  };

  return tx ? run(tx) : db.transaction(run);
};

/**
 * Undo a transfer, both legs together.
 *
 * Refused if the destination order has since spent the money — i.e. giving it
 * back would push that order into shortfall. Saying so is better than silently
 * moving the problem to the other order.
 */
const reverseTransfer = async ({ transferId, staffId = null, reason = "" }, tx) => {
  const run = async (trx) => {
    const [transfer] = await trx
      .select()
      .from(orderPaymentTransfers)
      .where(eq(orderPaymentTransfers.id, transferId))
      .for("update")
      .limit(1);
    if (!transfer) throw httpError(404, "Transfer not found");

    const [to] = await trx
      .select({ id: orders.id, orderNumber: orders.orderNumber, totalAmount: orders.totalAmount })
      .from(orders)
      .where(eq(orders.id, transfer.toOrderId))
      .for("update")
      .limit(1);

    const toRows = await trx
      .select({ amount: orderPayments.amount, source: orderPayments.source })
      .from(orderPayments)
      .where(eq(orderPayments.orderId, transfer.toOrderId));
    const toSummary = summarize(to.totalAmount, toRows);
    const value = money(transfer.amount);

    if (toSummary.received - value < toSummary.orderTotal - 0.001) {
      throw httpError(
        400,
        `${to.orderNumber} is relying on this ₦${value.toLocaleString()} to cover its own value — taking it back would leave that order short. Record a payment against it first, or leave the transfer in place.`,
      );
    }

    await trx.delete(orderPayments).where(eq(orderPayments.transferId, transferId));
    await trx.delete(orderPaymentTransfers).where(eq(orderPaymentTransfers.id, transferId));

    const fromAfter = await recomputeOrder(transfer.fromOrderId, trx);
    const toAfter = await recomputeOrder(transfer.toOrderId, trx);

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: transfer.fromOrderId,
        action: "order.payment_transfer_reversed",
        actor: actorFor(staffId),
        metadata: {
          transferId,
          amount: transfer.amount,
          toOrderId: transfer.toOrderId,
          reason,
        },
      },
      trx,
    );

    return { from: fromAfter, to: toAfter };
  };

  return tx ? run(tx) : db.transaction(run);
};

/**
 * Take responsibility for an attribution the system made.
 *
 * Reversal was the first instinct and the data ruled it out: not one of the 17
 * auto-created transfers, and not one of the 8 orders carrying an inferred bank
 * line, can be undone without dropping an already-released, already-ticketed
 * order below its own value (scripts/review-system-attributions.js). The money
 * is where it needs to be; what was missing was anybody's name against the
 * decision.
 *
 * So this moves no money at all. It records that a person looked at a
 * system-made attribution and vouched for it, with their reason — turning an
 * anonymous row into an accountable one.
 *
 * `confirmationBasis` is deliberately left alone. It is the historical fact of
 * how the payment got here, and rewriting it on review would repeat exactly
 * what 0021 did: erase the software's fingerprints and leave a reader unable to
 * tell a decision somebody made from one they merely agreed with afterwards.
 */
const REVIEWABLE_BASES = new Set([
  "bank_inferred",
  "auto_allocated",
  "no_record",
  "transfer_auto",
  "unknown",
]);

const ratifyPayment = async ({ paymentId, staffId, note }, tx) => {
  const reason = String(note || "").trim();
  // The reason IS the deliverable. A sign-off with no reason recorded leaves
  // the row exactly as unaccountable as it was, with a name attached to
  // nothing — which is worse, because it looks resolved.
  if (!reason) throw httpError(400, "Say why this attribution is correct — the reason is the point");
  if (!staffId) throw httpError(400, "A member of staff must be identified to review a payment");

  const run = async (trx) => {
    const [payment] = await trx
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.id, paymentId))
      .for("update")
      .limit(1);
    if (!payment) throw httpError(404, "Payment not found");

    if (!REVIEWABLE_BASES.has(payment.confirmationBasis)) {
      throw httpError(
        400,
        "This payment was already a recorded staff decision — there is nothing to vouch for.",
      );
    }
    if (payment.transferId) {
      throw httpError(
        400,
        "This is one leg of a transfer. Review the transfer instead, so both legs are vouched for together.",
      );
    }
    if (payment.reviewedAt) {
      throw httpError(409, "This payment has already been reviewed");
    }

    const reviewedAt = new Date();
    await trx
      .update(orderPayments)
      .set({ reviewedBy: staffId, reviewedAt, reviewNote: reason, updatedAt: reviewedAt })
      .where(eq(orderPayments.id, paymentId));

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: payment.orderId,
        action: "order.payment_reviewed",
        actor: actorFor(staffId),
        metadata: {
          paymentId,
          amount: payment.amount,
          confirmationBasis: payment.confirmationBasis,
          statementLineId: payment.statementLineId,
          bankRef: payment.bankRef,
          reason,
        },
      },
      trx,
    );

    return { ...payment, reviewedBy: staffId, reviewedAt, reviewNote: reason };
  };

  return tx ? run(tx) : db.transaction(run);
};

/**
 * Vouch for a movement between orders — both legs at once.
 *
 * The transfer row carries the review, and the legs read it from there, so a
 * leg can never claim to be vouched for while its counterpart is not.
 */
const ratifyTransfer = async ({ transferId, staffId, note }, tx) => {
  const reason = String(note || "").trim();
  if (!reason) throw httpError(400, "Say why this movement was correct — the reason is the point");
  if (!staffId) throw httpError(400, "A member of staff must be identified to review a transfer");

  const run = async (trx) => {
    const [transfer] = await trx
      .select()
      .from(orderPaymentTransfers)
      .where(eq(orderPaymentTransfers.id, transferId))
      .for("update")
      .limit(1);
    if (!transfer) throw httpError(404, "Transfer not found");
    if (transfer.reviewedAt) throw httpError(409, "This transfer has already been reviewed");

    const reviewedAt = new Date();
    await trx
      .update(orderPaymentTransfers)
      .set({ reviewedBy: staffId, reviewedAt, reviewNote: reason })
      .where(eq(orderPaymentTransfers.id, transferId));

    // Stamped on the legs too, so a report reading payment rows alone — which
    // is what the finance report does — sees the review without a join.
    await trx
      .update(orderPayments)
      .set({ reviewedBy: staffId, reviewedAt, reviewNote: reason, updatedAt: reviewedAt })
      .where(eq(orderPayments.transferId, transferId));

    for (const orderId of [transfer.fromOrderId, transfer.toOrderId]) {
      await auditLogRepo.record(
        {
          entityType: "order",
          entityId: orderId,
          action: "order.payment_transfer_reviewed",
          actor: actorFor(staffId),
          metadata: {
            transferId,
            amount: transfer.amount,
            fromOrderId: transfer.fromOrderId,
            toOrderId: transfer.toOrderId,
            reason,
          },
        },
        trx,
      );
    }

    return { ...transfer, reviewedBy: staffId, reviewedAt, reviewNote: reason };
  };

  return tx ? run(tx) : db.transaction(run);
};

/**
 * What is left to review, by class.
 *
 * A finite, shrinking list — the point of the whole exercise is that it goes
 * to zero and stays there, because every new payment is a staff decision by
 * construction.
 */
const reviewQueue = async (tx = db) => {
  const rows = await tx.execute(sql`
    SELECT
      p.confirmation_basis AS "confirmationBasis",
      COUNT(*)::int        AS rows,
      COUNT(DISTINCT p.order_id)::int AS orders,
      COALESCE(SUM(p.amount), 0) AS naira
    FROM order_payments p
    WHERE p.reviewed_at IS NULL
      AND p.confirmation_basis IN ('bank_inferred', 'auto_allocated', 'no_record', 'transfer_auto', 'unknown')
    GROUP BY 1
    ORDER BY COUNT(*) DESC
  `);
  return rows.rows ?? rows;
};

/** Every payment row on an order, oldest first, with its transfer counterpart. */
const listForOrder = async (orderId, tx = db) => {
  const rows = await tx.execute(sql`
    SELECT
      p.id, p.order_id AS "orderId", p.statement_line_id AS "statementLineId",
      p.amount, p.source, p.txn_date AS "txnDate", p.depositor, p.narration,
      p.bank_ref AS "bankRef", p.bank_name AS "bankName",
      p.account_name AS "accountName", p.account_number AS "accountNumber",
      p.confirmation_basis AS "confirmationBasis",
      p.reviewed_at AS "reviewedAt", p.review_note AS "reviewNote",
      rv.first_name AS "reviewerFirstName", rv.surname AS "reviewerSurname",
      p.note, p.created_at AS "createdAt", p.transfer_id AS "transferId",
      st.first_name AS "recorderFirstName", st.surname AS "recorderSurname",
      -- The order at the other end of a transfer leg, so the row can name it
      -- rather than leaving the reader to look the transfer up.
      CASE WHEN p.source = 'transfer_out' THEN t.to_order_id
           WHEN p.source = 'transfer_in'  THEN t.from_order_id END AS "counterpartOrderId",
      CASE WHEN p.source = 'transfer_out' THEN ${orderReferenceSql("o_to", null)}
           WHEN p.source = 'transfer_in'  THEN ${orderReferenceSql("o_from", null)} END AS "counterpartOrderNumber",
      t.reason AS "transferReason",
      -- The bank payment a transfer leg's money originally arrived as. See the
      -- same subqueries in order.repository.findFinanceReport for why.
      (
        SELECT CASE WHEN COUNT(DISTINCT sp.depositor) = 1 THEN MIN(sp.depositor) END
        FROM order_payments sp
        WHERE sp.order_id = t.from_order_id AND sp.source = 'statement' AND sp.depositor <> ''
      ) AS "originDepositor",
      /**
       * Only where the source order has exactly ONE statement line.
       *
       * This used to string_agg every reference on the source order, so
       * the three transfers out of AM11589 each printed the same four
       * references — implying each had come from all four lines, when in
       * truth nothing records which line a transfer came out of. A
       * transfer moves surplus, and surplus is not attributable to a
       * particular line. Where there is exactly one, saying so is a fact;
       * where there are several, the honest answer is nothing, and the
       * transfer is identified by its own id instead.
       */
      (
        SELECT MIN(sp.bank_ref)
        FROM order_payments sp
        WHERE sp.order_id = t.from_order_id AND sp.source = 'statement' AND sp.bank_ref <> ''
        HAVING COUNT(*) = 1
      ) AS "originBankRefs"
    FROM order_payments p
    LEFT JOIN staff st ON st.id = p.recorded_by
    LEFT JOIN staff rv ON rv.id = p.reviewed_by
    LEFT JOIN order_payment_transfers t ON t.id = p.transfer_id
    LEFT JOIN orders o_to ON o_to.id = t.to_order_id
    LEFT JOIN orders o_from ON o_from.id = t.from_order_id
    WHERE p.order_id = ${orderId}
    ORDER BY p.txn_date ASC NULLS LAST, p.created_at ASC, p.id ASC
  `);
  return rows.rows ?? rows;
};

/** An order's money position, for a screen that needs it without the rows. */
const summarizeOrder = async (orderId, tx = db) => {
  const [order] = await tx
    .select({ totalAmount: orders.totalAmount })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw httpError(404, "Order not found");
  const rows = await tx
    .select({ amount: orderPayments.amount, source: orderPayments.source })
    .from(orderPayments)
    .where(eq(orderPayments.orderId, orderId));
  return summarize(order.totalAmount, rows);
};

/**
 * Orders currently holding surplus, biggest first — where the desk goes to
 * find money that needs moving somewhere.
 */
const findOrdersWithSurplus = async ({ limit = 100, customerId = null } = {}) => {
  const rows = await db.execute(sql`
    SELECT
      o.id, ${orderReferenceSql("o", "c")} AS "orderNumber", o.company_name AS "companyName",
      o.customer_id AS "customerId", c.name AS "customerName",
      o.total_amount AS "totalAmount", o.payment_status AS "paymentStatus",
      p.received,
      (p.received - o.total_amount::numeric) AS surplus
    FROM orders o
    JOIN (
      SELECT order_id, SUM(amount) AS received
      FROM order_payments GROUP BY order_id
    ) p ON p.order_id = o.id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE p.received > o.total_amount::numeric + 0.01
      ${customerId ? sql`AND o.customer_id = ${Number(customerId)}` : sql``}
    ORDER BY (p.received - o.total_amount::numeric) DESC
    LIMIT ${Math.min(500, Number(limit) || 100)}
  `);
  return rows.rows ?? rows;
};

module.exports = {
  PAYMENT_SOURCE,
  recordFromStatementLines,
  removePayment,
  transferSurplus,
  reverseTransfer,
  recomputeOrder,
  summarize,
  summarizeOrder,
  listForOrder,
  findOrdersWithSurplus,
  ratifyPayment,
  ratifyTransfer,
  reviewQueue,
  REVIEWABLE_BASES,
  httpError,
};
