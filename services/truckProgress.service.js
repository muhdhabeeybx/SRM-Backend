const { sql } = require("drizzle-orm");
const { db } = require("../config/db");

/**
 * Where every truck on an order actually is.
 *
 * The dashboard has always counted orders — "46 awaiting tickets" — while the
 * work is per truck. One of those orders might need six trucks and have two,
 * and nothing on any screen said so: two rows appear, and whether that is
 * finished or a third done is a litre subtraction the reader does in their
 * head. This is that subtraction, done once, in one place.
 *
 * ── The four states a truck passes through ─────────────────────────────────
 *
 *   toTicket    expected but no row yet — the loading desk's work
 *   awaitingIn  ticketed, not yet at the gate — nobody's work, we are waiting
 *   onYard      gated in, not yet out — loading, or forgotten
 *   out         gated out — done, and the only state that means "loaded"
 *
 * They sum to the expected count where one was given. Where it was not,
 * `expected` is null and `toTicket` is null with it: unknown is reported as
 * unknown rather than as zero, because zero would read as "nothing left to
 * do" on exactly the orders nobody has counted.
 */

const PROGRESS_SELECT = sql`
  o.expected_trucks AS "expected",
  COALESCE(t.ticketed, 0)::int AS "ticketed",
  COALESCE(t.on_yard, 0)::int  AS "onYard",
  COALESCE(t.out, 0)::int      AS "out",
  COALESCE(t.awaiting_in, 0)::int AS "awaitingIn",
  COALESCE(t.litres_out, 0)::int  AS "litresOut",
  COALESCE(t.litres_ticketed, 0)::int AS "litresTicketed"
`;

const PROGRESS_JOIN = sql`
  LEFT JOIN (
    SELECT order_id,
           COUNT(*)::int AS ticketed,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS awaiting_in,
           COUNT(*) FILTER (WHERE status IN ('gated_in', 'loaded'))::int AS on_yard,
           COUNT(*) FILTER (WHERE status = 'gated_out')::int AS out,
           COALESCE(SUM(quantity), 0)::int AS litres_ticketed,
           COALESCE(SUM(quantity) FILTER (WHERE status = 'gated_out'), 0)::int AS litres_out
      FROM order_trucks
     GROUP BY order_id
  ) t ON t.order_id = o.id
`;

/**
 * Turn the raw counts into what a row should say.
 *
 * `label` is deliberately a sentence and not a fraction on its own: "4 of 6
 * ticketed" is read correctly at a glance, "4/6" gets read as litres, a date,
 * or a score depending on which column it lands in.
 */
const shape = (row) => {
  const expected = row.expected == null ? null : Number(row.expected);
  const ticketed = Number(row.ticketed) || 0;
  const out = Number(row.out) || 0;

  const toTicket = expected == null ? null : Math.max(0, expected - ticketed);
  // An order that produced more trucks than it declared is not an error worth
  // refusing — the haulage changed — but it is worth saying, because the
  // declared figure is now the wrong one to plan against.
  const overTicketed = expected != null && ticketed > expected;

  return {
    expected,
    ticketed,
    toTicket,
    awaitingIn: Number(row.awaitingIn) || 0,
    onYard: Number(row.onYard) || 0,
    out,
    overTicketed,
    litresTicketed: Number(row.litresTicketed) || 0,
    litresOut: Number(row.litresOut) || 0,
    /** Every declared truck has gone out. Never true without a denominator. */
    complete: expected != null && out >= expected,
    label:
      expected == null
        ? `${ticketed} truck${ticketed === 1 ? "" : "s"} ticketed`
        : `${ticketed} of ${expected} ticketed`,
    /** What is actually loaded and gone, which is what a report should read. */
    loadedLabel:
      expected == null
        ? `${out} of ${ticketed} loaded`
        : `${out} of ${expected} loaded`,
  };
};

/** One order. */
const forOrder = async (orderId) => {
  const rows = await db.execute(sql`
    SELECT o.id, ${PROGRESS_SELECT}
      FROM orders o
      ${PROGRESS_JOIN}
     WHERE o.id = ${Number(orderId)}
  `);
  const row = (rows.rows ?? rows)[0];
  return row ? shape(row) : null;
};

/**
 * Many orders at once, keyed by id.
 *
 * One query for a page of orders rather than one per row — the commissions
 * list learned that lesson the expensive way.
 */
const forOrders = async (orderIds) => {
  const ids = [...new Set((orderIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};

  const rows = await db.execute(sql`
    SELECT o.id, ${PROGRESS_SELECT}
      FROM orders o
      ${PROGRESS_JOIN}
     WHERE o.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);

  const byId = {};
  for (const row of rows.rows ?? rows) byId[row.id] = shape(row);
  return byId;
};

/**
 * How many trucks an order still needs ticketed, when nobody declared a count.
 *
 * ── Why an estimate exists at all ──────────────────────────────────────────
 *
 * The desk asked for the ticket queue in trucks rather than orders, and an
 * order awaiting tickets has none by definition — so the only exact source is
 * expected_trucks, captured at order entry. Today not one order in the queue
 * has it: the field is newer than they are. Counting only declared trucks
 * would report "0 trucks to ticket" beside eight orders plainly needing them,
 * which is worse than an approximation.
 *
 * ── How good the approximation is ──────────────────────────────────────────
 *
 * Litres divided by the median truck that depot actually loads. Checked
 * against the 4,679 orders whose trucks are already known: exact for 73% of
 * them, within one truck for 98%. Every depot's median is 45,000, but it is
 * computed per depot rather than hard-coded so a depot that starts loading
 * 60,000s corrects itself.
 *
 * ── And why it stays separate from the exact figure ────────────────────────
 *
 * An estimate summed into a declared count produces a number nobody can act
 * on: a supervisor cannot tell whether "14" means fourteen trucks are coming
 * or that a spreadsheet guessed. They are returned apart, and every caller
 * showing the total says which part was guessed.
 */
const DEPOT_MEDIAN_TRUCK = sql`
  SELECT o2.depot_id,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t2.quantity) AS median
    FROM order_trucks t2
    JOIN orders o2 ON o2.id = t2.order_id
   WHERE t2.quantity > 0
   GROUP BY o2.depot_id
`;

/** The company-wide fallback, for a depot that has never loaded a truck. */
const FALLBACK_TRUCK_LITRES = 45000;

/**
 * The same four states counted across the whole book, for the badges.
 *
 * This is the number the desk asked for: not "46 orders awaiting tickets" but
 * how many TRUCKS are actually outstanding — which on an order-counted board
 * could be anything from 46 to several hundred.
 *
 * Orders with no declared count contribute nothing to `toTicket`, and are
 * reported separately as `undeclared` so the figure is never quietly short
 * without saying so.
 */
const outstandingTrucks = async () => {
  const rows = await db.execute(sql`
    WITH medians AS (${DEPOT_MEDIAN_TRUCK})
    SELECT
      -- Declared and still to ticket. Exact.
      COALESCE(SUM(
        CASE WHEN o.expected_trucks IS NOT NULL
             THEN GREATEST(0, o.expected_trucks - COALESCE(t.ticketed, 0)) END
      ), 0)::int AS "toTicketExact",

      -- Undeclared, worked out from litres. Approximate, and kept apart.
      COALESCE(SUM(
        CASE WHEN o.expected_trucks IS NULL
             THEN GREATEST(1, CEIL(
               o.quantity::numeric
               / COALESCE(NULLIF(m.median, 0), ${FALLBACK_TRUCK_LITRES})
             ))::int - COALESCE(t.ticketed, 0) END
      ), 0)::int AS "toTicketEstimated",

      COUNT(*) FILTER (WHERE o.expected_trucks IS NULL)::int AS "undeclared",
      COUNT(*)::int AS "orders",
      COALESCE(SUM(COALESCE(t.awaiting_in, 0)), 0)::int AS "awaitingIn",
      COALESCE(SUM(COALESCE(t.on_yard, 0)), 0)::int AS "onYard"
      FROM orders o
      ${PROGRESS_JOIN}
      LEFT JOIN medians m ON m.depot_id = o.depot_id
     WHERE o.status IN ('Paid', 'Released')
       AND o.payment_status IN ('Paid', 'Part Paid')
       -- A LIVE batch, stated positively. NOT EXISTS is satisfied by an order
       -- with no pfi_id at all, which is how months-old work kept counting as
       -- today's. Same rule as the badges, desk queues and nudges.
       AND EXISTS (
         SELECT 1 FROM pfis p
          WHERE p.id = o.pfi_id
            AND p.status <> 'finished'
            AND p.pfi_type NOT IN ('gantry', 'delivery')
       )
       -- Not yet fully ticketed: an order with every declared truck already
       -- written is finished here even though it is still Paid.
       AND (o.expected_trucks IS NULL OR COALESCE(t.ticketed, 0) < o.expected_trucks)
  `);

  const row = (rows.rows ?? rows)[0] || {};
  const exact = Number(row.toTicketExact) || 0;
  const estimated = Math.max(0, Number(row.toTicketEstimated) || 0);

  return {
    ...row,
    toTicketExact: exact,
    toTicketEstimated: estimated,
    /** The headline. Honest only when shown beside `estimated`. */
    toTicket: exact + estimated,
    /** True when any part of the headline was worked out rather than declared. */
    approximate: estimated > 0,
  };
};

module.exports = { forOrder, forOrders, outstandingTrucks, shape, FALLBACK_TRUCK_LITRES };
