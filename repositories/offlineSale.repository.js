const { eq, and, or, ilike, asc, desc, count, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const { offlineSales, offlineSaleItems, products } = require("../db/schema");
const { dayEdge, lagosToday, localDateStr } = require("../lib/zonedDay");

// Whitelist, not passthrough: sort input never reaches SQL unvalidated.
const SORTABLE = {
  createdAt: offlineSales.createdAt,
  totalAmount: offlineSales.totalAmount,
  saleNumber: offlineSales.saleNumber,
  status: offlineSales.status,
};

const findById = async (id) => {
  const [row] = await db.select().from(offlineSales).where(eq(offlineSales.id, id)).limit(1);
  return row || null;
};

const findByIdWithItems = async (id) => {
  const sale = await findById(id);
  if (!sale) return null;
  const items = await db
    .select({
      id: offlineSaleItems.id,
      productId: offlineSaleItems.productId,
      productName: products.name,
      productSku: products.sku,
      quantity: offlineSaleItems.quantity,
      unitPrice: offlineSaleItems.unitPrice,
      lineTotal: offlineSaleItems.lineTotal,
    })
    .from(offlineSaleItems)
    .leftJoin(products, eq(offlineSaleItems.productId, products.id))
    .where(eq(offlineSaleItems.offlineSaleId, id));
  return { ...sale, items };
};

const findAll = async ({ status, search, reconciled, dateFrom, dateTo, sort, order, page = 1, limit = 50 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (status) conditions.push(eq(offlineSales.status, status));
  if (reconciled !== undefined) conditions.push(eq(offlineSales.reconciled, reconciled));
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(offlineSales.saleNumber, pattern),
        ilike(offlineSales.customerName, pattern),
        ilike(offlineSales.location, pattern)
      )
    );
  }
  if (dateFrom) conditions.push(gte(offlineSales.createdAt, dayEdge(dateFrom, "start")));
  if (dateTo) conditions.push(lte(offlineSales.createdAt, dayEdge(dateTo, "end")));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(offlineSales)
      .where(whereClause)
      .orderBy(
        (order === "asc" ? asc : desc)(SORTABLE[sort] || offlineSales.createdAt),
        desc(offlineSales.id)
      )
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(offlineSales).where(whereClause),
  ]);

  return {
    sales: rows,
    pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  };
};

const update = async (id, data) => {
  const [row] = await db
    .update(offlineSales)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(offlineSales.id, id))
    .returning();
  return row || null;
};

module.exports = { findById, findByIdWithItems, findAll, update };
