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
    orderStatuses: sql`o.status IN ('Released', 'Loading')`,
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
const buildWhere = (stage, { from, to, pfiId, depotId, search, scope }) => {
  const s = STAGES[stage];
  const parts = [
    sql`t.status IN ${s.truckStatuses}`,
    s.orderStatuses,
    // A live batch: not finished, and not a type with no gate at all.
    sql`EXISTS (
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
    if (depots.length || pfis.length) {
      const clauses = [];
      if (depots.length) clauses.push(sql`o.depot_id IN (${sql.join(depots.map((d) => sql`${d}`), sql`, `)})`);
      if (pfis.length) clauses.push(sql`o.pfi_id IN (${sql.join(pfis.map((p) => sql`${p}`), sql`, `)})`);
      parts.push(sql`(${sql.join(clauses, sql` OR `)})`);
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

  return {
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
