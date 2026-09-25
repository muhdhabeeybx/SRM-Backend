const { eq, and, or, ilike, desc, count, sql, ne, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { deliveryCustomers, deliverySales, staff } = require("../db/schema");

const findById = async (id) => {
  const [row] = await db
    .select()
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.id, id))
    .limit(1);
  return row || null;
};

const findByCode = async (customerCode) => {
  const [row] = await db
    .select()
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.customerCode, customerCode))
    .limit(1);
  return row || null;
};

const findByVirtualAccount = async (accountNumber) => {
  if (!accountNumber) return null;
  const cleanAcc = String(accountNumber).trim();
  const [row] = await db
    .select()
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.virtualAccountNumber, cleanAcc))
    .limit(1);
  return row || null;
};

const findAll = async ({
  type,
  search,
  status,
  /** Only these rows — a station-assigned person's stations. Null for all. */
  ids = null,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (type && ["customer", "filling_station"].includes(type)) {
    conditions.push(eq(deliveryCustomers.customerType, type));
  }

  if (status) {
    conditions.push(eq(deliveryCustomers.status, status));
  }

  if (Array.isArray(ids)) {
    conditions.push(ids.length ? inArray(deliveryCustomers.id, ids) : sql`false`);
  }

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(deliveryCustomers.name, pattern),
        ilike(deliveryCustomers.phoneNumber, pattern),
        ilike(deliveryCustomers.customerCode, pattern),
        ilike(deliveryCustomers.contactPerson, pattern)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(deliveryCustomers)
      .where(whereClause)
      .orderBy(desc(deliveryCustomers.createdAt))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(deliveryCustomers)
      .where(whereClause),
  ]);

  return {
    customers: rows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const findAllWithSalesAggregation = async ({
  type,
  search,
  status,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (type && ["customer", "filling_station"].includes(type)) {
    conditions.push(eq(deliveryCustomers.customerType, type));
  }

  if (status) {
    conditions.push(eq(deliveryCustomers.status, status));
  }

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(deliveryCustomers.name, pattern),
        ilike(deliveryCustomers.phoneNumber, pattern),
        ilike(deliveryCustomers.customerCode, pattern),
        ilike(deliveryCustomers.contactPerson, pattern)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get customers
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(deliveryCustomers)
      .where(whereClause)
      .orderBy(desc(deliveryCustomers.createdAt))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(deliveryCustomers)
      .where(whereClause),
  ]);

  // Get sales aggregation for these customers
  const customerIds = rows.map((c) => c.id);

  let enrichedCustomers = rows.map((c) => ({
    ...c,
    totalSalesValue: 0,
    totalPayments: 0,
    totalQty: 0,
    outstanding: 0,
  }));

  if (customerIds.length > 0) {
    const salesAggregation = await db
      .select({
        customerId: deliverySales.customerId,
        totalSalesValue: sql`COALESCE(SUM(${deliverySales.salesValue}), 0)`,
        totalPayments: sql`COALESCE(SUM(${deliverySales.paymentAmount}), 0)`,
        totalExpenses: sql`COALESCE(SUM(${deliverySales.expensesAmount}), 0)`,
        totalQty: sql`COALESCE(SUM(${deliverySales.quantity}), 0)`,
        lastTransactionDate: sql`MAX(${deliverySales.dateOfPayment})`,
      })
      .from(deliverySales)
      .where(inArray(deliverySales.customerId, customerIds))
      .groupBy(deliverySales.customerId);

    const salesMap = new Map();
    for (const s of salesAggregation) {
      salesMap.set(s.customerId, s);
    }

    enrichedCustomers = rows.map((c) => {
      const sales = salesMap.get(c.id);
      if (sales) {
        return {
          ...c,
          totalSalesValue: Number(sales.totalSalesValue) || 0,
          totalPayments: Number(sales.totalPayments) || 0,
          totalQty: Number(sales.totalQty) || 0,
          outstanding:
            (Number(sales.totalSalesValue) || 0) -
            (Number(sales.totalPayments) || 0) -
            (Number(sales.totalExpenses) || 0),
          lastTransactionDate:
            sales.lastTransactionDate || c.lastTransactionDate || null,
        };
      }
      return {
        ...c,
        totalSalesValue: 0,
        totalPayments: 0,
        totalQty: 0,
        outstanding: 0,
      };
    });
  }

  return {
    customers: enrichedCustomers,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data) => {
  const [row] = await db.insert(deliveryCustomers).values(data).returning();
  return row;
};

const update = async (id, data) => {
  const [row] = await db
    .update(deliveryCustomers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(deliveryCustomers.id, id))
    .returning();
  return row || null;
};

const deleteById = async (id) => {
  const [row] = await db
    .delete(deliveryCustomers)
    .where(eq(deliveryCustomers.id, id))
    .returning();
  return row || null;
};

const generateCustomerCode = async (customerType) => {
  const prefix = customerType === "filling_station" ? "STN" : "CUST";
  const [{ total }] = await db
    .select({ total: count() })
    .from(deliveryCustomers);
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${total + 1}-${randomNum}`;
};

module.exports = {
  findById,
  findByCode,
  findByVirtualAccount,
  findAll,
  findAllWithSalesAggregation,
  create,
  update,
  deleteById,
  generateCustomerCode,
};
