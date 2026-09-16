const { eq, and, or, ilike, desc, count, sql, between, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const { generateOrderReference, parseOrderReference } = require("../utils/helpers");
const { scopeCondition } = require("../lib/scopeFilter");
const {
  commissions,
  depotProductCommissions,
  orders,
  customers,
  depots,
  products,
  pfis,
  deposits,
  staff,
} = require("../db/schema");

// ─── Commission Rates (depot × product) ─────────────────────────────────────

const getRate = async (depotId, productId, tx = db) => {
  const [row] = await tx
    .select()
    .from(depotProductCommissions)
    .where(
      and(
        eq(depotProductCommissions.depotId, depotId),
        eq(depotProductCommissions.productId, productId)
      )
    )
    .limit(1);
  return row || null;
};

const getRates = async ({ depotId, page = 1, limit = 200 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (depotId) conditions.push(eq(depotProductCommissions.depotId, depotId));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: depotProductCommissions.id,
      depotId: depotProductCommissions.depotId,
      depotName: depots.name,
      depotCity: depots.city,
      depotState: depots.state,
      productId: depotProductCommissions.productId,
      productName: products.name,
      productSku: products.sku,
      commissionRate: depotProductCommissions.commissionRate,
      createdAt: depotProductCommissions.createdAt,
      updatedAt: depotProductCommissions.updatedAt,
    })
    .from(depotProductCommissions)
    .leftJoin(depots, eq(depotProductCommissions.depotId, depots.id))
    .leftJoin(products, eq(depotProductCommissions.productId, products.id))
    .where(whereClause)
    .orderBy(depots.name, products.name)
    .limit(limitNum)
    .offset(offset);

  return rows.map((r) => ({
    ...r,
    commissionRate: parseFloat(r.commissionRate),
  }));
};

const upsertRate = async (depotId, productId, commissionRate) => {
  const [existing] = await db
    .select()
    .from(depotProductCommissions)
    .where(
      and(
        eq(depotProductCommissions.depotId, depotId),
        eq(depotProductCommissions.productId, productId)
      )
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(depotProductCommissions)
      .set({ commissionRate: String(commissionRate), updatedAt: new Date() })
      .where(eq(depotProductCommissions.id, existing.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(depotProductCommissions)
    .values({ depotId, productId, commissionRate: String(commissionRate) })
    .returning();
  return row;
};

// ─── Commission Records ─────────────────────────────────────────────────────

const findAll = async ({
  search,
  status,
  depotId,
  customerId,
  dateFrom,
  dateTo,
  page = 1,
  limit = 50,
  scopeUser,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  /**
   * Scoped by the commission's own depot, and deliberately not by the order's
   * PFI as well.
   *
   * The count query beside the rows query selects from `commissions` alone —
   * no join to orders — so a condition naming orders.pfi_id compiles to a
   * missing-FROM-clause error there and takes the whole list down. The depot
   * is on the row itself and is a commission's natural home anyway: it is
   * earned at a depot, and the rate is set per depot and product.
   */
  const scope = scopeCondition(scopeUser, { depotColumn: commissions.depotId });
  if (scope) conditions.push(scope);

  if (status && status !== "all") {
    conditions.push(eq(commissions.status, status));
  }
  if (depotId) {
    conditions.push(eq(commissions.depotId, parseInt(depotId)));
  }
  if (customerId) {
    conditions.push(eq(commissions.customerId, parseInt(customerId)));
  }
  /**
   * gte/lte rather than a raw sql`` comparison.
   *
   * A Date interpolated into Drizzle's sql`` template is passed to the driver
   * as an opaque parameter with no column type behind it, and postgres.js then
   * refuses it: "The 'string' argument must be of type string ... Received an
   * instance of Date". Every commissions request carrying a date filter was a
   * 500. gte/lte know the column is a timestamp and serialise it properly.
   */
  if (dateFrom) {
    conditions.push(gte(commissions.createdAt, new Date(dateFrom)));
  }
  if (dateTo) {
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);
    conditions.push(lte(commissions.createdAt, end));
  }
  if (search) {
    const pattern = `%${search}%`;
    /**
     * Search the reference the page SHOWS, not the one the column stores.
     *
     * orders.order_number holds a legacy value — "TA9649" — while every screen
     * displays generateOrderReference(company, id), which for that same row is
     * "MA11942". So typing the reference in front of you matched nothing, and
     * the id inside it matched nothing either.
     *
     * parseOrderReference pulls the id back out of the displayed form, exactly
     * as the finance report's search does. The stored column stays in the OR
     * for anyone working from an older document.
     */
    const possibleId = parseOrderReference(search);
    const textMatch = or(
      ilike(orders.orderNumber, pattern),
      ilike(customers.name, pattern),
      ilike(customers.companyName, pattern),
      ilike(orders.companyName, pattern),
      ilike(depots.name, pattern),
      ilike(products.name, pattern),
      ilike(pfis.pfiNumber, pattern)
    );
    conditions.push(possibleId ? or(eq(orders.id, possibleId), textMatch) : textMatch);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: commissions.id,
        orderId: commissions.orderId,
        orderNumber: orders.orderNumber,
        orderCompanyName: orders.companyName,
        orderCreatedAt: orders.createdAt,
        customerId: commissions.customerId,
        customerName: customers.name,
        customerPhone: customers.phone,
        customerCompanyName: customers.companyName,
        customerCommissionBankName: customers.commissionBankName,
        customerCommissionAccountName: customers.commissionAccountName,
        customerCommissionAccountNumber: customers.commissionAccountNumber,
        // The batch the order drew on. The desk settles commissions a PFI at
        // a time, so it is a column and a sort key, not a detail.
        pfiId: orders.pfiId,
        pfiNumber: pfis.pfiNumber,
        depotId: commissions.depotId,
        depotName: depots.name,
        depotCity: depots.city,
        depotState: depots.state,
        productId: commissions.productId,
        productName: products.name,
        productSku: products.sku,
        quantity: commissions.quantity,
        commissionRate: commissions.commissionRate,
        commissionAmount: commissions.commissionAmount,
        status: commissions.status,
        paidAt: commissions.paidAt,
        paidBy: commissions.paidBy,
        paidByName: sql`CONCAT(${staff.firstName}, ' ', ${staff.surname})`,
        // A skipped row has to be able to say who decided and why, or the
        // status is just an unexplained dead end on the page.
        skippedAt: commissions.skippedAt,
        skipReason: commissions.skipReason,
        createdAt: commissions.createdAt,
      })
      .from(commissions)
      .leftJoin(orders, eq(commissions.orderId, orders.id))
      .leftJoin(customers, eq(commissions.customerId, customers.id))
      .leftJoin(depots, eq(commissions.depotId, depots.id))
      .leftJoin(products, eq(commissions.productId, products.id))
      .leftJoin(pfis, eq(orders.pfiId, pfis.id))
      .leftJoin(staff, eq(commissions.paidBy, staff.id))
      .where(whereClause)
      .orderBy(desc(commissions.createdAt))
      .limit(limitNum)
      .offset(offset),
    /**
     * The same joins as the rows query, and it needs every one of them.
     *
     * This selected from `commissions` alone. The moment a search term was
     * typed, the shared whereClause named orders, customers, depots and
     * products — tables this query had never heard of — and Postgres answered
     * with a missing-FROM-clause error. Every search on this page was a 500,
     * on every keystroke.
     *
     * The rows query worked because it joins all four. Whatever the filters
     * can reference, both halves have to be able to see; keeping the two in
     * step is the whole requirement, which is why they are written the same
     * way rather than the count being trimmed to what it "needs".
     */
    db
      .select({ total: count() })
      .from(commissions)
      .leftJoin(orders, eq(commissions.orderId, orders.id))
      .leftJoin(customers, eq(commissions.customerId, customers.id))
      .leftJoin(depots, eq(commissions.depotId, depots.id))
      .leftJoin(products, eq(commissions.productId, products.id))
      .leftJoin(pfis, eq(orders.pfiId, pfis.id))
      .where(whereClause),
  ]);

  /**
   * No per-row truck query any more.
   *
   * This ran one SELECT per commission to fill a Trucks column the page no
   * longer has — 50 extra round trips for a page of 50, and the reason the
   * list could not simply return everything. Nothing else read it.
   */
  const enriched = rows.map((row) => {
    const comp = row.orderCompanyName || row.customerCompanyName || "";
    const ref = row.orderId ? generateOrderReference(comp, row.orderId) : row.orderNumber;
    return {
      ...row,
      orderNumber: ref,
      reference: ref,
      quantity: Number(row.quantity),
      commissionRate: parseFloat(row.commissionRate),
      commissionAmount: parseFloat(row.commissionAmount),
    };
  });

  return {
    commissions: enriched,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const findById = async (id) => {
  const [row] = await db
    .select({
      id: commissions.id,
      orderId: commissions.orderId,
      orderNumber: orders.orderNumber,
      // Needed to derive the reference, exactly as findAll does — the order's
      // own company name wins over the customer's.
      orderCompanyName: orders.companyName,
      customerId: commissions.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerCompanyName: customers.companyName,
      customerCommissionBankName: customers.commissionBankName,
      customerCommissionAccountName: customers.commissionAccountName,
      customerCommissionAccountNumber: customers.commissionAccountNumber,
      depotId: commissions.depotId,
      depotName: depots.name,
      productId: commissions.productId,
      productName: products.name,
      quantity: commissions.quantity,
      commissionRate: commissions.commissionRate,
      commissionAmount: commissions.commissionAmount,
      status: commissions.status,
      paidAt: commissions.paidAt,
      paidBy: commissions.paidBy,
      skippedAt: commissions.skippedAt,
      skipReason: commissions.skipReason,
      createdAt: commissions.createdAt,
    })
    .from(commissions)
    .leftJoin(orders, eq(commissions.orderId, orders.id))
    .leftJoin(customers, eq(commissions.customerId, customers.id))
    .leftJoin(depots, eq(commissions.depotId, depots.id))
    .leftJoin(products, eq(commissions.productId, products.id))
    .where(eq(commissions.id, id))
    .limit(1);

  if (!row) return null;

  // Decorated the same way findAll decorates its rows. Without this the
  // commission DETAIL view returned the raw `ORD-…` column while the LIST
  // showed the reference, so one screen disagreed with the other about what
  // the same order is called.
  const company = row.orderCompanyName || row.customerCompanyName || "";
  const ref = row.orderId ? generateOrderReference(company, row.orderId) : row.orderNumber;
  return { ...row, orderNumber: ref, reference: ref };
};

const create = async (data, tx = db) => {
  const [row] = await tx.insert(commissions).values(data).returning();
  return row;
};

const findByOrderId = async (orderId) => {
  const [row] = await db
    .select()
    .from(commissions)
    .where(eq(commissions.orderId, orderId))
    .limit(1);
  return row || null;
};

/**
 * Re-snapshot a commission whose basis has moved — the later instalments of a
 * part-paid order, where each payment enlarges the quantity commission is due
 * on. Only ever called for a still-pending row; see commission.service.
 */
const update = async (id, data, tx = db) => {
  const [row] = await tx
    .update(commissions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(commissions.id, id))
    .returning();
  return row || null;
};

const markAsPaid = async (id, paidBy) => {
  const [row] = await db
    .update(commissions)
    .set({
      status: "paid",
      paidAt: new Date(),
      paidBy,
      updatedAt: new Date(),
    })
    .where(eq(commissions.id, id))
    .returning();
  return row || null;
};

/**
 * Settle a commission without paying it.
 *
 * The counterpart to markAsPaid, and deliberately as small: no wallet credit,
 * no deposit, nothing leaves. What it records is who decided and why, because
 * "we do not pay commission on this one" is a decision somebody has to be able
 * to stand behind months later.
 */
const markAsSkipped = async (id, skippedBy, reason = "") => {
  const [row] = await db
    .update(commissions)
    .set({
      status: "skipped",
      skippedAt: new Date(),
      skippedBy,
      skipReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(commissions.id, id))
    .returning();
  return row || null;
};

/**
 * The wallet credit a commission wrote, back when confirming one did that.
 *
 * The wallet era referenced its deposits `COM-<orderNumber>-<commissionId>`,
 * so the commission is recoverable from the reference. 56 of the 194 paid
 * commissions have one. It matters on an undo: taking such a commission back
 * to pending leaves the customer holding a credit for money the desk is now
 * saying it has not paid.
 */
const findWalletCreditFor = async (commissionId) => {
  const rows = await db
    .select({ id: deposits.id, amount: deposits.amount, reference: deposits.reference })
    .from(deposits)
    .where(ilike(deposits.reference, `COM-%-${parseInt(commissionId)}`))
    .limit(1);
  return rows[0] || null;
};

/** Pending commissions on one depot and product — what a rate change affects. */
const findPendingFor = async (depotId, productId) =>
  db
    .select()
    .from(commissions)
    .where(
      and(
        eq(commissions.depotId, parseInt(depotId)),
        eq(commissions.productId, parseInt(productId)),
        eq(commissions.status, "pending"),
      ),
    );

/**
 * Back to pending, and forget how it got settled.
 *
 * Both settlement stamps are cleared, not just the one that applied: a row
 * that carried a skip reason and is now pending again must not keep the
 * sentence explaining why it was never going to be paid.
 */
const revertToPending = async (id) => {
  const [row] = await db
    .update(commissions)
    .set({
      status: "pending",
      paidAt: null,
      paidBy: null,
      skippedAt: null,
      skippedBy: null,
      skipReason: "",
      updatedAt: new Date(),
    })
    .where(eq(commissions.id, id))
    .returning();
  return row || null;
};

const getSummary = async ({ depotId, customerId, dateFrom, dateTo } = {}) => {
  const conditions = [];
  if (depotId) conditions.push(eq(commissions.depotId, parseInt(depotId)));
  if (customerId) conditions.push(eq(commissions.customerId, parseInt(customerId)));
  // Same as findAll above: a Date through sql`` has no column type behind it
  // and the driver rejects it, so the summary 500'd on the same requests.
  if (dateFrom) conditions.push(gte(commissions.createdAt, new Date(dateFrom)));
  if (dateTo) {
    const end = new Date(dateTo);
    end.setHours(23, 59, 59, 999);
    conditions.push(lte(commissions.createdAt, end));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  /**
   * Skipped rows are left out of the totals, not just out of the money.
   *
   * pendingAmount and paidAmount already excluded them — a skipped commission
   * is one the desk decided is not payable — but totalOrders and
   * totalQuantity counted them, so a customer with a skipped row saw orders
   * and litres that do not reconcile to the two figures beside them. On a
   * commission statement that reads as money gone missing, which is the one
   * impression this page must never give. 22 skipped rows carry 13.9m litres
   * today, so the gap was not theoretical.
   *
   * The skipped figures are returned separately rather than hidden entirely:
   * the customer bought that fuel, and a client that wants to account for it
   * can, without it being added to what they are owed.
   */
  const notSkipped = sql`${commissions.status} <> 'skipped'`;

  const [stats] = await db
    .select({
      totalOrders: sql`COUNT(*) FILTER (WHERE ${notSkipped})`,
      totalQuantity: sql`COALESCE(SUM(${commissions.quantity}) FILTER (WHERE ${notSkipped}), 0)`,
      pendingAmount: sql`COALESCE(SUM(CASE WHEN ${commissions.status} = 'pending' THEN ${commissions.commissionAmount} ELSE 0 END), 0)`,
      paidAmount: sql`COALESCE(SUM(CASE WHEN ${commissions.status} = 'paid' THEN ${commissions.commissionAmount} ELSE 0 END), 0)`,
      skippedOrders: sql`COUNT(*) FILTER (WHERE ${commissions.status} = 'skipped')`,
      skippedQuantity: sql`COALESCE(SUM(${commissions.quantity}) FILTER (WHERE ${commissions.status} = 'skipped'), 0)`,
    })
    .from(commissions)
    .where(whereClause);

  return {
    totalOrders: Number(stats.totalOrders) || 0,
    totalQuantity: Number(stats.totalQuantity) || 0,
    pendingAmount: parseFloat(stats.pendingAmount) || 0,
    paidAmount: parseFloat(stats.paidAmount) || 0,
    /** Decided not payable. Outside every figure above. */
    skippedOrders: Number(stats.skippedOrders) || 0,
    skippedQuantity: Number(stats.skippedQuantity) || 0,
  };
};

module.exports = {
  getRate,
  getRates,
  upsertRate,
  findAll,
  findById,
  findByOrderId,
  create,
  update,
  markAsPaid,
  markAsSkipped,
  revertToPending,
  findPendingFor,
  findWalletCreditFor,
  getSummary,
};
