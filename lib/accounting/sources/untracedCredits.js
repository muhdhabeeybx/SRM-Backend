const { sql } = require("drizzle-orm");
const { orderReferenceSql } = require("../../orderReferenceSql");

/**
 * Wallet-era bank credits left off the order they paid.
 *
 * Migration 0021 rebuilt each wallet-era order's payments from the deposits
 * the wallet spent on it. On a few orders it missed some: the order is Paid,
 * its amount_paid says so, but its payment rows add up to less, and the
 * missing money sits in the customer's deposits as credits attached to no
 * order. Read as they stand, the customer owes that money though they paid it.
 *
 * The rows are not touched: the finance report is audited against them (see
 * the note in paymentRules.js). Instead the statement and the books both read
 * each such credit as a payment on the order it paid — the same rule in both,
 * so they keep agreeing.
 *
 * Matched only where it is exact: a set of the customer's unattached credits
 * adding up, to the kobo, to what the order is missing, dated from 60 days
 * before the order to the day after it was confirmed paid. Fewest credits
 * win, then the ones nearest the order's day. An order with no exact match is
 * left as it reads — someone has to look at it, and a guess would hide it.
 *
 * Commission credits, wallet transfers between customers, surplus moved
 * between orders and refunds are not bank money in, and are never matched.
 */

const rowsOf = (r) => r.rows ?? r;
const kobo = (v) => Math.round(Number(v || 0) * 100);
const DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);
const DAY_MS = 86_400_000;
/** Beyond this many candidates the search would stall; none comes close today. */
const MAX_CANDIDATES = 18;

/**
 * Pair orders with the credits that settle exactly what each is missing.
 * Orders oldest first; a credit pays one order at most.
 *
 * @param {Array<{id, customerId, gap, at, confirmedAt}>} orders  gap in naira
 * @param {Array<{id, customerId, amount, at}>} credits
 * @returns {Array<{order, credits}>}
 */
function matchCredits(orders, credits) {
  const used = new Set();
  const out = [];
  const sorted = [...orders].sort((a, b) => +new Date(a.at) - +new Date(b.at) || Number(a.id) - Number(b.id));
  for (const o of sorted) {
    const target = kobo(o.gap);
    if (target <= 0) continue;
    const from = +new Date(o.at) - 60 * DAY_MS;
    const to = +new Date(o.confirmedAt || o.at) + DAY_MS;
    const cand = credits
      .filter((c) => Number(c.customerId) === Number(o.customerId) && !used.has(String(c.id))
        && +new Date(c.at) >= from && +new Date(c.at) <= to && kobo(c.amount) > 0 && kobo(c.amount) <= target)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, MAX_CANDIDATES);
    const distance = (set) => set.reduce((n, c) => n + Math.abs(+new Date(c.at) - +new Date(o.at)), 0);
    let best = null;
    for (let mask = 1; mask < 1 << cand.length; mask++) {
      let sum = 0;
      const set = [];
      for (let i = 0; i < cand.length; i++) {
        if (mask & (1 << i)) { sum += kobo(cand[i].amount); set.push(cand[i]); }
      }
      if (sum !== target) continue;
      if (!best || set.length < best.length || (set.length === best.length && distance(set) < distance(best))) best = set;
    }
    if (!best) continue;
    for (const c of best) used.add(String(c.id));
    out.push({ order: o, credits: best });
  }
  return out;
}

/**
 * Every matched credit, one row each, for one customer or the whole book.
 *
 * @returns {Promise<Array<{id, orderId, orderRef, customerId, pfiId, depotId, at, day, amount, description, reference}>>}
 */
async function untracedCredits(db, { customerId = null } = {}) {
  const scope = customerId == null ? sql`` : sql`AND o.customer_id = ${Number(customerId)}`;
  const orders = rowsOf(await db.execute(sql`
    WITH paid AS (
      SELECT o.id, o.customer_id, o.pfi_id, o.depot_id, o.created_at,
             COALESCE(o.payment_confirmed_at, o.created_at) AS confirmed_at,
             ${orderReferenceSql("o", "c")} AS ref,
             o.amount_paid::numeric - COALESCE((SELECT SUM(p.amount) FROM order_payments p WHERE p.order_id = o.id), 0) AS gap
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.payment_status IN ('Paid', 'Part Paid') AND o.customer_id IS NOT NULL ${scope}
    )
    SELECT id, customer_id AS "customerId", pfi_id AS "pfiId", depot_id AS "depotId",
           created_at AS at, confirmed_at AS "confirmedAt", ref, gap
      FROM paid
     WHERE gap > 0.005
  `));
  if (!orders.length) return [];

  const customers = [...new Set(orders.map((o) => Number(o.customerId)))];
  const credits = rowsOf(await db.execute(sql`
    SELECT d.id, d.customer_id AS "customerId", d.amount::numeric AS amount, d.created_at AS at,
           ${DAY("d.created_at")} AS day, d.description, d.reference
      FROM deposits d
     WHERE d.type = 'credit'
       AND d.customer_id IN (${sql.join(customers.map((n) => sql`${n}`), sql`, `)})
       AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.deposit_id = d.id)
       AND COALESCE(d.reference, '') NOT ILIKE 'COM-%'
       AND COALESCE(d.description, '') !~* '(commission|wallet transfer|TRF TO ORDER|refund)'
  `));

  const rows = [];
  for (const { order, credits: set } of matchCredits(orders, credits)) {
    for (const c of set) {
      rows.push({
        id: `credit:${c.id}`,
        depositId: Number(c.id),
        orderId: Number(order.id),
        orderRef: order.ref,
        customerId: Number(order.customerId),
        pfiId: order.pfiId == null ? null : Number(order.pfiId),
        depotId: order.depotId == null ? null : Number(order.depotId),
        at: c.at,
        day: c.day,
        amount: Number(c.amount),
        description: c.description || "",
        reference: c.reference || "",
      });
    }
  }
  return rows;
}

module.exports = { untracedCredits, matchCredits };
