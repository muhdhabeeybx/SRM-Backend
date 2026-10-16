/**
 * Wallet-era moves of surplus between orders, read off the credit deposit the
 * old system wrote for them ("…Overpayment received from order #10916").
 *
 * Seven readers rebuild these — the finance report (its rows and its per-order
 * figure), the refund desk (twice), the overview, the ledger postings and the
 * customer statement — and they must agree, so the two rules live here.
 */

/**
 * The part of a move still recorded nowhere else, as a numeric expression on
 * the credit deposit `dp`.
 *
 * The receiving order's row began as a 'legacy' payment. Where it has since
 * become the transfer_in leg of a recorded transfer — 31 by
 * scripts/restore-transfer-out-legs.js, 25 more by the correction of 16 Oct
 * 2026 — that transfer's transfer_out already takes the money off the giving
 * order, and rebuilding it from the description would take it off twice. What
 * is left is whatever never reached an order: order 11007 moved ₦149,999,
 * order 11181 drew ₦149,000, and ₦999 stayed in a wallet.
 */
const unrecordedMoveSql = (dp) =>
  `(${dp}.amount::numeric - COALESCE((SELECT SUM(tp.amount) FROM order_payments tp
      WHERE tp.deposit_id = ${dp}.id AND tp.source = 'transfer_in'), 0))`;

/**
 * The move reached an order: an order drew on its credit and holds a payment
 * row for it, still 'legacy' or since a transfer_in leg. The readers that only
 * net a move once its receiving end is on the books ask this.
 */
const moveReachedAnOrderSql = (dp) =>
  `EXISTS (SELECT 1 FROM order_deposit_allocations ra
             JOIN order_payments rp ON rp.deposit_id = ra.deposit_id AND rp.order_id = ra.order_id
                                   AND rp.source IN ('legacy', 'transfer_in')
            WHERE ra.deposit_id = ${dp}.id)`;

module.exports = { unrecordedMoveSql, moveReachedAnOrderSql };
