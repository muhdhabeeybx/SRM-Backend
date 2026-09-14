const { sql } = require("drizzle-orm");
const { db } = require("../config/db");

/**
 * What the system already knows, for a report somebody is about to file.
 *
 * The daily report is typed by hand: a sales manager states the litres sold, a
 * commissions officer states what was paid out, IT compliance states how many
 * orders were raised. Every one of those is also recorded, and until now
 * nobody compared the two. A report saying 1,000,000 litres against a PFI the
 * system has 1,200,000 confirmed on went in, was approved, and the 200,000
 * only surfaced if a person happened to check.
 *
 * ── A comparison, never a correction ───────────────────────────────────────
 *
 * These figures are shown beside what is being typed and are never written
 * over it. The person filing knows things the system does not — a truck that
 * loaded late, a payment that came by transfer nobody has matched yet — and a
 * form that silently replaced their number with the database's would be worse
 * than one that says nothing. It flags, it does not fix.
 *
 * ── Keyed the way the reports are ──────────────────────────────────────────
 *
 * Per PFI and per day, because that is how the desk files. A report with no
 * PFI (compliance can be filed company-wide) gets the day's whole book, which
 * is the honest comparison for what it claims.
 */

/** Orders raised on the day, scoped to a PFI when one is named. */
const ordersOn = (date, pfiId) => sql`
  SELECT o.id, o.quantity, o.price, o.total_amount, o.status, o.payment_status,
         o.customer_id, o.pfi_id
    FROM orders o
   WHERE o.created_at >= ${date}::date
     AND o.created_at < (${date}::date + interval '1 day')
     ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
`;

/** An order that reached a truck, as against one merely placed. */
const LOADED = ["Loading", "Completed"];

const num = (v) => Number(v) || 0;

/**
 * postgres.js hands back a plain array; other drivers wrap it in `{ rows }`.
 * Reading `.rows` alone silently yields nothing on the first, which is exactly
 * what it did here — every figure came back 0 against a day with 40 orders.
 */
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/**
 * Everything a report of any type might want to be checked against.
 *
 * One query set rather than one per report type: the figures overlap heavily
 * (litres appear on three sheets), and computing them together means two
 * sheets filed for the same PFI on the same day cannot disagree about what
 * the system said.
 */
const forReport = async ({ date, pfiId = null }) => {
  const rows = rowsOf(await db.execute(ordersOn(date, pfiId)));

  const loaded = rows.filter((o) => LOADED.includes(o.status));
  const paidOrders = rows.filter((o) => o.payment_status === "Paid");

  const litresOrdered = rows.reduce((s, o) => s + num(o.quantity), 0);
  const litresLoaded = loaded.reduce((s, o) => s + num(o.quantity), 0);
  const valueOrdered = rows.reduce((s, o) => s + num(o.total_amount), 0);

  /**
   * Trucks the gate actually saw, on the day — not trucks attached to the
   * day's orders. A truck ticketed yesterday and gated in this morning is
   * this morning's gate activity, and the security sheet is filed about the
   * gate's day rather than about a set of orders.
   */
  const gate = (rowsOf(await db.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE t.security_entered_at >= ${date}::date
          AND t.security_entered_at < (${date}::date + interval '1 day')
      )::int AS entered,
      COUNT(*) FILTER (
        WHERE t.security_exited_at >= ${date}::date
          AND t.security_exited_at < (${date}::date + interval '1 day')
      )::int AS exited
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
     WHERE ${pfiId ? sql`o.pfi_id = ${Number(pfiId)}` : sql`TRUE`}
  `)))[0] || { entered: 0, exited: 0 };

  /**
   * Commission recorded against the day's orders on this batch.
   *
   * `due` is everything raised, `paid` only what the desk has marked paid.
   * Skipped rows are in neither: the desk decided they are not owed, so
   * counting them as due would tell the officer they owe money nobody thinks
   * they owe.
   */
  const commission = (rowsOf(await db.execute(sql`
    SELECT
      COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status <> 'skipped'), 0) AS due,
      COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status = 'paid'), 0) AS paid,
      COUNT(*) FILTER (WHERE c.status = 'pending')::int AS pending_count
      FROM commissions c
      JOIN orders o ON o.id = c.order_id
     WHERE o.created_at >= ${date}::date
       AND o.created_at < (${date}::date + interval '1 day')
       ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
  `)))[0] || { due: 0, paid: 0, pending_count: 0 };

  /** Money actually received against those orders, from the payment rows. */
  const received = (rowsOf(await db.execute(sql`
    SELECT COALESCE(SUM(op.amount), 0) AS total
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.created_at >= ${date}::date
       AND o.created_at < (${date}::date + interval '1 day')
       ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
  `)))[0] || { total: 0 };

  const prices = [...new Set(rows.map((o) => Math.round(num(o.price) * 100) / 100).filter(Boolean))];

  return {
    date,
    pfiId: pfiId ?? null,
    /**
     * Keyed by the FIELD NAME the report form uses, so a client can look up
     * "what does the system say about litresSold" without a mapping table it
     * would then have to keep in step.
     */
    fields: {
      orderCount: rows.length,
      customerCount: new Set(rows.map((o) => o.customer_id).filter(Boolean)).size,
      litresSold: litresLoaded,
      /** Product managers state what was ordered, not what left. */
      receivedStock: litresOrdered,
      totalSalesAmount: valueOrdered,
      avgPrice: litresOrdered ? Math.round((valueOrdered / litresOrdered) * 100) / 100 : 0,
      truckCount: gate.exited,
      trucksEntered: gate.entered,
      fundsReceived: num(received.total),
      commissionDue: num(commission.due),
      amountPaid: num(commission.paid),
    },
    /** Context the form shows but does not compare — prices vary legitimately. */
    context: {
      litresOrdered,
      paidOrderCount: paidOrders.length,
      pendingCommissions: commission.pending_count,
      pricesSeen: prices.sort((a, b) => a - b),
    },
  };
};

module.exports = { forReport };
