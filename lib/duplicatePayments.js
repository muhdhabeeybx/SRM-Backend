/**
 * Which `legacy` order_payments rows are the same money counted twice — the
 * finance report's rule (order.repository findCustomerDifferentials), kept in
 * one place for everything that decides what money an order really holds: the
 * customer statement, the general ledger and the refund desk.
 *
 * Migration 0021 wrote a `legacy` row for money already on the order as
 * another payment — a transfer_in, or the bank statement line that replaced
 * it at cutover. A legacy row is that duplicate when another payment of the
 * same amount sits on the same order AND dropping every such row lands the
 * overpaid order exactly on its value, which proves they were the same money.
 *
 * Wider than the CFO report's DUPLICATE_LEGACY_IDS_SQL, which only looks
 * beside a transfer_in: on order 9437 a ₦52,920,000 legacy row sits beside
 * the ₦52,920,000 statement line it duplicates, and the narrow rule offered
 * ₦53,145,000 of it for refund (2026-10-14). The CFO report keeps its rule —
 * it is audited against it.
 *
 * Plain SQL text so a postgres.js query (client.unsafe) and a drizzle one
 * (sql.raw) build from the same words.
 */

/** `cand` and `dup` CTEs over a relation of orders with columns (id, total). */
const duplicateCtesText = (ordersRel) => `
  cand AS (
    SELECT op.id, op.order_id, op.amount::numeric AS amount
      FROM order_payments op
      JOIN ${ordersRel} m ON m.id = op.order_id
     WHERE op.source = 'legacy'
       AND EXISTS (SELECT 1 FROM order_payments k
                    WHERE k.order_id = op.order_id AND k.source <> 'legacy' AND k.amount = op.amount)
  ),
  dup AS (
    SELECT c.id FROM cand c
     WHERE c.order_id IN (
       SELECT c2.order_id
         FROM cand c2
         JOIN ${ordersRel} m ON m.id = c2.order_id
         CROSS JOIN LATERAL (SELECT SUM(a.amount)::numeric AS received
                               FROM order_payments a WHERE a.order_id = c2.order_id) r
        GROUP BY c2.order_id, m.total, r.received
       HAVING r.received > m.total AND ROUND(r.received - SUM(c2.amount) - m.total, 2) = 0)
  )`;

/** Every duplicate row's id, across all orders — for `id NOT IN (…)`. */
const DUPLICATE_PAYMENT_IDS_SQL = `
  WITH dup_orders AS (SELECT id, total_amount::numeric AS total FROM orders),
  ${duplicateCtesText("dup_orders")}
  SELECT id FROM dup`;

module.exports = { duplicateCtesText, DUPLICATE_PAYMENT_IDS_SQL };
