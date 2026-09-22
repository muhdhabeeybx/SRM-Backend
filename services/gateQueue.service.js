const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { orderReferenceSql } = require("../lib/orderReferenceSql");

/**
 * The gate's own queue: every truck it is waiting on, not one order at a time.
 *
 * Both gate pages could only be used by searching for an order, which assumes
 * the officer already knows which order the truck in front of them belongs to.
 * At the entry gate that is exactly backwards — a truck arrives and the officer
 * has a plate, not a reference — and it made the day's workload invisible.
 * Nobody could answer "how many are we still expecting" without opening orders
 * one by one.
 *
 * ── Two stages, one shape ──────────────────────────────────────────────────
 *
 * entry: ticketed, not yet admitted  (t.status = 'pending')
 * exit:  on the yard, not yet released (t.status IN 'gated_in','loaded')
 *
 * Same columns, same filters, same summary, so the two pages cannot drift into
 * describing the same truck differently.
 *
 * ── Scoped, and a live batch only ──────────────────────────────────────────
 *
 * A gate officer sees their own locations. And the queue asks for a LIVE batch
 * rather than the absence of a dead one: NOT EXISTS is satisfied by an order
 * with no pfi_id at all, which is how months-old work kept surfacing as today's
 * backlog. Same rule as the badges, the desk queues and the nudges.
 */

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

const STAGES = {
  entry: {
    truckStatuses: sql`('pending')`,
    /**
     * Dead orders only — NOT "the order must be Released or Loading".
     *
     * A ticket at `pending` means a named truck is expected at the gate, and
     * that is a fact about the TRUCK. The order's status is about the order,
     * and it moves for reasons that have nothing to do with this truck: an
     * order flips to Completed when its last truck gates OUT, so one with
     * twenty-three trucks away and forty-four never admitted is Completed
     * while forty-four are still expected. Eighty-one such trucks existed on
     * live batches when this was found, every one of them invisible to the
     * gate.
     *
     * The exit stage below already had it right. This now matches it.
     */
    orderStatuses: sql`o.status NOT IN ('Cancelled', 'Expired')`,
    /** Waiting since the ticket was written — that is when the gate starts expecting it. */
    since: sql`t.created_at`,
  },
  exit: {
    truckStatuses: sql`('gated_in', 'loaded')`,
    orderStatuses: sql`o.status NOT IN ('Cancelled', 'Expired')`,
    /** Waiting since it came through the gate, not since it was ticketed. */
    since: sql`COALESCE(t.security_entered_at, t.created_at)`,
  },
};

/**
 * The filters, shared by the list and the summary.
 *
 * Built once and handed to both so a card can never disagree with the table
 * beneath it — the commonest way a dashboard starts lying.
 */
const buildWhere = (stage, { from, to, pfiId, depotId, search, scope, includeClosed }) => {
  const s = STAGES[stage];
  const parts = [
    sql`t.status IN ${s.truckStatuses}`,
    s.orderStatuses,
    /**
     * A live batch — not finished, and not a type with no gate at all.
     *
     * ── Why `includeClosed` exists ──────────────────────────────────────
     *
     * A ticket is a commitment: somebody wrote it, and the truck it names may
     * still drive up to the gate. Closing the batch does not stop that, and a
     * gate officer who cannot SEE the truck cannot record it either — which is
     * worse than a cluttered queue, because the movement then happens with no
     * record at all.
     *
     * So closed batches are out of the default queue and the counts (they are
     * not work anybody is behind on) but reachable behind a toggle, with their
     * number shown so nobody has to guess there is something there. Today all
     * 132 of them are between 43 and 151 days old — plainly abandoned — which
     * is exactly why they should not be in the officer's face, and exactly why
     * hiding them outright would be the wrong instinct to bake in.
     *
     * Gantry and delivery batches stay excluded either way: they have no gate,
     * so no truck is ever coming.
     */
    includeClosed
      ? sql`NOT EXISTS (
          SELECT 1 FROM pfis p
           WHERE p.id = o.pfi_id AND p.pfi_type IN ('gantry', 'delivery')
        )`
      : sql`EXISTS (
          SELECT 1 FROM pfis p
           WHERE p.id = o.pfi_id
             AND p.status <> 'finished'
             AND p.pfi_type NOT IN ('gantry', 'delivery')
        )`,
  ];

  if (from) parts.push(sql`${s.since} >= ${from}::date`);
  // Inclusive of the end date: somebody filtering "to the 14th" means the whole
  // of the 14th, not up to midnight as it began.
  if (to) parts.push(sql`${s.since} < (${to}::date + interval '1 day')`);
  if (pfiId) parts.push(sql`o.pfi_id = ${Number(pfiId)}`);
  if (depotId) parts.push(sql`o.depot_id = ${Number(depotId)}`);

  if (search) {
    const q = `%${String(search).trim()}%`;
    parts.push(sql`(
      t.truck_number ILIKE ${q}
      OR o.order_number ILIKE ${q}
      OR c.name ILIKE ${q}
      OR t.driver_name ILIKE ${q}
    )`);
  }

  /**
   * Scope, as a plain fragment rather than lib/scopeFilter's Drizzle
   * conditions: this query is raw SQL over aliased joins, and the helper builds
   * column references the alias would not match. Same rule, expressed the way
   * this query can use it.
   */
  if (scope && !scope.all) {
    const depots = scope.depotIds || [];
    const pfis = scope.pfiIds || [];
    /*
      A PFI assignment is the whole answer, as lib/scopeFilter has it: it
      narrows, it is not one option among several. This used to OR it with
      depot scope, so somebody assigned to one PFI and to a depot saw every
      PFI's trucks at that depot — the opposite of what the assignment says.
    */
    if (pfis.length) {
      parts.push(sql`o.pfi_id IN (${sql.join(pfis.map((p) => sql`${p}`), sql`, `)})`);
    } else if (depots.length) {
      parts.push(sql`o.depot_id IN (${sql.join(depots.map((d) => sql`${d}`), sql`, `)})`);
    }
    // No assignments at all and not full-access: fail open rather than closed,
    // matching lib/scopeFilter. A gate officer shown nothing would assume the
    // yard was clear.
  }

  return sql.join(parts, sql` AND `);
};

/** The trucks themselves, oldest first — the gate works its queue front to back. */
const list = async (stage, opts = {}) => {
  if (!STAGES[stage]) throw new Error(`Unknown gate stage: ${stage}`);
  const s = STAGES[stage];
  const where = buildWhere(stage, opts);
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const offset = Math.max(Number(opts.page || 1) - 1, 0) * limit;

  const rows = rowsOf(await db.execute(sql`
    SELECT t.id,
           t.truck_number        AS "truckNumber",
           t.truck_index         AS "truckIndex",
           t.status              AS "truckStatus",
           t.quantity            AS "quantity",
           t.driver_name         AS "driverName",
           t.driver_phone        AS "driverPhone",
           t.security_entered_at AS "enteredAt",
           t.loaded_at           AS "loadedAt",
           o.id                  AS "orderId",
           ${orderReferenceSql("o", "c")} AS "orderNumber",
           o.status              AS "orderStatus",
           c.name                AS "customerName",
           d.id                  AS "depotId",
           d.name                AS "depotName",
           p.id                  AS "pfiId",
           p.pfi_number          AS "pfiNumber",
           pr.unit               AS "productUnit",
           ${s.since}            AS "waitingSince",
           EXTRACT(EPOCH FROM (now() - ${s.since})) / 3600 AS "hoursWaiting"
      FROM order_trucks t
      JOIN orders o        ON o.id = t.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN depots d    ON d.id = o.depot_id
      LEFT JOIN pfis p      ON p.id = o.pfi_id
      LEFT JOIN products pr ON pr.id = o.product_id
     WHERE ${where}
     ORDER BY ${s.since} ASC
     LIMIT ${limit} OFFSET ${offset}
  `));

  const [{ n } = { n: 0 }] = rowsOf(await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM order_trucks t
      JOIN orders o        ON o.id = t.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE ${where}
  `));

  return {
    trucks: rows.map((r) => ({
      ...r,
      quantity: r.quantity == null ? null : Number(r.quantity),
      hoursWaiting: Math.floor(Number(r.hoursWaiting) || 0),
    })),
    pagination: { page: Number(opts.page) || 1, limit, total: Number(n), pages: Math.ceil(Number(n) / limit) || 1 },
  };
};

/**
 * The cards above the table, computed from the SAME filters.
 *
 * Deliberately not derived from the page of rows the table happens to be
 * showing: a summary that only counts the first hundred is worse than no
 * summary, because it looks authoritative.
 */
const summary = async (stage, opts = {}) => {
  if (!STAGES[stage]) throw new Error(`Unknown gate stage: ${stage}`);
  const where = buildWhere(stage, opts);
  const s = STAGES[stage];

  const [row = {}] = rowsOf(await db.execute(sql`
    SELECT COUNT(*)::int                                   AS "trucks",
           COUNT(DISTINCT o.id)::int                       AS "orders",
           COUNT(DISTINCT o.customer_id)::int              AS "customers",
           COALESCE(SUM(t.quantity), 0)                    AS "litres",
           COALESCE(MAX(EXTRACT(EPOCH FROM (now() - ${s.since})) / 3600), 0) AS "oldestHours",
           COUNT(*) FILTER (WHERE ${s.since} < now() - interval '24 hours')::int AS "overADay"
      FROM order_trucks t
      JOIN orders o        ON o.id = t.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE ${where}
  `));

  /** Where the queue actually is, so a supervisor can see it is one depot. */
  const byDepot = rowsOf(await db.execute(sql`
    SELECT COALESCE(d.name, 'No depot on the order') AS "depotName",
           COUNT(*)::int AS "trucks"
      FROM order_trucks t
      JOIN orders o        ON o.id = t.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN depots d    ON d.id = o.depot_id
     WHERE ${where}
     GROUP BY 1
     ORDER BY 2 DESC
  `));

  /**
   * How many the default queue is leaving out, counted even while excluding
   * them — a toggle offering "show the rest" with no number beside it asks the
   * officer to click it to find out whether it was worth clicking.
   *
   * Everything the live-batch test rejects, not only closed batches: an order
   * with no pfi_id at all is excluded too, and to the person at the gate those
   * are the same fact — a ticket exists and this queue is not showing it.
   */
  const [off = {}] = rowsOf(await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM order_trucks t
      JOIN orders o        ON o.id = t.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE ${buildWhere(stage, { ...opts, includeClosed: true })}
       AND NOT EXISTS (
         SELECT 1 FROM pfis p
          WHERE p.id = o.pfi_id
            AND p.status <> 'finished'
            AND p.pfi_type NOT IN ('gantry', 'delivery')
       )
  `));

  return {
    offLiveBatches: Number(off.n || 0),
    trucks: Number(row.trucks || 0),
    orders: Number(row.orders || 0),
    customers: Number(row.customers || 0),
    litres: Number(row.litres || 0),
    oldestHours: Math.floor(Number(row.oldestHours) || 0),
    overADay: Number(row.overADay || 0),
    byDepot,
  };
};

/** The filter dropdowns, drawn from what is actually in the queue. */
const filterOptions = async (stage, opts = {}) => {
  const where = buildWhere(stage, { ...opts, from: null, to: null, pfiId: null, depotId: null, search: null });
  const rows = rowsOf(await db.execute(sql`
    SELECT DISTINCT d.id AS "depotId", d.name AS "depotName", p.id AS "pfiId", p.pfi_number AS "pfiNumber"
      FROM order_trucks t
      JOIN orders o        ON o.id = t.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN depots d    ON d.id = o.depot_id
      LEFT JOIN pfis p      ON p.id = o.pfi_id
     WHERE ${where}
  `));

  const depots = new Map();
  const pfis = new Map();
  for (const r of rows) {
    if (r.depotId) depots.set(r.depotId, r.depotName);
    if (r.pfiId) pfis.set(r.pfiId, r.pfiNumber);
  }
  return {
    depots: [...depots].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    pfis: [...pfis].map(([id, pfiNumber]) => ({ id, pfiNumber })).sort((a, b) => a.pfiNumber.localeCompare(b.pfiNumber)),
  };
};

const forStage = async (stage, opts) => {
  const [rows, cards, options] = await Promise.all([
    list(stage, opts),
    summary(stage, opts),
    filterOptions(stage, opts),
  ]);
  return { stage, ...rows, summary: cards, options };
};

module.exports = { forStage, list, summary, filterOptions, STAGES };
