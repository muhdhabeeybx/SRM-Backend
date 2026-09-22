const { sql } = require("drizzle-orm");
const { db } = require("../config/db");

/**
 * The panels on the company overview that had to be rebuilt, and why.
 *
 * Each of these replaced a figure that was either wrong or answering a
 * different question from the one its label asked. The reasoning is kept next
 * to each query rather than in a commit message, because the next person to
 * look at "Total revenue" will be looking here.
 */

const rowsOf = (result) => result.rows ?? result;
const num = (v) => Number(v || 0);

/**
 * The trade names the desk uses, against what the PFI records store.
 *
 * Stock is booked as "Petrol" / "Diesel" / "Cooking Gas"; everyone asks about
 * it as PMS, AGO and LPG. Both are carried, so the panel can lead with the
 * short name without losing what the record actually says.
 */
const PRODUCT_ALIASES = { Petrol: "PMS", Diesel: "AGO", "Cooking Gas": "LPG" };

/**
 * Money, for a period — from what was actually received against orders.
 *
 * ── What this replaced ─────────────────────────────────────────────────────
 *
 * A "Total revenue" that silently summed three different books: order revenue,
 * offline sales, and payments on the delivery (truck sales) ledger. For August
 * that headline read ₦77.68bn while the only component shown beneath it read
 * ₦73.78bn — the ₦3.90bn difference was delivery payments, whose row was
 * commented out. A headline and its own breakdown differing by ₦3.9bn with
 * nothing on the page accounting for it is the single most likely reason
 * somebody says the financial summary is not correct.
 *
 * Two further problems in the same figure:
 *
 *   * it counted orders with payment_status = 'Paid' only, so a part-paid
 *     order contributed nothing at all; and
 *   * it summed total_amount — what was BILLED — and called it revenue, which
 *     is what was invoiced, not what came in.
 *
 * Now: billed and received are two named figures from order_payments, the same
 * table the finance report reconciles against the bank statement, so the
 * dashboard and the finance report cannot disagree. Delivery-ledger payments
 * are returned separately and labelled, never folded into an order figure.
 */
const financeSummary = async ({ from, to }) => {
  const [orders] = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*)::int AS "orderCount",
        COUNT(*) FILTER (WHERE o.payment_status = 'Part Paid')::int AS "partPaidCount",
        COALESCE(SUM(o.total_amount::numeric), 0) AS billed,
        -- Money in, at the bank's own figure. Transfer legs are movements
        -- between orders, not receipts, so they are excluded on both sides.
        COALESCE(SUM((
          SELECT COALESCE(SUM(p.amount), 0) FROM order_payments p
          WHERE p.order_id = o.id AND p.source NOT IN ('transfer_in', 'transfer_out', 'refund')
        )), 0) AS received,
        COALESCE(SUM(GREATEST(0, o.total_amount::numeric - (
          SELECT COALESCE(SUM(p.amount), 0) FROM order_payments p WHERE p.order_id = o.id
        ))), 0) AS shortfall,
        COALESCE(SUM(GREATEST(0, (
          SELECT COALESCE(SUM(p.amount), 0) FROM order_payments p WHERE p.order_id = o.id
        ) - o.total_amount::numeric)), 0) AS surplus
      FROM orders o
      WHERE o.created_at >= ${from} AND o.created_at <= ${to}
        AND o.payment_status IN ('Paid', 'Part Paid')
    `),
  );

  // A different book, kept apart. Truck-sales payments are real money but they
  // are not order revenue, and adding them to one produced the headline this
  // function exists to correct.
  const [delivery] = rowsOf(
    await db.execute(sql`
      SELECT
        COALESCE(SUM(ds.payment_amount::numeric), 0) AS payments,
        COUNT(*)::int AS entries
      FROM delivery_sales ds
      WHERE ds.date_loaded >= ${String(from).slice(0, 10)}
        AND ds.date_loaded <= ${String(to).slice(0, 10)}
    `),
  );

  const [unpaid] = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*)::int AS "orderCount",
        COALESCE(SUM(o.total_amount::numeric - o.amount_paid::numeric), 0) AS owed
      FROM orders o
      WHERE o.created_at >= ${from} AND o.created_at <= ${to}
        AND o.payment_status IN ('Unpaid', 'Part Paid')
        AND o.status NOT IN ('Cancelled', 'Expired')
    `),
  );

  return {
    orderCount: num(orders.orderCount),
    partPaidCount: num(orders.partPaidCount),
    /** What was invoiced on orders confirmed in this window. */
    billed: num(orders.billed),
    /** What actually came in against them, at the bank's figure. */
    received: num(orders.received),
    /** Still owed on those orders. */
    shortfall: num(orders.shortfall),
    /** Received beyond an order's value, sitting on the order. */
    surplus: num(orders.surplus),
    /** The truck-sales ledger. A separate book, never added to the above. */
    deliveryPayments: num(delivery.payments),
    deliveryEntries: num(delivery.entries),
    /** Orders raised in this window that are still owed money. */
    awaitingPayment: num(unpaid.orderCount),
    awaitingPaymentValue: num(unpaid.owed),
  };
};

/**
 * Stock, and nothing else.
 *
 * The panel this feeds was headed "PFI & Inventory" and led with a naira
 * figure — the value of remaining stock — followed by a per-status PFI count.
 * Somebody asking "how much AGO have we got left" could not answer it from
 * that panel at all, which is the only question the panel is for.
 *
 * So: litres remaining per product, and how many PFIs are open. No money.
 */
const inventorySummary = async () => {
  const byProduct = rowsOf(
    await db.execute(sql`
      SELECT
        COALESCE(NULLIF(TRIM(p.product_name), ''), 'Unspecified') AS product,
        COUNT(*)::int AS "pfiCount",
        COALESCE(SUM(p.starting_qty_litres), 0)::bigint AS "startingLitres",
        COALESCE(SUM(p.sold_qty_litres), 0)::bigint AS "soldLitres",
        COALESCE(SUM(p.starting_qty_litres + p.evacuation_surplus_litres - p.sold_qty_litres), 0)::bigint AS "remainingLitres"
      FROM pfis p
      WHERE p.status = 'active'
      GROUP BY 1
      ORDER BY 5 DESC
    `),
  );

  const [totals] = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')::int AS "openPfis",
        COUNT(*)::int AS "totalPfis",
        COALESCE(SUM(starting_qty_litres + evacuation_surplus_litres - sold_qty_litres) FILTER (WHERE status = 'active'), 0)::bigint
          AS "remainingLitres",
        COALESCE(SUM(starting_qty_litres) FILTER (WHERE status = 'active'), 0)::bigint AS "startingLitres"
      FROM pfis
    `),
  );

  return {
    openPfis: num(totals.openPfis),
    totalPfis: num(totals.totalPfis),
    remainingLitres: num(totals.remainingLitres),
    startingLitres: num(totals.startingLitres),
    byProduct: byProduct.map((r) => ({
      product: r.product,
      /** PMS / AGO / LPG where known, else the stored name. */
      shortName: PRODUCT_ALIASES[r.product] || r.product,
      pfiCount: num(r.pfiCount),
      startingLitres: num(r.startingLitres),
      soldLitres: num(r.soldLitres),
      remainingLitres: num(r.remainingLitres),
      /** How much of the intake is gone — the bar a stock panel wants. */
      soldPct: num(r.startingLitres) > 0
        ? Math.round((num(r.soldLitres) / num(r.startingLitres)) * 100)
        : 0,
    })),
  };
};

/**
 * Depot ranking — active depots only.
 *
 * A suspended depot cannot take an order, so ranking it against those that can
 * is comparing a closed shop to an open one. Six of the thirteen depots are
 * suspended; they sat in the table on nil, pushing the ones actually trading
 * down the page.
 *
 * Ranked on money RECEIVED rather than billed, for the same reason
 * financeSummary is.
 */
const depotLeaderboard = async ({ from, to }) => {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        d.id,
        d.name,
        d.state,
        COUNT(o.id)::int AS "orderCount",
        COALESCE(SUM(o.quantity), 0)::bigint AS volume,
        COALESCE(SUM(o.total_amount::numeric), 0) AS billed,
        COALESCE(SUM((
          SELECT COALESCE(SUM(p.amount), 0) FROM order_payments p
          WHERE p.order_id = o.id AND p.source NOT IN ('transfer_in', 'transfer_out', 'refund')
        )), 0) AS revenue
      FROM depots d
      LEFT JOIN orders o
        ON o.depot_id = d.id
       AND o.payment_status IN ('Paid', 'Part Paid')
       AND o.created_at >= ${from} AND o.created_at <= ${to}
      WHERE d.status IN ('Active', 'High Capacity')
      GROUP BY d.id, d.name, d.state
      ORDER BY revenue DESC, "orderCount" DESC
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    state: r.state,
    orderCount: num(r.orderCount),
    volume: num(r.volume),
    billed: num(r.billed),
    revenue: num(r.revenue),
  }));
};

/**
 * What people have been doing.
 *
 * The overview read `audit_events`, which holds 182 rows. Every business
 * action this system records goes to `audit_logs`, which holds 50,322 — so the
 * activity feed was showing a near-empty table and looked broken because it
 * was reading the wrong one.
 *
 * Paginated, because the same query now backs a full activity page as well as
 * the ten rows on the overview.
 */
const activityFeed = async ({ limit = 10, offset = 0, entityType, action, from, to } = {}) => {
  const conditions = [sql`TRUE`];
  if (entityType) conditions.push(sql`a.entity_type = ${entityType}`);
  if (action) conditions.push(sql`a.action ILIKE ${`%${action}%`}`);
  if (from) conditions.push(sql`a.created_at >= ${from}`);
  if (to) conditions.push(sql`a.created_at <= ${to}`);
  const where = sql.join(conditions, sql` AND `);

  const [rows, [{ total }]] = await Promise.all([
    db.execute(sql`
      SELECT
        a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
        a.prev_state AS "prevState", a.new_state AS "newState",
        a.actor_type AS "actorType", a.created_at AS "createdAt", a.metadata,
        -- Who did it. Staff and customers live in different tables, so the
        -- name is resolved here rather than leaving the page to guess from an
        -- actor id it has no way to look up.
        COALESCE(
          NULLIF(TRIM(CONCAT(s.first_name, ' ', s.surname)), ''),
          c.name,
          CASE WHEN a.actor_type = 'system' THEN 'System' END
        ) AS "actorName"
      FROM audit_logs a
      LEFT JOIN staff s ON s.id = a.actor_staff_id
      LEFT JOIN customers c ON c.id = a.actor_customer_id
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${Math.min(200, Number(limit) || 10)} OFFSET ${Math.max(0, Number(offset) || 0)}
    `),
    db.execute(sql`SELECT COUNT(*)::int AS total FROM audit_logs a WHERE ${where}`),
  ]);

  return { rows: rowsOf(rows), total: num(total) };
};

module.exports = { financeSummary, inventorySummary, depotLeaderboard, activityFeed };
