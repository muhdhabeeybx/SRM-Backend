/**
 * Money that has already left the bank, written straight in as a paid
 * expense — Expenses' "record as already paid", raised from Delivery Costing
 * for loading money or an owner's advance paid before anybody costed the
 * trucks (the user, 2026-10-27).
 *
 * The same rule as controllers/administration/expense.controller createExpense:
 * a super admin only, and the settlement facts are still demanded — which
 * account it left, the date and the payment's reference. Skipping the approval
 * chain is the point; skipping the evidence is not. The audit row is written
 * as `recorded_as_paid`, and nobody is notified: there is no next actor.
 */
const chain = require("./expenseChain");

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/**
 * The columns a paid expense is created with, or a 4xx saying what is missing.
 *
 * @param {object} paid      { bankPaidFrom, paymentDate, paymentReference, paymentMethod?, notes? }
 * @param {object} p
 * @param {number} p.amount  what was paid, naira — the request's own amount
 * @param {object} p.user    req.user, for the role check
 * @param {number|null} p.actorId
 */
function paidColumns(paid, { amount, user, actorId }) {
  if (!chain.canRecordAsPaid(user)) throw httpError(403, "Only a super admin can record an expense as already paid.");
  const bank = String(paid?.bankPaidFrom ?? "").trim();
  if (!bank) throw httpError(400, "Say which account it was paid from");
  const reference = String(paid?.paymentReference ?? "").trim();
  if (!reference) throw httpError(400, "Enter the payment reference");
  const date = paid?.paymentDate ? new Date(paid.paymentDate) : null;
  if (!date || Number.isNaN(date.getTime())) throw httpError(400, "Enter the date it was paid");
  if (date.getTime() > Date.now() + 60_000) throw httpError(400, "The payment date is in the future");
  const at = date.toISOString();
  return {
    status: chain.STATUS.PAID,
    bank_paid_from: bank,
    amount_paid: String(amount),
    payment_reference: reference,
    payment_date: at,
    payment_method: String(paid?.paymentMethod ?? "").trim(),
    payment_notes: String(paid?.notes ?? "").trim(),
    // The stage stamps the chain would have written on the way past.
    paid_by: actorId ?? null,
    paid_at: at,
    reviewed_by: actorId ?? null,
    reviewed_at: new Date().toISOString(),
  };
}

const AUDIT_NOTE = "Recorded as already paid by a super admin from Delivery Costing — approval chain bypassed";

module.exports = { paidColumns, AUDIT_NOTE };
