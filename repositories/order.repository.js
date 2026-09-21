const { eq, and, or, ilike, inArray, notInArray, desc, asc, count, sql, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const {
  orders, customers, depots, products, pfis, orderTrucks,
} = require("../db/schema");
const {
  CONFIRMATION_BASIS,
  CONFIRMATION_BASIS_LABEL,
  VERIFIABLE_BASES,
  SYSTEM_DECIDED_BASES,
} = require("../db/schema/orderPayment");
const { generateOrderReference, parseOrderReference } = require("../utils/helpers");
const { orderReferenceSql } = require("../lib/orderReferenceSql");
const { scopeCondition } = require("../lib/scopeFilter");

/** The two payment sources that are a movement between orders, not money in. */
const TRANSFER_SOURCES = new Set(["transfer_in", "transfer_out"]);

/**
 * Weakest-first. An order is only as auditable as its least defensible payment,
 * so the order-level basis is the worst one on it — a ₦500m order confirmed
 * from a bank statement plus one ₦20,000 row nobody can account for is not a
 * clean order, and ranking the other way round would let the good row hide the
 * bad one.
 */
const BASIS_RANK = [
  CONFIRMATION_BASIS.UNKNOWN,
  CONFIRMATION_BASIS.NO_RECORD,
  CONFIRMATION_BASIS.AUTO_ALLOCATED,
  CONFIRMATION_BASIS.TRANSFER_AUTO,
  CONFIRMATION_BASIS.BANK_INFERRED,
  CONFIRMATION_BASIS.TRANSFER_DESK,
  CONFIRMATION_BASIS.BANK_MATCHED,
];

const weakestBasis = (rows) => {
  if (!rows.length) return null;
  let worst = null;
  let worstRank = Infinity;
  for (const r of rows) {
    const rank = BASIS_RANK.indexOf(r.confirmationBasis);
    // An unrecognised value sorts worst: a basis this code does not know how
    // to vouch for must never be presented as though it were clean.
    const effective = rank === -1 ? -1 : rank;
    if (effective < worstRank) {
      worstRank = effective;
      worst = r.confirmationBasis;
    }
  }
  return worst;
};

const formatOrderRow = (row) => {
  if (!row) return null;
  const company = row.companyName || row.customerCompanyName || "";
  const ref = generateOrderReference(company, row.id);
  return {
    ...row,
    orderNumber: ref,
    reference: ref,
  };
};

const findById = async (id, tx = db) => {
  const [row] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1);
  return formatOrderRow(row);
};

/**
 * Row-lock an order for the caller's transaction. The gate flow uses this to
 * serialise concurrent truck actions on one order: two trucks gating in (or
 * out) at the same moment each take this lock in turn, so exactly one observes
 * the "first in" / "last out" edge and drives the Released→Loading / Loading→
 * Completed transition — the other sees the already-moved status and skips it.
 */
const lockById = async (id, tx = db) => {
  const [row] = await tx.select().from(orders).where(eq(orders.id, id)).for("update").limit(1);
  return formatOrderRow(row);
};

/**
 * The idempotent-replay lookup: a caller retrying with the same key (e.g. a
 * redelivered WhatsApp webhook re-running CONFIRM) finds the order the first
 * attempt created.
 */
const findByIdempotencyKey = async (idempotencyKey, tx = db) => {
  const [row] = await tx
    .select()
    .from(orders)
    .where(eq(orders.idempotencyKey, idempotencyKey))
    .limit(1);
  return formatOrderRow(row);
};

/**
 * The same order from the same customer, moments ago.
 *
 * A double-tap guard that depends on nothing the client sends: the portal and
 * the app send no idempotency key at all, and a client that generates a fresh
 * key per attempt defeats one anyway. So this matches on what the order IS.
 *
 * Only live orders count. An order the customer cancelled, or one that
 * expired, is not something they are about to be given again — and refusing
 * to let somebody re-place an order they just cancelled would be its own bug.
 *
 * Newest first: if several slipped through before this existed, the one they
 * would have been shown is the most recent.
 */
const findRecentDuplicate = async ({
  customerId, depotId, productId, quantity, deliveryType, withinSeconds = 90,
}) => {
  if (!customerId || !depotId || !productId) return null;

  const [row] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.customerId, Number(customerId)),
        eq(orders.depotId, Number(depotId)),
        eq(orders.productId, Number(productId)),
        eq(orders.quantity, Number(quantity)),
        deliveryType ? eq(orders.deliveryType, deliveryType) : undefined,
        notInArray(orders.status, ["Cancelled", "Expired"]),
        sql`${orders.createdAt} > now() - (${Number(withinSeconds)} * interval '1 second')`,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(1);

  return formatOrderRow(row);
};

const findByNumber = async (orderNumber) => {
  const normalized = String(orderNumber || "").trim().toUpperCase();
  if (!normalized) return null;

  // Resolves "SO600" and the legacy "SO/600" alike — see parseOrderReference.
  const possibleId = parseOrderReference(normalized);

  let row = null;
  if (possibleId) {
    [row] = await db.select().from(orders).where(eq(orders.id, possibleId)).limit(1);
  }
  if (!row) {
    [row] = await db.select().from(orders).where(eq(orders.orderNumber, normalized)).limit(1);
  }
  return formatOrderRow(row);
};

// The joined columns a full order detail carries. Includes the per-stage
// lifecycle timestamps and cancellation reason so callers can render the
// order's own timeline without the public tracking endpoint — those columns
// (order.js) are the source of truth for tracking, reused here behind auth.
const FULL_ORDER_COLUMNS = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  customerId: orders.customerId,
  state: orders.state,
  depotId: orders.depotId,
  productId: orders.productId,
  quantity: orders.quantity,
  /** The denominator for "truck 2 of 6" — see the column note on orders. */
  expectedTrucks: orders.expectedTrucks,
  /**
   * Where this order's trucks have got to, on the order row itself.
   *
   * Four correlated counts rather than a join, for the reason the payments
   * query gives: an order with six trucks would otherwise multiply into six
   * order rows. They are cheap — order_trucks is indexed on order_id — and
   * having them here is what lets a list say "3 of 6 ticketed, 1 loaded"
   * without a second request per row.
   */
  trucksTicketed: sql`(
    SELECT COUNT(*)::int FROM order_trucks t WHERE t.order_id = ${orders.id}
  )`,
  trucksAwaitingIn: sql`(
    SELECT COUNT(*)::int FROM order_trucks t
     WHERE t.order_id = ${orders.id} AND t.status = 'pending'
  )`,
  trucksOnYard: sql`(
    SELECT COUNT(*)::int FROM order_trucks t
     WHERE t.order_id = ${orders.id} AND t.status IN ('gated_in', 'loaded')
  )`,
  trucksOut: sql`(
    SELECT COUNT(*)::int FROM order_trucks t
     WHERE t.order_id = ${orders.id} AND t.status = 'gated_out'
  )`,
  price: orders.price,
  totalAmount: orders.totalAmount,
  // What has actually been received against the order, across however many
  // instalments. Equal to totalAmount on a fully-paid order; the difference is
  // the balance still expected on a part-paid one.
  amountPaid: orders.amountPaid,
  /**
   * The authorised-on-credit allowance, and who gave it.
   *
   * These have to be in this projection, not merely on the table:
   * releasableQuantity() reads creditQty off whatever row it is handed, and
   * this is the row every read path hands it — GET /orders/:id, the order page,
   * the ticketing desk. Omitted, an order authorised for 30,000 reads back as
   * releasing zero, and the desk is told to refuse a truck somebody was
   * explicitly told to load. That is not hypothetical; the tests caught it.
   */
  creditQty: orders.creditQty,
  creditReason: orders.creditReason,
  creditAuthorisedBy: orders.creditAuthorisedBy,
  creditAuthorisedAt: orders.creditAuthorisedAt,
  creditAuthorisedByName: sql`(
    SELECT NULLIF(TRIM(CONCAT(s.first_name, ' ', s.surname)), '')
      FROM staff s WHERE s.id = ${orders.creditAuthorisedBy}
  )`,
  deliveryType: orders.deliveryType,
  deliveryAddress: orders.deliveryAddress,
  companyName: orders.companyName,
  pfiId: orders.pfiId,
  virtualAccountNumber: orders.virtualAccountNumber,
  virtualAccountBank: orders.virtualAccountBank,
  virtualAccountName: orders.virtualAccountName,
  paymentStatus: orders.paymentStatus,
  status: orders.status,
  // Per-stage lifecycle stamps — one timestamp per stage, reached at most once.
  paymentConfirmedAt: orders.paymentConfirmedAt,
  releasedAt: orders.releasedAt,
  loadingStartedAt: orders.loadingStartedAt,
  completedAt: orders.completedAt,
  cancelledAt: orders.cancelledAt,
  cancellationReason: orders.cancellationReason,
  expiredAt: orders.expiredAt,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
  // Customer fields
  customerName: customers.name,
  customerEmail: customers.email,
  customerPhone: customers.phone,
  customerCompanyName: customers.companyName,
  customerBalance: customers.balance,
  customerVirtualAccountName: customers.virtualAccountName,
  // Depot fields
  depotName: depots.name,
  depotCode: depots.code,
  depotAddress: depots.address,
  // Product fields
  productName: products.name,
  productSku: products.sku,
  productUnit: products.unit,
  productCategory: products.category,
  // PFI fields
  pfiNumber: pfis.pfiNumber,
};

const fullOrderQuery = (tx = db) =>
  tx
    .select(FULL_ORDER_COLUMNS)
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(depots, eq(orders.depotId, depots.id))
    .leftJoin(products, eq(orders.productId, products.id))
    .leftJoin(pfis, eq(orders.pfiId, pfis.id));

const findByIdFull = async (id, tx = db) => {
  const [row] = await fullOrderQuery(tx).where(eq(orders.id, id)).limit(1);
  return formatOrderRow(row);
};

/**
 * The same full detail keyed by order number rather than numeric id. Serves
 * the customer portal's by-reference lookup: the reference (order number) is
 * the id every screen and SMS shows, so the customer can open an order by the
 * value they hold without first resolving it to a database id. Normalised the
 * same way tracking does — trimmed and upper-cased.
 */
const findByNumberFull = async (orderNumber, tx = db) => {
  const normalized = String(orderNumber || "").trim().toUpperCase();
  if (!normalized) return null;

  const possibleId = parseOrderReference(normalized);

  let row = null;
  if (possibleId) {
    [row] = await fullOrderQuery(tx).where(eq(orders.id, possibleId)).limit(1);
  }
  if (!row) {
    [row] = await fullOrderQuery(tx)
      .where(eq(orders.orderNumber, normalized))
      .limit(1);
  }
  return formatOrderRow(row);
};

/**
 * The truck loads on an order, oldest ordinal first. Carries the plate, the
 * per-load quantity, movement status and gate stamps, plus driver contact —
 * safe here because this is the order owner's own view behind auth (unlike the
 * public tracking feed, which withholds driver details).
 */
const findTrucksByOrderId = async (orderId, tx = db) => {
  return tx
    .select({
      truckIndex: orderTrucks.truckIndex,
      truckNumber: orderTrucks.truckNumber,
      quantity: orderTrucks.quantity,
      status: orderTrucks.status,
      driverName: orderTrucks.driverName,
      driverPhone: orderTrucks.driverPhone,
      securityEnteredAt: orderTrucks.securityEnteredAt,
      loadedAt: orderTrucks.loadedAt,
      securityExitedAt: orderTrucks.securityExitedAt,
    })
    .from(orderTrucks)
    .where(eq(orderTrucks.orderId, orderId))
    .orderBy(asc(orderTrucks.truckIndex));
};

const findAll = async ({
  search,
  status,
  customer,
  depot,
  dateFrom,
  dateTo,
  /** Same rule findPayableOrders uses — see the condition below. */
  payable,
  /** The authenticated caller, for location/PFI scoping. Omitted = unfiltered (internal callers). */
  scopeUser,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  const scope = scopeCondition(scopeUser, { depotColumn: orders.depotId, pfiColumn: orders.pfiId });
  if (scope) conditions.push(scope);

  if (search) {
    // A reference-shaped search ("SO600", or the legacy "SO/600") also matches
    // on id, since the reference is computed and not a column to search.
    const possibleId = parseOrderReference(search);
    if (possibleId) {
      conditions.push(or(ilike(orders.orderNumber, `%${search}%`), eq(orders.id, possibleId)));
    } else {
      conditions.push(ilike(orders.orderNumber, `%${search}%`));
    }
  }

  if (status) {
    conditions.push(eq(orders.status, status));
  }

  if (customer) {
    conditions.push(eq(orders.customerId, Number(customer)));
  }

  if (depot) {
    conditions.push(eq(orders.depotId, Number(depot)));
  }

  if (dateFrom) {
    conditions.push(gte(orders.createdAt, new Date(dateFrom)));
  }

  // "Payable" is not a status — it is an unpaid, pending order, i.e. one the
  // finance desk can still confirm a payment against. Expressed here so the
  // main list can show them alongside everything else rather than needing a
  // separate page.
  //
  // It used to additionally require the customer's wallet balance to cover the
  // order. That test went with the wallet payment path (see
  // findPayableOrders): balances are frozen now, so it would have filtered
  // this down to nothing.
  if (payable === true || payable === "true" || payable === "1") {
    conditions.push(eq(orders.paymentStatus, "Unpaid"));
    conditions.push(eq(orders.status, "Pending"));
  }

  if (dateTo) {
    // Inclusive of the whole day: a bare "2026-08-06" parses as that date's
    // UTC midnight, so comparing createdAt against it as-is excluded every
    // order placed later that same day — a caller asking for "today" got
    // nothing. Built as an explicit UTC string, same as dateFrom above, so
    // the two boundaries don't drift against each other by the server's
    // local timezone.
    const end = /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? `${dateTo}T23:59:59.999Z` : dateTo;
    conditions.push(lte(orders.createdAt, new Date(end)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerId: orders.customerId,
        state: orders.state,
        depotId: orders.depotId,
        productId: orders.productId,
        quantity: orders.quantity,
        /**
         * The truck picture, on the row.
         *
         * Correlated counts rather than a join — an order with six trucks
         * would otherwise multiply into six order rows, the same shape that
         * made the old payments query double-count. Cheap: order_trucks is
         * indexed on order_id. Having them here is what lets a list say
         * "3 of 6 ticketed, 1 loaded" without a request per row.
         */
        expectedTrucks: orders.expectedTrucks,
        trucksTicketed: sql`(SELECT COUNT(*)::int FROM order_trucks t WHERE t.order_id = ${orders.id})`,
        trucksAwaitingIn: sql`(SELECT COUNT(*)::int FROM order_trucks t WHERE t.order_id = ${orders.id} AND t.status = 'pending')`,
        trucksOnYard: sql`(SELECT COUNT(*)::int FROM order_trucks t WHERE t.order_id = ${orders.id} AND t.status IN ('gated_in','loaded'))`,
        trucksOut: sql`(SELECT COUNT(*)::int FROM order_trucks t WHERE t.order_id = ${orders.id} AND t.status = 'gated_out')`,
        price: orders.price,
        totalAmount: orders.totalAmount,
        deliveryType: orders.deliveryType,
        deliveryAddress: orders.deliveryAddress,
        companyName: orders.companyName,
        pfiId: orders.pfiId,
        virtualAccountNumber: orders.virtualAccountNumber,
        virtualAccountBank: orders.virtualAccountBank,
        virtualAccountName: orders.virtualAccountName,
        paymentStatus: orders.paymentStatus,
        /**
         * The allowance, on the list row.
         *
         * Needed so the Owing chip fires on an order released on credit that
         * has not loaded yet. Without it the list and the receivables page
         * disagree about the same order — the page counts it as exposure from
         * the moment it is authorised, the list would wait for a truck to move
         * — and two screens contradicting each other about who owes money is
         * worse than either one being silent.
         */
        creditQty: orders.creditQty,
        status: orders.status,
        expiredAt: orders.expiredAt,
        /**
         * The lifecycle timestamps, which the list was not returning.
         *
         * The Loading Tickets page has a "Date Loaded" column reading
         * `loadingStartedAt`, and the field was never in this select — so the
         * column rendered a dash on every row of a page whose whole subject is
         * loading, while 4,442 orders had the date recorded perfectly well.
         * releasedAt and completedAt go in beside it: same omission, same
         * reason somebody will reach for them next.
         */
        releasedAt: orders.releasedAt,
        loadingStartedAt: orders.loadingStartedAt,
        completedAt: orders.completedAt,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        customerName: customers.name,
        customerCompanyName: customers.companyName,
        customerEmail: customers.email,
        customerPhone: customers.phone,
        customerBalance: customers.balance,
        depotName: depots.name,
        depotCode: depots.code,
        productName: products.name,
        productSku: products.sku,
        productCategory: products.category,
        productUnit: products.unit,
        pfiNumber: pfis.pfiNumber,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(depots, eq(orders.depotId, depots.id))
      .leftJoin(products, eq(orders.productId, products.id))
      .leftJoin(pfis, eq(orders.pfiId, pfis.id))
      .where(whereClause)
      .orderBy(desc(orders.createdAt))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(orders)
      .where(whereClause),
  ]);

  return {
    orders: rows.map(formatOrderRow),
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

/**
 * Where each of these customers stands overall — the whole book, not the
 * window the report is filtered to.
 *
 * The report answers "what happened in this period". It cannot answer the
 * question the desk asks straight afterwards: this customer overpaid on that
 * PFI in August, is that money still sitting there or has it been used? A
 * period-scoped figure cannot say, because the order that consumed the
 * surplus is usually outside the period.
 *
 * So this is deliberately date-free and filter-free: every order the customer
 * has ever had money on, whatever PFI, depot or product it was for. One
 * number per customer that means the same thing on every report.
 *
 * ── Why it moves on its own ────────────────────────────────────────────────
 *
 * `received` here is every payment row on the order, transfer legs included
 * and signed — the same sum `balance` uses on the rows above. So when the
 * desk moves surplus off order A onto order B, A's overpayment and B's
 * shortfall both fall out of these totals in the same instant, with nothing
 * to recompute or re-run. The figure tracks the transfers by construction.
 *
 * ── Why over and under are not netted ──────────────────────────────────────
 *
 * A customer ₦5m over on one order and ₦5m under on another is two problems,
 * not zero problems — the same reasoning as `totalSurplus`/`totalShortfall`
 * in the totals query. Both are returned, plus the net, and the report prints
 * all three so netting is the reader's choice rather than the query's.
 *
 * Only orders money has actually landed on count (Paid and Part Paid), which
 * is this report's own meaning of a payment throughout. An untouched Unpaid
 * order is not an underpayment, it is an order awaiting payment, and counting
 * its full value here would bury the real differentials under the order book.
 *
 * Scoped the same way as the rest of the report: a depot- or PFI-scoped user
 * sees these customers' position across what they are allowed to see, and a
 * full-access finance user — who this block is for — sees the whole book.
 */
const findCustomerDifferentials = async (customerIds, scopeUser) => {
  if (!customerIds.length) return [];

  const scope = scopeCondition(scopeUser, { depotColumn: orders.depotId, pfiColumn: orders.pfiId });
  const scopeClause = scope ? sql` AND ${scope}` : sql``;

  const result = await db.execute(sql`
    SELECT
      ${orders.customerId}                 AS "customerId",
      MIN(${customers.name})               AS "customerName",
      MIN(${customers.companyName})        AS "customerCompanyName",
      COUNT(*)::int                        AS "orderCount",
      COUNT(*) FILTER (
        WHERE ROUND(${orders.totalAmount}::numeric - (paid.received - fix.adj - wallet.gave), 2) <> 0
      )::int                               AS "openOrderCount",
      COALESCE(SUM(${orders.totalAmount}::numeric), 0) AS "totalValue",
      COALESCE(SUM(paid.received - fix.adj - wallet.gave), 0) AS "totalReceived",
      COALESCE(SUM(GREATEST(0, (paid.received - fix.adj - wallet.gave) - ${orders.totalAmount}::numeric)), 0) AS "overpaid",
      COALESCE(SUM(GREATEST(0, ${orders.totalAmount}::numeric - (paid.received - fix.adj - wallet.gave))), 0) AS "underpaid",
      -- Stated, never silent. The report above is audited and still counts
      -- these rows; this is exactly the gap between the two, so the block can
      -- be reconciled to it line by line instead of merely disagreeing.
      COALESCE(SUM(fix.adj), 0)            AS "duplicatesExcluded",
      COUNT(*) FILTER (WHERE fix.adj > 0)::int AS "duplicateOrderCount",
      MAX(${orders.createdAt})             AS "lastOrderAt"
    FROM ${orders}
    LEFT JOIN ${customers} ON ${customers.id} = ${orders.customerId}
    -- One subquery per order rather than a join: an order with three payments
    -- would multiply into three rows here and treble its own value in the
    -- SUMs. The same reason the payments above are fetched separately.
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(SUM(op.amount), 0)::numeric AS received,
        /**
         * The same money written down twice by migration 0021.
         *
         * Where surplus was moved between orders in the wallet era, the
         * migration gave the RECEIVING order both the transfer_in and a
         * 'legacy' placeholder for the identical amount. Order 9531 is the
         * shape of it: value 68,400,000, a transfer_in of 68,400,000 that
         * settles it exactly, and a legacy 68,400,000 sitting beside it — so
         * a fully settled order reads as 68.4m overpaid. Its source order
         * 9518 is correct: legacy 125,400,000 less a transfer_out of
         * 68,400,000 leaves exactly its own value.
         *
         * Matched on the amount, because that is the duplicate's signature.
         */
        COALESCE(SUM(op.amount) FILTER (
          WHERE op.source = 'legacy' AND EXISTS (
            SELECT 1 FROM order_payments k
            WHERE k.order_id = op.order_id
              AND k.source <> 'legacy'
              AND k.amount::numeric = op.amount::numeric
          )
        ), 0)::numeric AS duplicate
      FROM order_payments op
      WHERE op.order_id = ${orders.id}
    ) paid
    /**
     * The guard, and the reason this is safe to apply without touching a row.
     *
     * An equal amount alone is not proof of duplication: order 11200 holds
     * ₦177,000,000 against a ₦177,000,000 order and happens to carry a legacy
     * 45,000 beside a statement 45,000. Both are real, the order is square,
     * and dropping one would invent a shortfall.
     *
     * So a duplicate is only discounted when the order is overpaid AND
     * removing it lands the order on EXACTLY its own value. That is
     * self-proving — the remaining rows account for the order in full — and
     * it can neither create a shortfall nor half-correct anything. Across the
     * book it discounts 24 orders and leaves 11200 alone.
     */
    /**
     * Wallet-era surplus this order gave away.
     *
     * A movement recorded only in a deposit description left the giving order
     * counting money it handed over weeks ago. The rows on the report
     * reconstruct the missing leg; this block has to subtract the same figure
     * or it would go on calling a customer overpaid on an order the report
     * itself now shows as settled.
     *
     * Its own lateral rather than a term inside the payments sum: it is
     * correlated on the ORDER, and a subquery correlated on a payment row
     * cannot be evaluated inside that aggregate.
     */
    CROSS JOIN LATERAL (
      SELECT CASE
        /**
         * Behind the same guard the rows use, so the two cannot disagree.
         *
         * Netted only where the order lands on exactly its own value once the
         * movements come off — self-proving, because the remaining payments
         * then account for the order in full. Three orders fail it: they gave
         * away more than they ever held, so the money came from the customer's
         * pooled wallet rather than from that order, and subtracting it here
         * would show a shortfall the report's own rows do not.
         */
        WHEN g.gave > 0
         AND ROUND(paid.received - g.gave - ${orders.totalAmount}::numeric, 2) = 0
        THEN g.gave ELSE 0
      END AS gave
      FROM (
        SELECT COALESCE(SUM(dp2.amount::numeric), 0) AS gave
        FROM deposits dp2
        JOIN order_deposit_allocations a2 ON a2.deposit_id = dp2.id
        JOIN order_payments op2
          ON op2.deposit_id = dp2.id AND op2.order_id = a2.order_id AND op2.source = 'legacy'
        WHERE dp2.description ~ 'from order #[0-9]+'
          AND (regexp_match(dp2.description, 'from order #([0-9]+)'))[1]::int = ${orders.id}
      ) g
    ) wallet
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN paid.duplicate > 0
         AND paid.received > ${orders.totalAmount}::numeric
         AND ROUND(paid.received - paid.duplicate - ${orders.totalAmount}::numeric, 2) = 0
        THEN paid.duplicate ELSE 0
      END AS adj
    ) fix
    WHERE ${inArray(orders.customerId, customerIds)}
      AND ${orders.paymentStatus} IN ('Paid', 'Part Paid')${scopeClause}
    GROUP BY ${orders.customerId}
  `);

  return (result.rows ?? result)
    .map((r) => {
      const overpaid = Number(r.overpaid) || 0;
      const underpaid = Number(r.underpaid) || 0;
      return {
        customerId: Number(r.customerId),
        customerName: r.customerName || "",
        customerCompanyName: r.customerCompanyName || "",
        /** Every order of theirs money has landed on, all time. */
        orderCount: Number(r.orderCount) || 0,
        /** Of those, how many are still out of balance either way. */
        openOrderCount: Number(r.openOrderCount) || 0,
        totalValue: Number(r.totalValue) || 0,
        totalReceived: Number(r.totalReceived) || 0,
        /** Money of theirs sitting on orders beyond what those orders cost. */
        overpaid,
        /** Money still owed across their orders. */
        underpaid,
        /**
         * Money the audited report still counts that this block does not,
         * and on how many orders. Printed, so the two documents reconcile.
         */
        duplicatesExcluded: Number(r.duplicatesExcluded) || 0,
        duplicateOrderCount: Number(r.duplicateOrderCount) || 0,
        /** Positive is owed to Soroman, negative is held for the customer. */
        net: underpaid - overpaid,
        lastOrderAt: r.lastOrderAt,
      };
    })
    // A customer square on every order has nothing to report. Tested on the
    // two sides rather than the net, so somebody ₦5m over and ₦5m under still
    // appears — netting them to zero is what would hide both.
    .filter((c) => c.overpaid + c.underpaid >= 0.005)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.overpaid + b.underpaid - (a.overpaid + a.underpaid));
};

/**
 * Every confirmed payment, order by order, exactly as the bank statement has
 * it.
 *
 * ── What this no longer does ───────────────────────────────────────────────
 *
 * It does not reconstruct anything. The previous version had three separate
 * mechanisms for working out where an order's money came from, because the
 * link was never recorded:
 *
 *   * a FIFO walk over the customer's wallet (`traceWalletSources`), printed
 *     in the same columns as bank-matched money with nothing to mark it as a
 *     guess;
 *   * a regular expression over deposit descriptions, to find surplus that had
 *     been moved between orders (`'received from order #([0-9]+)'`);
 *   * a replay of the customer's whole wallet ledger up to the instant a hold
 *     was placed, to recover a balance-before and balance-after.
 *
 * All three are gone. `order_payments` records the link at the moment the
 * payment is confirmed, and each row carries the statement line's own details,
 * so this function reads rows and adds them up. See db/migrations/0021.
 *
 * ── The four figures on every order ────────────────────────────────────────
 *
 *   received    what the order actually got, netting any surplus it gave away
 *   applied     what settled its value — never more than the value itself
 *   surplus     money on the order beyond its value, sitting there until moved
 *   shortfall   money still owed
 *
 * `surplus` and `shortfall` cannot both be non-zero, and `applied + shortfall`
 * is always the order's value. That is the arithmetic an auditor checks, and
 * it is the same arithmetic on the screen, in the export and in the totals.
 */
const findFinanceReport = async ({
  search,
  // Null rather than "Paid": the report is every CONFIRMED payment, and a part
  // payment is a confirmed payment — so the unfiltered view is Paid together
  // with Part Paid, and an order settling in instalments stays on the report
  // throughout instead of appearing only once the last kobo lands. An explicit
  // value still filters to exactly that status, and "all" drops the condition.
  paymentStatus = null,
  dateFrom,
  dateTo,
  depotId,
  pfiId,
  productId,
  /**
   * 'reconciled'   only orders with at least one bank statement line behind
   *                them — the set an external audit can actually verify
   * 'unreconciled' only orders with none
   */
  reconciliation,
  /**
   * Filter by how the payments were attributed:
   *   'system'   only orders carrying a payment nobody chose
   *   'staff'    only orders where every payment was a recorded human decision
   *   <a basis>  only orders carrying that exact basis
   */
  confirmationBasis,
  scopeUser,
} = {}) => {
  const conditions = [];
  const scope = scopeCondition(scopeUser, { depotColumn: orders.depotId, pfiColumn: orders.pfiId });
  if (scope) conditions.push(scope);
  if (paymentStatus && paymentStatus !== "all") {
    conditions.push(eq(orders.paymentStatus, paymentStatus));
  } else if (!paymentStatus) {
    conditions.push(inArray(orders.paymentStatus, ["Paid", "Part Paid"]));
  }
  if (depotId) conditions.push(eq(orders.depotId, Number(depotId)));
  if (pfiId) conditions.push(eq(orders.pfiId, Number(pfiId)));
  if (productId) conditions.push(eq(orders.productId, Number(productId)));

  // Bank evidence, or the absence of it. Kept as a WHERE condition rather than
  // a filter applied after the rows are built, so the stat cards and the table
  // are computed over the same set — which is the property that stops them
  // disagreeing.
  const hasStatement = sql`EXISTS (
    SELECT 1 FROM order_payments op
    WHERE op.order_id = ${orders.id} AND op.source = 'statement'
  )`;
  if (reconciliation === "reconciled") conditions.push(hasStatement);
  if (reconciliation === "unreconciled") conditions.push(sql`NOT ${hasStatement}`);

  // Same reasoning as the reconciliation filter above: applied as a WHERE
  // condition so the stat cards and the table describe the same set of orders.
  if (confirmationBasis) {
    const systemBases = sql`('bank_inferred', 'auto_allocated', 'no_record', 'transfer_auto', 'unknown')`;
    const carriesSystemBasis = sql`EXISTS (
      SELECT 1 FROM order_payments op
      WHERE op.order_id = ${orders.id} AND op.confirmation_basis IN ${systemBases}
    )`;
    if (confirmationBasis === "system") {
      conditions.push(carriesSystemBasis);
    } else if (confirmationBasis === "staff") {
      conditions.push(sql`NOT ${carriesSystemBasis}`);
    } else {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM order_payments op
        WHERE op.order_id = ${orders.id} AND op.confirmation_basis = ${confirmationBasis}
      )`);
    }
  }

  if (search) {
    const possibleId = parseOrderReference(search);
    const term = `%${search}%`;
    // Reference, customer, company (either side — an order can carry its own
    // companyName distinct from the customer's), location, PFI, and the bank
    // details on whichever payment(s) actually funded this order: the teller
    // reference and the depositor's name, both straight off the statement.
    // Those are what somebody holding a bank statement types in.
    const textMatch = or(
      ilike(orders.orderNumber, term),
      ilike(customers.name, term),
      ilike(customers.phone, term),
      ilike(orders.companyName, term),
      ilike(customers.companyName, term),
      ilike(depots.name, term),
      ilike(pfis.pfiNumber, term),
      sql`EXISTS (
        SELECT 1 FROM order_payments op
        WHERE op.order_id = ${orders.id}
          AND (op.bank_ref ILIKE ${term} OR op.depositor ILIKE ${term} OR op.narration ILIKE ${term})
      )`,
    );
    conditions.push(possibleId ? or(eq(orders.id, possibleId), textMatch) : textMatch);
  }
  /**
   * Dated by when the order was PLACED, not when finance got round to
   * confirming it.
   *
   * These were different columns and it made the two reports impossible to
   * lay side by side: salesSummary filters on orders.createdAt (see
   * reporting.service.js), this filtered on payment_confirmed_at. An order
   * placed on 24 August and confirmed on 1 September appeared in the sales
   * figures for August and the finance figures for September — same order,
   * same money, two different months, and nothing on either page explaining
   * the gap.
   *
   * It was also self-contradictory here: the Date column has always shown
   * createdAt, so an order could display "20 Aug" while only being findable
   * by filtering to the day it happened to be confirmed.
   *
   * Confirmation date is not lost — payment_confirmed_at is still on the row,
   * and each payment carries the bank's own value date. This is only about
   * which day an order counts towards.
   *
   * A bare "2026-08-20" from a date input parses as that day's UTC midnight —
   * compared as-is, dateTo would exclude every order placed later that same
   * day. Widened to the last instant of the day so "today" means today.
   */
  if (dateFrom) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? `${dateFrom}T00:00:00.000Z` : dateFrom;
    conditions.push(gte(orders.createdAt, new Date(start)));
  }
  if (dateTo) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? `${dateTo}T23:59:59.999Z` : dateTo;
    conditions.push(lte(orders.createdAt, new Date(end)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const columns = {
    ...FULL_ORDER_COLUMNS,
    pfiLocationName: pfis.locationName,
  };

  const [rows, [totalsRow]] = await Promise.all([
    db
      .select(columns)
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(depots, eq(orders.depotId, depots.id))
      .leftJoin(products, eq(orders.productId, products.id))
      .leftJoin(pfis, eq(orders.pfiId, pfis.id))
      .where(whereClause)
      // Newest first by order date — the same column the report is filtered
      // and dated by, so the rows run in the order the Date column shows.
      // The COALESCE this replaced existed only to keep unpaid orders (null
      // paymentConfirmedAt, which Postgres sorts first on DESC) from being
      // dumped at the top; createdAt is never null, so there is nothing left
      // to coalesce.
      .orderBy(desc(orders.createdAt), desc(orders.id)),
    // Over the same filtered set as the rows above, so the stat cards can
    // never disagree with what a filter or search actually shows. Joined the
    // same way as the rows query — the search condition can reference
    // depots/pfis columns, so every query sharing whereClause needs them in
    // scope too, or a search hits a missing-FROM-clause error.
    //
    // Received is summed from order_payments rather than from
    // orders.amount_paid: the two are kept equal by recomputeOrder(), and
    // summing the payment rows means the total on the card is literally the
    // sum of the rows underneath it.
    db
      .select({
        total: count(),
        totalAmount: sql`COALESCE(SUM(${orders.totalAmount}), 0)`,
        totalQuantity: sql`COALESCE(SUM(${orders.quantity}), 0)`,
        // Money PAID IN at the bank's own figure — transfer legs excluded, so
        // this totals the same column the rows below it show and a
        // reconciliation against the statement adds up. See amountPaidIn.
        totalAmountPaidIn: sql`COALESCE(SUM((
          SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op
          WHERE op.order_id = ${orders.id} AND op.source NOT IN ('transfer_in', 'transfer_out')
        )), 0)`,
        // Movement between orders, netted. Zero over any window holding both
        // ends of every transfer in it — which is what makes it a useful check.
        totalNetTransfers: sql`COALESCE(SUM((
          SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op
          WHERE op.order_id = ${orders.id} AND op.source IN ('transfer_in', 'transfer_out')
        )), 0)`,
        // Only the outgoing side, unsigned — "how much money moved", which
        // netting to zero would hide entirely.
        totalTransferredOut: sql`COALESCE(SUM((
          SELECT COALESCE(SUM(-op.amount), 0) FROM order_payments op
          WHERE op.order_id = ${orders.id} AND op.source = 'transfer_out'
        )), 0)`,
        totalReceived: sql`COALESCE(SUM((
          SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op WHERE op.order_id = ${orders.id}
        )), 0)`,
        // Surplus and shortfall are summed per order and never netted against
        // each other. An order ₦5m over and an order ₦5m under is two problems,
        // not zero problems, and netting them was hiding both.
        totalSurplus: sql`COALESCE(SUM(GREATEST(0, (
          SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op WHERE op.order_id = ${orders.id}
        ) - ${orders.totalAmount}::numeric)), 0)`,
        totalShortfall: sql`COALESCE(SUM(GREATEST(0, ${orders.totalAmount}::numeric - (
          SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op WHERE op.order_id = ${orders.id}
        ))), 0)`,
        reconciledCount: sql`COUNT(*) FILTER (WHERE ${hasStatement})::int`,
        partPaidCount: sql`COUNT(*) FILTER (WHERE ${orders.paymentStatus} = 'Part Paid')::int`,
        /**
         * Orders carrying at least one payment nobody chose — the system
         * allocated it, inferred it, or has no record of it at all.
         *
         * Counted in SQL over the same filtered set as everything else here,
         * rather than from the decorated rows, because the rows are only the
         * current page's worth and this figure has to describe the whole
         * filtered book.
         */
        systemDecidedCount: sql`COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM order_payments op
          WHERE op.order_id = ${orders.id}
            AND op.confirmation_basis IN ('bank_inferred', 'auto_allocated', 'no_record', 'transfer_auto', 'unknown')
        ))::int`,
        /** The queue: system-decided AND nobody has vouched for it yet. */
        needsReviewCount: sql`COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM order_payments op
          WHERE op.order_id = ${orders.id}
            AND op.reviewed_at IS NULL
            AND op.confirmation_basis IN ('bank_inferred', 'auto_allocated', 'no_record', 'transfer_auto', 'unknown')
        ))::int`,
        /** Money on the listed orders that an external audit can actually check. */
        totalVerifiableAmount: sql`COALESCE(SUM((
          SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op
          WHERE op.order_id = ${orders.id}
            AND op.confirmation_basis IN ('bank_matched', 'bank_inferred')
        )), 0)`,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(depots, eq(orders.depotId, depots.id))
      .leftJoin(pfis, eq(orders.pfiId, pfis.id))
      .where(whereClause),
  ]);

  const orderIds = rows.map((r) => r.id);

  /**
   * Every payment row for the listed orders, in one batched query.
   *
   * Deliberately not a join on the main select: an order with three payments
   * would multiply into three order rows, which is exactly the shape that made
   * the old report double-count.
   *
   * The bank columns come off order_payments itself — the snapshot taken when
   * the line was matched — not from a join back to bank_statement_lines. A
   * line that has since been re-matched elsewhere must not silently rewrite
   * the history of the order it used to be on.
   */
  const payments = orderIds.length
    ? await db.execute(sql`
        SELECT
          p.id,
          p.order_id           AS "orderId",
          p.statement_line_id  AS "statementLineId",
          p.amount,
          p.source,
          p.txn_date           AS "txnDate",
          p.depositor,
          p.narration,
          p.bank_ref           AS "bankRef",
          p.bank_name          AS "bankName",
          p.account_name       AS "accountName",
          p.account_number     AS "accountNumber",
          -- How this payment came to be on this order. See migration 0023:
          -- until this column existed, a line a colleague matched by hand and
          -- one the old wallet walk picked on its own rendered identically.
          p.confirmation_basis AS "confirmationBasis",
          -- Who has since vouched for a system-made attribution, and why.
          -- Deliberately alongside confirmationBasis rather than replacing it:
          -- how the payment got here and who signed it off afterwards are two
          -- different facts, and 0021 already showed what happens when the
          -- first is overwritten by the second. See migration 0024.
          p.reviewed_at        AS "reviewedAt",
          p.review_note        AS "reviewNote",
          rv.first_name        AS "reviewerFirstName",
          rv.surname           AS "reviewerSurname",
          p.note,
          p.created_at         AS "createdAt",
          p.transfer_id        AS "transferId",
          st.first_name        AS "recorderFirstName",
          st.surname           AS "recorderSurname",
          -- The order at the other end of a transfer leg. Both halves of a
          -- movement therefore name each other on the face of the report,
          -- which is the question an auditor asks the moment they see a
          -- transfer: where did it go, and where did it come from.
          CASE WHEN p.source = 'transfer_out' THEN t.to_order_id
               WHEN p.source = 'transfer_in'  THEN t.from_order_id END AS "counterpartOrderId",
          CASE WHEN p.source = 'transfer_out' THEN o_to.company_name
               WHEN p.source = 'transfer_in'  THEN o_from.company_name END AS "counterpartCompany",
          t.reason AS "transferReason",
          /**
           * What the money on a transfer leg originally was, at the bank.
           *
           * A transfer leg has no statement line of its own — no date, no
           * payer, no reference — so next to real statement rows it rendered
           * as a row of blanks and read as corrupt data. It is not: the money
           * arrived on the OTHER order's bank line, and that is recoverable.
           *
           * Both legs look it up on the order the surplus came FROM (the
           * source of the money in both directions), and only when that order
           * has exactly one payer — with several, naming one of them would be
           * a guess, and the leg falls back to naming the order alone.
           */
          (
            SELECT CASE WHEN COUNT(DISTINCT sp.depositor) = 1 THEN MIN(sp.depositor) END
            FROM order_payments sp
            WHERE sp.order_id = t.from_order_id AND sp.source = 'statement' AND sp.depositor <> ''
          ) AS "originDepositor",
          /**
           * Only where the source order has exactly ONE statement line.
           *
           * This used to string_agg every reference on the source order, so
           * the three transfers out of AM11589 each printed the same four
           * references — implying each had come from all four lines, when in
           * truth nothing records which line a transfer came out of. A
           * transfer moves surplus, and surplus is not attributable to a
           * particular line. Where there is exactly one, saying so is a fact;
           * where there are several, the honest answer is nothing, and the
           * transfer is identified by its own id instead.
           */
          (
            SELECT MIN(sp.bank_ref)
            FROM order_payments sp
            WHERE sp.order_id = t.from_order_id AND sp.source = 'statement' AND sp.bank_ref <> ''
            HAVING COUNT(*) = 1
          ) AS "originBankRefs",
          /**
           * How much of this payment the OLD ledger actually applied to this
           * order — and therefore how much of it never was.
           *
           * The wallet-era ledger allocated a deposit to an order in two
           * figures: 'amount', the whole bank line, and 'applied_amount', the
           * part that settled this particular order. Migration 0021 wrote
           * order_payments at the first and dropped the second, so an order
           * that used 18,315,000 of a 36,000,000 line now records the whole
           * 36,000,000 and reads as 17,685,000 overpaid. VG10807 is exactly
           * that; 119 orders are, for N1,243,302,153 between them.
           *
           * The remainder was NOT moved to another order — the deposits were
           * allocated to one order each and nothing else drew on them. It
           * stayed as unapplied customer credit, which is what the wallet
           * balance was. So the report must not call it a transfer; it can
           * only say that this much of the line was never applied here.
           *
           * Joined on the reference, which the two tables genuinely share:
           * deposits.reference IS the bank ref carried on the payment. Amount
           * is matched too, so a reused reference cannot drag in the wrong
           * allocation. Null where no old-ledger row answers to this payment,
           * which is every payment recorded since.
           */
          (
            SELECT a.applied_amount
            FROM order_deposit_allocations a
            JOIN deposits dp ON dp.id = a.deposit_id
            WHERE a.order_id = p.order_id
              AND dp.reference = p.bank_ref
              AND dp.amount::numeric = p.amount::numeric
            LIMIT 1
          ) AS "appliedAmount",
          /**
           * The order this money actually came out of, on a row that shows as
           * having no bank record at all.
           *
           * Surplus moved between orders in the wallet era was written as a
           * credit deposit whose DESCRIPTION named the source: "From TRF FROM
           * ORDER ZI10916 - Overpayment received from order #10916". Migration
           * 0021 took the amount and left the sentence, so the receiving order
           * carries a legacy row reading "No bank record" while the record of
           * where the money came from sits in a text column nothing reads.
           *
           * 28 movements are recorded this way, N124,627,399 between them. The
           * sentence is the only record there is, so it is read rather than
           * ignored — the same regexp the pre-0021 code used, which was
           * removed for being a guess. It is not a guess here: it is used only
           * to NAME the counterpart, never to move a figure. Every amount on
           * this report still comes from order_payments.
           */
          (
            SELECT o_src.order_number
            FROM order_deposit_allocations a
            JOIN deposits dp ON dp.id = a.deposit_id
            JOIN orders o_src
              ON o_src.id = (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int
            WHERE a.order_id = p.order_id
              AND a.source = 'wallet'
              AND dp.amount::numeric = p.amount::numeric
            LIMIT 1
          ) AS "walletFromOrderRef"
        FROM order_payments p
        LEFT JOIN staff st ON st.id = p.recorded_by
        LEFT JOIN staff rv ON rv.id = p.reviewed_by
        LEFT JOIN order_payment_transfers t ON t.id = p.transfer_id
        LEFT JOIN orders o_to   ON o_to.id = t.to_order_id
        LEFT JOIN orders o_from ON o_from.id = t.from_order_id
        WHERE p.order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
        -- Banking order, then entry order. A report checked against a
        -- statement reads down the statement's own dates.
        ORDER BY p.txn_date ASC NULLS LAST, p.created_at ASC, p.id ASC
      `)
    : [];

  /**
   * Surplus this order gave away, where the only record of it is a sentence.
   *
   * The receiving end at least has a row — see walletFromOrderRef. The giving
   * end has nothing at all: no transfer_out, no payment, no trace on the
   * order, which is why VG10807 sits on the report reading 17,685,000 overpaid
   * with no indication that the 17,685,000 left for WP10852 weeks ago.
   *
   * Read from the same descriptions, keyed by the order that gave. Deliberately
   * NOT added to any figure: this report's arithmetic stays exactly as it is
   * and as it was audited. It is a line saying where the money went.
   */
  const movedOutByOrder = new Map();
  if (orderIds.length) {
    const moved = await db.execute(sql`
      SELECT
        (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int AS "fromOrderId",
        a.order_id AS "toOrderId",
        o_dst.order_number AS "toOrderRef",
        dp.amount::numeric AS amount,
        dp.created_at AS "movedAt"
      FROM deposits dp
      JOIN order_deposit_allocations a ON a.deposit_id = dp.id
      LEFT JOIN orders o_dst ON o_dst.id = a.order_id
      WHERE dp.description ~ 'from order #[0-9]+'
        AND (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int
            IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const m of moved.rows ?? moved) {
      const list = movedOutByOrder.get(m.fromOrderId) || [];
      list.push({
        toOrderId: m.toOrderId,
        toOrderRef: m.toOrderRef,
        amount: Number(m.amount),
        movedAt: m.movedAt,
      });
      movedOutByOrder.set(m.fromOrderId, list);
    }
  }

  const paymentsByOrder = new Map();
  for (const p of payments.rows ?? payments) {
    p.amount = Number(p.amount);
    // Null stays null: "the old ledger has nothing to say about this payment"
    // is a different fact from "it applied nothing", and only the first is
    // true of every payment recorded since the wallet path was retired.
    p.appliedAmount = p.appliedAmount == null ? null : Number(p.appliedAmount);
    p.counterpartOrderRef =
      p.counterpartOrderId != null
        ? generateOrderReference(p.counterpartCompany, p.counterpartOrderId)
        : null;
    if (!paymentsByOrder.has(p.orderId)) paymentsByOrder.set(p.orderId, []);
    paymentsByOrder.get(p.orderId).push(p);
  }

  const decorated = rows.map((row) => {
    /**
     * The outgoing leg the wallet era never wrote, reconstructed.
     *
     * A movement recorded only in a deposit description left the money counted
     * once instead of twice: the receiving order got a payment row, the giving
     * order got nothing. So the giver goes on counting money it handed over
     * weeks ago, and reads as overpaid by exactly the amount it gave.
     *
     * Naming it was not enough — the figure stayed wrong and so did every
     * total built on it. It is built into a payment row here, negative, as a
     * transfer_out leg, so it flows through `received`, the differential, the
     * Transferred column and the totals the same way a recorded transfer does.
     * Nothing downstream needs to know it was reconstructed.
     *
     * ONLY where the order lands on exactly its own value once the movements
     * are taken off. That is self-proving: the remaining payments account for
     * the order in full, so this is where the surplus went. Three orders fail
     * it — they gave away more than they ever held, which means the money came
     * from the customer's pooled wallet rather than from that order — and
     * their movements are left named but not netted, because netting them
     * would invent a shortfall on an order that was fully paid.
     *
     * The id is negative so it cannot collide with a real payment id, and
     * `reconstructed` marks it for anything that must not offer to reverse a
     * transfer that has no row to reverse.
     */
    const movedOut = movedOutByOrder.get(row.id) || [];
    const rowTotal = Number(row.totalAmount || 0);
    const recordedSoFar = (paymentsByOrder.get(row.id) || []).reduce((sum, p) => sum + p.amount, 0);
    const movedTotal = movedOut.reduce((sum, m) => sum + m.amount, 0);
    const settlesExactly =
      movedTotal > 0 && Math.round((recordedSoFar - movedTotal) * 100) === Math.round(rowTotal * 100);

    if (settlesExactly) {
      const legs = movedOut.map((m, i) => ({
        id: -(row.id * 1000 + i + 1),
        orderId: row.id,
        statementLineId: null,
        amount: -m.amount,
        source: "transfer_out",
        txnDate: null,
        depositor: "",
        narration: "",
        bankRef: "",
        bankName: "",
        accountName: "",
        accountNumber: "",
        confirmationBasis: "transfer_auto",
        reviewedAt: null,
        reviewNote: "",
        reviewerFirstName: null,
        reviewerSurname: null,
        note: `Surplus moved to ${m.toOrderRef || "another order"} — recorded in the wallet ledger`,
        createdAt: m.movedAt,
        transferId: null,
        recorderFirstName: null,
        recorderSurname: null,
        counterpartOrderId: m.toOrderId,
        counterpartOrderRef: m.toOrderRef,
        transferReason: "Wallet-era surplus movement",
        originDepositor: null,
        originBankRefs: null,
        appliedAmount: null,
        walletFromOrderRef: null,
        /** Not a row in order_payments. Nothing may offer to reverse it. */
        reconstructed: true,
      }));
      paymentsByOrder.set(row.id, [...(paymentsByOrder.get(row.id) || []), ...legs]);
    }

    const rowPayments = paymentsByOrder.get(row.id) || [];
    const total = Number(row.totalAmount || 0);

    /**
     * Money PAID IN against this order, at the figure the bank statement
     * carries — never reduced by a transfer that happened afterwards.
     *
     * This is the column the report gets checked against a statement, so it
     * has to be the statement's own number and nothing else. It used to be
     * netted: an order that received ₦163,350,000 and later moved ₦54,450,000
     * to another order showed ₦108,900,000 here, a figure appearing on no
     * statement anywhere, and the person reconciling had to work backwards
     * through a transfer to find out why the two disagreed.
     *
     * A transfer is a later, separate event. It gets its own columns below.
     */
    const amountPaidIn = rowPayments
      .filter((p) => !TRANSFER_SOURCES.has(p.source))
      .reduce((sum, p) => sum + p.amount, 0);

    const transferredIn = rowPayments
      .filter((p) => p.source === "transfer_in")
      .reduce((sum, p) => sum + p.amount, 0);
    // Already negative on the row — kept negative, so `netTransfers` is a
    // plain sum and the column shows direction without a separate flag.
    const transferredOut = rowPayments
      .filter((p) => p.source === "transfer_out")
      .reduce((sum, p) => sum + p.amount, 0);
    const netTransfers = transferredIn + transferredOut;

    /** What the order actually holds now: paid in, plus what moved. */
    const received = amountPaidIn + netTransfers;

    return {
      ...row,
      payments: rowPayments,
      /**
       * The bank statement figure. What "Amount Paid" shows, and what a
       * reconciliation ticks off line by line.
       */
      amountPaidIn,
      /** Sales value against the bank figure — before any transfer. */
      differential: total - amountPaidIn,
      transferredIn,
      transferredOut,
      /** Signed: negative where this order gave money away. */
      netTransfers,
      /**
       * What is left once both are taken into account. Zero on a settled
       * order, whichever route its money took — this is the column that
       * should read as a dash all the way down a clean day.
       */
      balance: total - received,
      /** What the order holds now, after transfers. */
      received,
      /** What settled the order's value. Never more than the value. */
      applied: Math.min(received, total),
      /** Money the order still holds beyond its value — after transfers. */
      surplus: Math.max(0, received - total),
      /** Money the order still needs — after transfers. */
      shortfall: Math.max(0, total - received),
      /**
       * At least one bank statement line stands behind this order.
       *
       * The single most important flag on the report: it separates what an
       * external auditor can verify against a statement from what they cannot.
       * An order with only `legacy` rows was confirmed before payments were
       * recorded against orders, and the report says exactly that rather than
       * filling the bank columns with a plausible-looking guess.
       */
      reconciled: rowPayments.some((p) => p.source === "statement"),

      /**
       * HOW this order was confirmed — the question `reconciled` does not
       * answer and which the report was silently conflating with it.
       *
       * `reconciled` says a bank line exists somewhere on the order. It says
       * nothing about who decided that line settles THIS order, and for 22
       * rows the answer is that migration 0021 guessed. These four fields
       * separate evidence from inference on the face of the row.
       */
      confirmationBasis: weakestBasis(rowPayments),
      confirmationBasisLabel:
        CONFIRMATION_BASIS_LABEL[weakestBasis(rowPayments)] || null,
      /** Every distinct basis on the order, so a mixed order can say so. */
      confirmationBases: [...new Set(rowPayments.map((p) => p.confirmationBasis))],
      /**
       * True where no person chose how this order was funded — the system did,
       * by the oldest-credit-first walk or by a migration's tiebreak. This is
       * the flag the desk actually needs: it is the set of orders whose story
       * nobody in the building can tell.
       */
      systemDecided: rowPayments.some((p) => SYSTEM_DECIDED_BASES.has(p.confirmationBasis)),
      /**
       * Still waiting on a person. The work queue: a system-made attribution
       * nobody has yet vouched for. Shrinks as the desk works through it,
       * unlike `systemDecided`, which is a permanent historical fact.
       */
      needsReview: rowPayments.some(
        (p) => SYSTEM_DECIDED_BASES.has(p.confirmationBasis) && !p.reviewedAt,
      ),
      /** Money on this order that an external auditor can check. */
      verifiableAmount: rowPayments
        .filter((p) => VERIFIABLE_BASES.has(p.confirmationBasis))
        .reduce((sum, p) => sum + p.amount, 0),

      /**
       * Surplus that left this order in the wallet era. Netted above where it
       * settles the order exactly; left named-only where it does not, so the
       * three orders that gave away pooled wallet money still say so without
       * being pushed into a shortfall they never had.
       */
      surplusMovedOut: settlesExactly ? [] : movedOutByOrder.get(row.id) || [],

      /** The account(s) the money was actually paid into. */
      paidInto: [
        ...new Set(
          rowPayments
            .filter((p) => p.bankName || p.accountNumber)
            .map((p) => [p.bankName, p.accountNumber].filter(Boolean).join(" · ")),
        ),
      ],
    };
  });

  /**
   * The all-time position of the customers on this report — see
   * findCustomerDifferentials. Only the customers actually listed above, so
   * the block stays about the report it sits under and a day's report names a
   * handful of people rather than the whole customer book.
   */
  const customerDifferentials = await findCustomerDifferentials(
    [...new Set(rows.map((r) => r.customerId).filter((id) => id != null))],
    scopeUser,
  );

  const total = Number(totalsRow.total) || 0;
  const reconciledCount = Number(totalsRow.reconciledCount) || 0;

  return {
    orders: decorated.map(formatOrderRow),
    customerDifferentials,
    totals: {
      count: total,
      totalAmount: Number(totalsRow.totalAmount),
      totalQuantity: Number(totalsRow.totalQuantity),
      /**
       * The bank statement total — what "Amount Paid" sums to, and what a
       * reconciliation against the statement is checked against.
       */
      totalAmountPaidIn: Number(totalsRow.totalAmountPaidIn),
      /** Sales value against the bank figure, before any transfer. */
      totalDifferential: Number(totalsRow.totalAmount) - Number(totalsRow.totalAmountPaidIn),
      /** Movement between orders: netted, and the outgoing side unsigned. */
      totalNetTransfers: Number(totalsRow.totalNetTransfers),
      totalTransferredOut: Number(totalsRow.totalTransferredOut),
      /** What the listed orders hold once transfers are taken into account. */
      totalReceived: Number(totalsRow.totalReceived),
      /** What is left after both — zero on a fully settled window. */
      totalBalance: Number(totalsRow.totalAmount) - Number(totalsRow.totalReceived),
      /** Summed per order, never netted — see the SQL above. */
      totalSurplus: Number(totalsRow.totalSurplus),
      totalShortfall: Number(totalsRow.totalShortfall),
      /** How much of the book an external audit can actually check. */
      reconciledCount,
      unreconciledCount: total - reconciledCount,
      partPaidCount: Number(totalsRow.partPaidCount),
      /**
       * Orders holding at least one payment the system attributed on its own.
       * Distinct from `unreconciledCount`: an order can have a genuine bank
       * line and still have had the order chosen for it by a migration.
       */
      systemDecidedCount: Number(totalsRow.systemDecidedCount) || 0,
      /** Of those, how many nobody has vouched for yet. */
      needsReviewCount: Number(totalsRow.needsReviewCount) || 0,
      /** Naira backed by a bank statement line, whoever attributed it. */
      totalVerifiableAmount: Number(totalsRow.totalVerifiableAmount) || 0,
      /** Naira with no bank line behind it at all. */
      totalUnverifiableAmount:
        Number(totalsRow.totalReceived) - (Number(totalsRow.totalVerifiableAmount) || 0),
    },
  };
};

const create = async (data, tx = db) => {
  const [row] = await tx.insert(orders).values(data).returning();
  return formatOrderRow(row);
};

const update = async (id, data, tx = db) => {
  const [row] = await tx
    .update(orders)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(orders.id, id))
    .returning();
  return formatOrderRow(row);
};

const findUnpaidByCustomer = async (customerId) => {
  // Pending only: a cancelled order must never be auto-paid, and a completed
  // one can't legally be unpaid.
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(orders.paymentStatus, "Unpaid"),
        eq(orders.status, "Pending")
      )
    )
    .orderBy(asc(orders.createdAt));
  return rows.map(formatOrderRow);
};

// Everything before Completed/Cancelled — what a customer can still track.
const OPEN_STATUSES = ["Pending", "Paid", "Released", "Loading"];

/**
 * The customer's in-flight orders with the display names joined in, newest
 * first. Capped for the WhatsApp list (9 rows + reserve); the portal is the
 * home of unbounded history.
 */
const findOpenByCustomer = async (customerId, limit = 9) => {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      companyName: orders.companyName,
      customerCompanyName: customers.companyName,
      status: orders.status,
      quantity: orders.quantity,
      totalAmount: orders.totalAmount,
      deliveryType: orders.deliveryType,
      virtualAccountBank: orders.virtualAccountBank,
      virtualAccountNumber: orders.virtualAccountNumber,
      productName: products.name,
      depotName: depots.name,
    })
    .from(orders)
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(depots, eq(orders.depotId, depots.id))
    .leftJoin(products, eq(orders.productId, products.id))
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, OPEN_STATUSES)))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  return rows.map(formatOrderRow);
};

const countByPfi = async (pfiId) => {
  const [{ total }] = await db
    .select({ total: count() })
    .from(orders)
    .where(eq(orders.pfiId, pfiId));
  return total;
};

/**
 * Orders still owed money — the finance desk's queue.
 *
 * This used to be "orders whose customer is holding enough wallet balance to
 * settle them right now", and that test had to go with the wallet payment
 * path. Nothing funds a wallet any more, so every balance is frozen at
 * whatever it was: the affordability test would have emptied this page and
 * left the desk with nowhere to confirm a payment from — the one screen the
 * whole change depends on.
 *
 * What is payable is now simply what is unpaid. The desk opens an order,
 * matches the bank statement line that paid for it, and the order settles;
 * whether the customer happens to have a legacy balance has nothing to do
 * with it.
 *
 * Part Paid orders belong here too: they still owe a balance, and the desk
 * finishes them off the same way.
 */
const findPayableOrders = async (scopeUser) => {
  const conditions = [
    inArray(orders.paymentStatus, ["Unpaid", "Part Paid"]),
    // A part-paid order has already been released, so restricting to Pending
    // would exclude every one of them.
    inArray(orders.status, ["Pending", "Paid", "Released", "Loading"]),
  ];
  const scope = scopeCondition(scopeUser, { depotColumn: orders.depotId, pfiColumn: orders.pfiId });
  if (scope) conditions.push(scope);

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      customerName: customers.name,
      companyName: orders.companyName,
      customerCompanyName: customers.companyName,
      customerBalance: customers.balance,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      quantity: orders.quantity,
      totalAmount: orders.totalAmount,
      deliveryType: orders.deliveryType,
      deliveryAddress: orders.deliveryAddress,
      state: orders.state,
      createdAt: orders.createdAt,
      depotName: depots.name,
      productName: products.name,
      productUnit: products.unit,
      price: orders.price,
      /**
       * The fields the payable desk filters and totals by.
       *
       * They were absent because the page was not using this endpoint at all —
       * it asked for status='Pending' through the generic order list, which
       * silently hid every PART-PAID order, since a part-paid order has always
       * been released already. Eleven of them, ₦1.84bn, with product loading
       * against unpaid balances, and the page's own "Part paid" card read 0.
       *
       * amountPaid comes from the payment rows rather than a column: it is
       * what the desk is deciding about, and a stale denormalised copy on the
       * order is the one number here that must not be wrong.
       */
      pfiNumber: pfis.pfiNumber,
      customerPhone: customers.phone,
      amountPaid: sql`(
        SELECT COALESCE(SUM(op.amount), 0)
          FROM order_payments op
         WHERE op.order_id = ${orders.id}
      )`,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(depots, eq(orders.depotId, depots.id))
    .leftJoin(products, eq(orders.productId, products.id))
    .leftJoin(pfis, eq(orders.pfiId, pfis.id))
    .where(and(...conditions))
    .orderBy(asc(orders.createdAt));
  return rows.map(formatOrderRow);
};

/**
 * Pending, unpaid orders created on or before `cutoff` — the expiry sweep's
 * work list. Oldest first, so the log reads in the order they lapsed.
 */
const findStalePending = async (cutoff) => {
  return db
    .select({ id: orders.id, orderNumber: orders.orderNumber, createdAt: orders.createdAt })
    .from(orders)
    .where(
      and(
        eq(orders.status, "Pending"),
        eq(orders.paymentStatus, "Unpaid"),
        lte(orders.createdAt, cutoff)
      )
    )
    .orderBy(asc(orders.createdAt));
};

/**
 * What has gone out and not been paid for.
 *
 * This is the compensating control for credit releases, and it is not optional
 * furniture around the feature — it IS the feature's safety. releasableQuantity
 * used to be arithmetic nobody could argue with; once an allowance can be
 * granted by a person, the only thing standing between "trusted on Tuesday" and
 * "written off in March" is that somebody can see the list. So it is built to
 * be read every day rather than discovered during a stock take.
 *
 * ── What counts as exposure ────────────────────────────────────────────────
 *
 * Two populations, deliberately both:
 *
 *   - an order with an allowance on it, whatever it has done since, because
 *     somebody accepted the risk and that decision should not disappear from
 *     view just because the trucks have not moved yet; and
 *   - an order in Loading or Completed with a balance, allowance or not,
 *     because product is out of the gate and the money is not in. An order
 *     part-paid and loaded is exposure by exactly the same arithmetic, and it
 *     was invisible before this existed.
 *
 * Cancelled and Expired are excluded: nothing left, so nothing is owed.
 *
 * ── Ageing ─────────────────────────────────────────────────────────────────
 *
 * `exposedSince` is the earliest moment the risk actually began — the credit
 * authorisation, or failing that the release, the loading, the completion.
 * COALESCE order runs oldest-cause-first on purpose: an order authorised on
 * credit in January and completed in March has been exposed since January, and
 * dating it from completion would flatter the number by two months.
 */
const findReceivables = async ({ search = "", minDays = 0 } = {}) => {
  const ref = orderReferenceSql("o", "c");
  const term = String(search || "").trim();
  const pattern = `%${term}%`;

  const rows = await db.execute(sql`
    SELECT o.id,
           ${ref} AS "orderNumber",
           o.status,
           o.payment_status                          AS "paymentStatus",
           o.quantity,
           o.total_amount                            AS "totalAmount",
           o.amount_paid                             AS "amountPaid",
           (o.total_amount - o.amount_paid)          AS outstanding,
           o.credit_qty                              AS "creditQty",
           o.credit_reason                           AS "creditReason",
           o.credit_authorised_at                    AS "creditAuthorisedAt",
           NULLIF(TRIM(CONCAT(s.first_name, ' ', s.surname)), '') AS "creditAuthorisedByName",
           COALESCE(NULLIF(BTRIM(o.company_name), ''), NULLIF(BTRIM(c.company_name), ''), c.name) AS "customerName",
           c.phone                                   AS "customerPhone",
           d.name                                    AS "depotName",
           p.name                                    AS "productName",
           o.created_at                              AS "createdAt",
           o.released_at                             AS "releasedAt",
           o.completed_at                            AS "completedAt",
           COALESCE(o.credit_authorised_at, o.released_at, o.loading_started_at, o.completed_at, o.created_at)
                                                     AS "exposedSince",
           GREATEST(
             0,
             EXTRACT(DAY FROM (NOW() - COALESCE(o.credit_authorised_at, o.released_at, o.loading_started_at, o.completed_at, o.created_at)))
           )::int                                    AS "daysOutstanding"
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN depots    d ON d.id = o.depot_id
      LEFT JOIN products  p ON p.id = o.product_id
      LEFT JOIN staff     s ON s.id = o.credit_authorised_by
     WHERE o.status NOT IN ('Cancelled', 'Expired')
       AND (o.total_amount - o.amount_paid) > 0
       AND (o.credit_qty > 0 OR o.status IN ('Loading', 'Completed'))
       ${term ? sql`AND (${ref} ILIKE ${pattern} OR c.name ILIKE ${pattern} OR o.company_name ILIKE ${pattern} OR c.company_name ILIKE ${pattern})` : sql``}
     ORDER BY "exposedSince" ASC NULLS LAST
  `);

  const all = (rows.rows ?? rows).map((r) => ({
    ...r,
    outstanding: Number(r.outstanding),
    creditQty: Number(r.creditQty ?? 0),
    daysOutstanding: Number(r.daysOutstanding ?? 0),
  }));

  const list = minDays > 0 ? all.filter((r) => r.daysOutstanding >= Number(minDays)) : all;

  return {
    orders: list,
    summary: {
      count: list.length,
      outstanding: list.reduce((sum, r) => sum + r.outstanding, 0),
      // Split out because they are different conversations: one is a debt
      // somebody authorised, the other is a debt that simply accumulated.
      onCredit: list.filter((r) => r.creditQty > 0).reduce((sum, r) => sum + r.outstanding, 0),
      overThirtyDays: list
        .filter((r) => r.daysOutstanding >= 30)
        .reduce((sum, r) => sum + r.outstanding, 0),
    },
  };
};

module.exports = {
  findReceivables,
  findById,
  lockById,
  findByNumber,
  findByIdempotencyKey,
  findRecentDuplicate,
  findByIdFull,
  findByNumberFull,
  findTrucksByOrderId,
  findAll,
  findFinanceReport,
  create,
  update,
  findUnpaidByCustomer,
  findOpenByCustomer,
  countByPfi,
  findPayableOrders,
  findStalePending,
};
