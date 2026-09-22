const { eq, and, or, ilike, desc, count, ne, gte, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { customers, orders } = require("../db/schema");
const { normalizedKey } = require("../utils/phone");

const findById = async (id, tx = db) => {
  const [row] = await tx.select().from(customers).where(eq(customers.id, id)).limit(1);
  return row || null;
};

const findByPhone = async (phone) => {
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.phone, phone))
    .limit(1);
  return row || null;
};

/**
 * The customer this number reaches — primary OR any alternate on file.
 *
 * This is the login lookup. `findByPhone` above compares `customers.phone`
 * exactly, which is right for "is this exact string taken?" but wrong for
 * "who is signing in?": a customer with three numbers on the account can only
 * be found by one of them, so the other two dead-end at "no such account"
 * despite being numbers the desk deliberately recorded as theirs.
 *
 * Matched on the last ten digits rather than the raw string, so the caller
 * gets the same answer whichever way the number was typed — the two tables
 * generate that key identically (migrations 0016 and 0019) and both index it.
 *
 * Returns the customer plus HOW it was matched, because the caller usually
 * needs to know: an OTP must go to the number that was typed, not to the
 * primary, or a customer signing in on their second line never receives a
 * code and has no way to tell why.
 *
 * @param {string} phone any format
 * @returns {Promise<{customer: object, matchedPhone: string, isPrimary: boolean}|null>}
 */
const findByAnyPhone = async (phone) => {
  const key = normalizedKey(phone);
  if (!key) return null;

  // One statement rather than "try the primary, then try the alternates":
  // two round trips on the hot path of every login, and a second chance to
  // get the ordering wrong. The primary sorts first so an account that
  // somehow holds the number both ways resolves to the primary, which is the
  // record the rest of the system reads.
  const result = await db.execute(sql`
    SELECT c.id, c.phone AS "matchedPhone", true AS "isPrimary", 0 AS rank
    FROM customers c
    WHERE c.phone_normalized = ${key}

    UNION ALL

    SELECT cp.customer_id, cp.phone, false, 1
    FROM customer_phones cp
    WHERE cp.phone_normalized = ${key}

    ORDER BY rank
    LIMIT 1
  `);
  const row = (result.rows ?? result)[0];
  if (!row) return null;

  const customer = await findById(Number(row.id));
  if (!customer) return null;
  return {
    customer,
    matchedPhone: row.matchedPhone,
    isPrimary: Boolean(row.isPrimary),
  };
};

const findByEmail = async (email) => {
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.email, email.toLowerCase()))
    .limit(1);
  return row || null;
};

const findByVirtualAccount = async (accountNumber) => {
  if (!accountNumber) return null;
  const cleanAcc = String(accountNumber).trim();
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.virtualAccountNumber, cleanAcc))
    .limit(1);
  return row || null;
};

const findByPaystackCustomerId = async (customerCode) => {
  if (!customerCode) return null;
  const cleanCode = String(customerCode).trim();
  const [row] = await db
    .select()
    .from(customers)
    .where(eq(customers.paystackCustomerId, cleanCode))
    .limit(1);
  return row || null;
};

/**
 * How recently a customer has ordered, as a band rather than a raw count.
 *
 * The customers page sorts on activity by default and filters on these, so
 * the thresholds live here — one definition the list, the filter and the
 * summary counts all read, instead of three that drift.
 *
 * "dormant" deliberately means ordered-before-but-not-lately, and is kept
 * apart from "never": a customer who bought for two years and stopped is a
 * different problem from one who has never bought at all, and lumping them
 * together hides the first behind the second.
 */
const ACTIVITY_WINDOW_DAYS = 90;
const FREQUENT_MIN_ORDERS = 3;

const ACTIVITY_SQL = {
  frequent: sql`s.orders_recent >= ${FREQUENT_MIN_ORDERS}`,
  occasional: sql`s.orders_recent BETWEEN 1 AND ${FREQUENT_MIN_ORDERS - 1}`,
  dormant: sql`COALESCE(s.order_count, 0) > 0 AND COALESCE(s.orders_recent, 0) = 0`,
  never: sql`COALESCE(s.order_count, 0) = 0`,
};

/**
 * Sort orders, whitelisted.
 *
 * The key arrives from a query string, so it selects one of these rather than
 * being interpolated — a sort parameter is the classic way an ORDER BY turns
 * into an injection point.
 *
 * NULLS LAST throughout: a customer who has never ordered has no last-order
 * date and no spend, and Postgres sorts NULL highest on DESC, which would put
 * exactly the least interesting rows at the top of every list.
 */
const SORTS = {
  active: sql`s.orders_recent DESC NULLS LAST, s.order_count DESC NULLS LAST, s.last_order_at DESC NULLS LAST`,
  recent: sql`s.last_order_at DESC NULLS LAST`,
  spend: sql`s.lifetime_value DESC NULLS LAST`,
  balance: sql`c.balance::numeric DESC`,
  name: sql`c.name ASC`,
  newest: sql`c.created_at DESC`,
};

/**
 * The customer list, each row carrying how that customer actually trades.
 *
 * Order history is aggregated once in a CTE and joined, rather than fetched
 * per row: the page shows order count, last order, lifetime value and the
 * depot someone buys from most, and asking for those one customer at a time
 * is 1,300 round trips to render one screen.
 *
 * `summary` is computed over the same WHERE clause as the rows, so the cards
 * describe the filter in view rather than the whole table — a filtered list
 * whose totals silently still describe everything is worse than no totals.
 */
const findAll = async ({
  search,
  searchType,
  status,
  depotId,
  activity,
  hasBalance,
  optedOut,
  sort = "active",
  page = 1,
  limit = 50,
  /**
   * Only customers with at least one order on these PFIs — what staff
   * assigned to a PFI may browse. Null for everyone. See lib/pfiScope.js.
   */
  onlyPfiIds = null,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(5000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const where = [];

  if (Array.isArray(onlyPfiIds)) {
    where.push(
      onlyPfiIds.length
        ? sql`EXISTS (SELECT 1 FROM orders op WHERE op.customer_id = c.id
                        AND op.pfi_id IN (${sql.join(onlyPfiIds.map((id) => sql`${Number(id)}`), sql`, `)}))`
        : sql`false`,
    );
  }

  if (search) {
    const pattern = `%${search}%`;
    if (searchType === "email") where.push(sql`c.email ILIKE ${pattern}`);
    else if (searchType === "phone") where.push(sql`c.phone ILIKE ${pattern}`);
    else if (searchType === "companyName") where.push(sql`c.company_name ILIKE ${pattern}`);
    else
      where.push(
        sql`(c.name ILIKE ${pattern} OR c.email ILIKE ${pattern} OR c.phone ILIKE ${pattern} OR c.company_name ILIKE ${pattern})`
      );
  }

  if (status && status !== "all") where.push(sql`c.status = ${status}`);

  // The depot a customer has actually bought from — any of them, not just the
  // one they use most. Filtering on the primary depot alone would drop a
  // customer from their own second location's list.
  if (depotId) {
    where.push(
      sql`EXISTS (SELECT 1 FROM orders o2 WHERE o2.customer_id = c.id AND o2.depot_id = ${Number(depotId)})`
    );
  }

  if (activity && ACTIVITY_SQL[activity]) where.push(ACTIVITY_SQL[activity]);
  if (hasBalance === "yes") where.push(sql`c.balance::numeric > 0`);
  if (hasBalance === "no") where.push(sql`c.balance::numeric <= 0`);
  if (optedOut === "yes") where.push(sql`c.marketing_opt_out = true`);
  if (optedOut === "no") where.push(sql`c.marketing_opt_out = false`);

  const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
  const orderBySql = SORTS[sort] || SORTS.active;

  // One CTE, reused by both the page query and the summary, so the two can
  // never disagree about what a customer's history is.
  const statsCte = sql`
    WITH stats AS (
      SELECT
        o.customer_id,
        COUNT(*)::int AS order_count,
        COUNT(*) FILTER (
          WHERE o.created_at >= now() - (${ACTIVITY_WINDOW_DAYS} || ' days')::interval
        )::int AS orders_recent,
        COUNT(*) FILTER (WHERE o.created_at >= date_trunc('month', now()))::int AS orders_this_month,
        MAX(o.created_at) AS last_order_at,
        MIN(o.created_at) AS first_order_at,
        -- Paid only: an unpaid or cancelled order is not revenue, and a
        -- lifetime-value column that counts them overstates every customer
        -- who ever abandoned one.
        COALESCE(SUM(o.total_amount::numeric) FILTER (WHERE o.payment_status = 'Paid'), 0)::float AS lifetime_value,
        MODE() WITHIN GROUP (ORDER BY o.depot_id) AS primary_depot_id
      FROM orders o
      GROUP BY o.customer_id
    )
  `;

  const [rowsResult, summaryResult] = await Promise.all([
    db.execute(sql`
      ${statsCte}
      SELECT
        c.*,
        COALESCE(s.order_count, 0) AS "orderCount",
        COALESCE(s.orders_recent, 0) AS "ordersRecent",
        COALESCE(s.orders_this_month, 0) AS "ordersThisMonth",
        s.last_order_at AS "lastOrderAt",
        s.first_order_at AS "firstOrderAt",
        COALESCE(s.lifetime_value, 0) AS "lifetimeValue",
        d.name AS "primaryDepotName",
        d.state AS "primaryDepotState",
        s.primary_depot_id AS "primaryDepotId",
        CASE
          WHEN COALESCE(s.order_count, 0) = 0 THEN 'never'
          WHEN COALESCE(s.orders_recent, 0) >= ${FREQUENT_MIN_ORDERS} THEN 'frequent'
          WHEN COALESCE(s.orders_recent, 0) >= 1 THEN 'occasional'
          ELSE 'dormant'
        END AS "activityBand"
      FROM customers c
      LEFT JOIN stats s ON s.customer_id = c.id
      LEFT JOIN depots d ON d.id = s.primary_depot_id
      ${whereSql}
      ORDER BY ${orderBySql}
      LIMIT ${limitNum} OFFSET ${offset}
    `),
    db.execute(sql`
      ${statsCte}
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE c.status = 'Active')::int AS active,
        COUNT(*) FILTER (WHERE c.status = 'Inactive')::int AS inactive,
        COALESCE(SUM(c.balance::numeric), 0)::float AS "totalBalance",
        COALESCE(SUM(s.lifetime_value), 0)::float AS "lifetimeRevenue",
        COUNT(*) FILTER (WHERE COALESCE(s.orders_this_month, 0) > 0)::int AS "orderedThisMonth",
        COUNT(*) FILTER (WHERE c.created_at >= date_trunc('month', now()))::int AS "newThisMonth",
        COUNT(*) FILTER (WHERE COALESCE(s.orders_recent, 0) >= ${FREQUENT_MIN_ORDERS})::int AS frequent,
        COUNT(*) FILTER (WHERE COALESCE(s.order_count, 0) > 0 AND COALESCE(s.orders_recent, 0) = 0)::int AS dormant,
        COUNT(*) FILTER (WHERE COALESCE(s.order_count, 0) = 0)::int AS never,
        COUNT(*) FILTER (WHERE c.marketing_opt_out = true)::int AS "optedOut",
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(c.phone, ''), NULL) IS NOT NULL)::int AS "withPhone"
      FROM customers c
      LEFT JOIN stats s ON s.customer_id = c.id
      ${whereSql}
    `),
  ]);

  const rows = rowsResult.rows ?? rowsResult;
  const summary = (summaryResult.rows ?? summaryResult)[0] || {};
  const total = Number(summary.total || 0);

  return {
    customers: rows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum) || 1,
    },
    summary: {
      total,
      active: Number(summary.active || 0),
      inactive: Number(summary.inactive || 0),
      totalBalance: Number(summary.totalBalance || 0),
      lifetimeRevenue: Number(summary.lifetimeRevenue || 0),
      orderedThisMonth: Number(summary.orderedThisMonth || 0),
      newThisMonth: Number(summary.newThisMonth || 0),
      frequent: Number(summary.frequent || 0),
      dormant: Number(summary.dormant || 0),
      never: Number(summary.never || 0),
      optedOut: Number(summary.optedOut || 0),
      withPhone: Number(summary.withPhone || 0),
    },
  };
};

const create = async (data) => {
  const [row] = await db.insert(customers).values(data).returning();
  return row;
};

const update = async (id, data, tx = db) => {
  const [row] = await tx
    .update(customers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(customers.id, id))
    .returning();
  return row || null;
};

// These two are the only functions in this repository that touch
// customers.balance. Nothing else in the codebase should call them directly
// for a business transaction — services/wallet.service.js is the intended
// caller, because every business debit/credit must also write a ledger
// (deposits) row, and it pairs both writes in one db.transaction() by passing
// its own `tx` through. Calling these bare, without a paired ledger entry, is
// how balances and the ledger drift apart — that is the whole reason a
// dedicated wallet service exists instead of ad hoc balance writes at call
// sites across the codebase.

/**
 * Add to a customer's balance. Credits only — the amount must be positive.
 *
 * Split from debiting deliberately. A single signed `updateBalance` reads as
 * symmetric, but the two directions have different safety requirements: a
 * credit can never overdraw, a debit can. Sharing one function is how the
 * guard came to be missing from the debit path.
 */
const creditBalance = async (id, amount, tx = db) => {
  if (!(Number(amount) > 0)) {
    throw new RangeError(`creditBalance: amount must be positive, got ${amount}`);
  }
  const [row] = await tx
    .update(customers)
    .set({
      balance: sql`${customers.balance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, id))
    .returning();
  return row || null;
};

/**
 * Subtract from a customer's balance, refusing to overdraw.
 *
 * The guard is in the `WHERE`, not in a preceding read. Checking the balance
 * in the caller and then debiting is a time-of-check/time-of-use race: two
 * concurrent orders both read the same balance, both pass, both debit, and the
 * account ends up negative with two paid orders and two tickets.
 *
 * Returns null when the balance does not cover the amount — callers MUST
 * branch on that rather than assuming success. This is the same shape as
 * pfiRepo.reserveStock, which has always guarded correctly; the pattern
 * existed in this codebase and was simply never applied to money.
 *
 * @param {number} amount  positive magnitude to subtract
 * @returns {object|null}  the updated row, or null if funds were insufficient
 */
const debitBalance = async (id, amount, tx = db) => {
  if (!(Number(amount) > 0)) {
    throw new RangeError(`debitBalance: amount must be positive, got ${amount}`);
  }
  const [row] = await tx
    .update(customers)
    .set({
      balance: sql`${customers.balance} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, id), gte(customers.balance, String(amount))))
    .returning();
  return row || null;
};

/**
 * Every customer holding money, for the settlement sweep.
 *
 * Deliberately NOT findAll({ limit }): that clamps to 100 and orders by
 * created_at DESC, so the sweep silently considered only the hundred most
 * recently created customers. Anyone older with a balance was never settled —
 * their money sat in the wallet, their order stayed unpaid, and nothing logged
 * a discrepancy because the loop believed it had processed everyone it was
 * given.
 *
 * Filtering in SQL removes the pagination question entirely rather than
 * raising a limit that would drift out of date again.
 */
const findWithPositiveBalance = async () => {
  return db
    .select({ id: customers.id, balance: customers.balance })
    .from(customers)
    .where(sql`${customers.balance} > 0`)
    .orderBy(customers.id);
};

const deleteById = async (id) => {
  const [row] = await db.delete(customers).where(eq(customers.id, id)).returning();
  return row || null;
};

const existsByPhone = async (phone, excludeId = null) => {
  const conditions = [eq(customers.phone, phone)];
  if (excludeId) {
    conditions.push(ne(customers.id, excludeId));
  }
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(...conditions))
    .limit(1);
  return !!row;
};

const existsByEmail = async (email, excludeId = null) => {
  const conditions = [eq(customers.email, email.toLowerCase())];
  if (excludeId) {
    conditions.push(ne(customers.id, excludeId));
  }
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(...conditions))
    .limit(1);
  return !!row;
};

/**
 * Resolve a messaging audience — every filter is optional and independent
 * (AND'd together); with none supplied this is just "every reachable active
 * customer." Always excludes marketing_opt_out (staff-set suppression) unless
 * a caller explicitly opts out of that, which nothing currently does.
 *
 * Returns up to `limit` rows plus the TRUE matching count, so a segment
 * larger than the cap still shows an honest recipient number in the preview
 * — the caller (messaging page) fetches the full id list separately/in
 * batches when it actually sends, rather than this being the send path.
 */
const findForSegment = async ({
  depotId,
  minOrders,
  sinceDays,
  inactiveSinceDays,
  excludeOptedOut = true,
  limit = 5000,
} = {}) => {
  const conditions = [eq(customers.status, "Active")];
  if (excludeOptedOut) conditions.push(eq(customers.marketingOptOut, false));

  if (depotId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = ${customers.id} AND ${orders.depotId} = ${Number(depotId)})`
    );
  }

  if (minOrders && sinceDays) {
    const since = new Date(Date.now() - Number(sinceDays) * 24 * 60 * 60 * 1000).toISOString();
    conditions.push(
      sql`(SELECT COUNT(*) FROM ${orders} WHERE ${orders.customerId} = ${customers.id} AND ${orders.createdAt} >= ${since}) >= ${Number(minOrders)}`
    );
  }

  if (inactiveSinceDays) {
    const since = new Date(Date.now() - Number(inactiveSinceDays) * 24 * 60 * 60 * 1000).toISOString();
    // Also true for a customer who has never ordered — "inactive" includes
    // "never active" rather than excluding it.
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.customerId} = ${customers.id} AND ${orders.createdAt} >= ${since})`
    );
  }

  const whereClause = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, phone: customers.phone, email: customers.email, companyName: customers.companyName })
      .from(customers)
      .where(whereClause)
      .orderBy(customers.id)
      .limit(Math.min(5000, Math.max(1, Number(limit) || 5000))),
    db.select({ total: count() }).from(customers).where(whereClause),
  ]);

  return { customers: rows, count: Number(total) };
};

module.exports = {
  findById,
  findByPhone,
  findByAnyPhone,
  findByEmail,
  findByVirtualAccount,
  findByPaystackCustomerId,
  findAll,
  create,
  update,
  creditBalance,
  debitBalance,
  findWithPositiveBalance,
  findForSegment,
  deleteById,
  existsByPhone,
  existsByEmail,
};
