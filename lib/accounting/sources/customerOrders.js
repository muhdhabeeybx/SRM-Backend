const { sql } = require("drizzle-orm");
const { saleSql } = require("../../orderSale");
const { orderReferenceSql } = require("../../orderReferenceSql");
const { duplicateCtes, leftOutSql } = require("./paymentRules");

/**
 * A depot customer's money, as dated events: what they were charged and what
 * came in against it. The source the customer statement reads, and later the
 * general ledger.
 *
 *   sale              an order that counts as a sale (lib/orderSale — Paid, or
 *                     Part Paid while still live), at its value, on the day it
 *                     was placed. Less any surplus later kept as delivery,
 *                     which is its own line on the day it was recorded.
 *   surplus_delivery  surplus kept as a delivery charge (0080), not voided.
 *   payment           every order_payments row on their orders, signed from
 *                     the customer's side: money in lowers what they owe; a
 *                     transfer out or a refund raises it again.
 *   wallet_moved      surplus one of their orders handed on before 1 Sep 2026,
 *                     recorded only as a deposit description (see below).
 *
 * ── Which payment rows are not money ──────────────────────────────────────
 *
 * Two kinds of row migration 0021 left behind are read past here:
 *
 *   duplicates   a `legacy` placeholder beside another payment of the same
 *                money on the same order — the finance report's own rule.
 *   re-created   a payment somebody removed that the backfill wrote back.
 *
 * Both are spelled out once, in ./paymentRules.js.
 *
 * The rows stay where they are, because the finance report is audited against
 * them. Their totals come back with the events so a statement can say what it
 * left out, and reconcile to the finance report line by line.
 *
 * ── Wallet-era moves ──────────────────────────────────────────────────────
 *
 * Surplus moved between orders in the wallet era left the giving order still
 * counting money it handed on. The finance report's customer block takes it
 * off behind a guard — only where doing so lands the order exactly on its own
 * value — and this does the same, with the same guard, so the two agree.
 */

const LAGOS_DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);

/** The customer's orders, with what each needs to describe itself. */
const mineCte = (customerId, pfiIds) => {
  const scope = pfiIds?.length
    ? sql`AND o.pfi_id IN (${sql.join(pfiIds.map((n) => sql`${Number(n)}`), sql`, `)})`
    : sql``;
  return sql`
    mine AS (
      SELECT o.id, o.created_at, o.total_amount::numeric AS total,
             COALESCE(o.delivery_fee, 0)::numeric AS delivery_fee,
             COALESCE(o.delivery_from_surplus, 0)::numeric AS dfs,
             o.quantity, o.price::numeric AS price, o.pricing_status::text AS pricing_status,
             o.status::text AS status, o.payment_status::text AS payment_status,
             ${orderReferenceSql("o", "c")} AS ref,
             ${sql.raw(saleSql("o"))} AS is_sale,
             pr.name AS product, pr.unit AS unit, d.name AS depot, pf.pfi_number
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN products pr ON pr.id = o.product_id
        LEFT JOIN depots d ON d.id = o.depot_id
        LEFT JOIN pfis pf ON pf.id = o.pfi_id
       WHERE o.customer_id = ${Number(customerId)} ${scope}
    )`;
};

const rowsOf = (result) => result.rows ?? result;

async function sales(db, mine) {
  return rowsOf(await db.execute(sql`
    WITH ${mine}
    SELECT m.id AS "orderId", m.ref AS "orderRef", m.created_at AS at, ${LAGOS_DAY("m.created_at")} AS day,
           (m.total - m.dfs) AS amount, m.delivery_fee - m.dfs AS "deliveryFee",
           m.quantity, m.price, m.pricing_status AS "pricingStatus",
           m.product, m.unit, m.depot, m.pfi_number AS "pfiNumber", m.status
      FROM mine m
     WHERE m.is_sale
  `));
}

async function surplusDeliveries(db, mine) {
  return rowsOf(await db.execute(sql`
    WITH ${mine}
    SELECT s.id, m.id AS "orderId", m.ref AS "orderRef", s.created_at AS at, ${LAGOS_DAY("s.created_at")} AS day,
           s.amount::numeric AS amount, s.note
      FROM order_surplus_deliveries s
      JOIN mine m ON m.id = s.order_id
     WHERE s.voided_at IS NULL AND m.is_sale
  `));
}

async function payments(db, mine) {
  return rowsOf(await db.execute(sql`
    WITH ${mine},
    ${duplicateCtes("mine")},
    paid AS (
      SELECT p.*,
             -- The day the money moved: the bank's day; a transfer's or a
             -- refund's own; for the wallet era carried over on 1 Sep, its
             -- deposit's day rather than the day it was carried over. The
             -- same rule as the customer's Payments card.
             CASE WHEN p.source = 'legacy' THEN COALESCE(dp.created_at, m.created_at)
                  ELSE COALESCE(p.txn_date, p.created_at) END AS moved_at,
             m.ref AS order_ref,
             ${leftOutSql("p")} AS left_out
        FROM order_payments p
        JOIN mine m ON m.id = p.order_id
        LEFT JOIN deposits dp ON dp.id = p.deposit_id
    )
    SELECT p.id, p.order_id AS "orderId", p.order_ref AS "orderRef", p.moved_at AS at,
           ${LAGOS_DAY("p.moved_at")} AS day,
           p.amount::numeric AS paid, p.source::text AS source, p.left_out AS "leftOut",
           p.bank_name AS "bankName", p.account_number AS "accountNumber",
           p.depositor, p.bank_ref AS "bankRef",
           CASE WHEN p.source = 'transfer_out' THEN ${orderReferenceSql("o_to", "c_to")}
                WHEN p.source = 'transfer_in'  THEN ${orderReferenceSql("o_from", "c_from")} END AS counterpart,
           CASE WHEN p.source = 'transfer_out' THEN o_to.customer_id
                WHEN p.source = 'transfer_in'  THEN o_from.customer_id END AS "counterpartCustomerId",
           t.reason
      FROM paid p
      LEFT JOIN order_payment_transfers t ON t.id = p.transfer_id
      LEFT JOIN orders o_to ON o_to.id = t.to_order_id
      LEFT JOIN customers c_to ON c_to.id = o_to.customer_id
      LEFT JOIN orders o_from ON o_from.id = t.from_order_id
      LEFT JOIN customers c_from ON c_from.id = o_from.customer_id
  `));
}

async function walletMoves(db, mine) {
  return rowsOf(await db.execute(sql`
    WITH ${mine},
    moved AS (
      SELECT m.id AS order_id, m.ref AS order_ref, m.total,
             dp.id AS deposit_id, dp.created_at AS at, dp.amount::numeric AS amount,
             MIN(r.id) AS to_order_id
        FROM mine m
        JOIN deposits dp
          ON dp.description ~ 'from order #[0-9]+'
         AND (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int = m.id
        JOIN order_deposit_allocations a ON a.deposit_id = dp.id
        JOIN order_payments op ON op.deposit_id = dp.id AND op.order_id = a.order_id AND op.source = 'legacy'
        JOIN orders r ON r.id = a.order_id
       WHERE m.payment_status IN ('Paid', 'Part Paid')
       GROUP BY m.id, m.ref, m.total, dp.id, dp.created_at, dp.amount
    ),
    -- The finance report's guard: taken off only where it lands the order on
    -- exactly its own value, which is what proves the money really left.
    proven AS (
      SELECT mv.order_id
        FROM moved mv
       GROUP BY mv.order_id, mv.total
      HAVING ROUND((SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op WHERE op.order_id = mv.order_id)
                   - SUM(mv.amount) - mv.total, 2) = 0
    )
    SELECT mv.deposit_id AS id, mv.order_id AS "orderId", mv.order_ref AS "orderRef",
           mv.at, ${LAGOS_DAY("mv.at")} AS day, mv.amount,
           ${orderReferenceSql("r", "rc")} AS counterpart, r.customer_id AS "counterpartCustomerId"
      FROM moved mv
      JOIN proven pv ON pv.order_id = mv.order_id
      JOIN orders r ON r.id = mv.to_order_id
      LEFT JOIN customers rc ON rc.id = r.customer_id
  `));
}

/** Orders standing open with nothing paid: not on the statement, but worth knowing. */
async function awaiting(db, mine) {
  const [row] = rowsOf(await db.execute(sql`
    WITH ${mine}
    SELECT COUNT(*)::int AS count, COALESCE(SUM(m.total), 0) AS value
      FROM mine m
     WHERE NOT m.is_sale
       AND m.payment_status = 'Unpaid'
       -- A merged order is Cancelled (0056), so this drops those too.
       AND COALESCE(m.status, '') NOT IN ('Cancelled', 'Expired')
  `));
  return { count: Number(row?.count || 0), value: Number(row?.value || 0) };
}

/** Everything the customer statement needs, read in parallel. */
async function customerSources(db, { customerId, pfiIds = null }) {
  const mine = mineCte(customerId, pfiIds);
  const [s, d, p, w, a] = await Promise.all([
    sales(db, mine),
    surplusDeliveries(db, mine),
    payments(db, mine),
    walletMoves(db, mine),
    awaiting(db, mine),
  ]);
  return { sales: s, surplusDeliveries: d, payments: p, walletMoves: w, awaiting: a };
}

module.exports = { customerSources };
