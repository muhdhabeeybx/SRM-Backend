const { eq, and, or, ilike, desc, count, sql, ne, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { deliveryCustomers, deliverySales, staff } = require("../db/schema");
const { CUSTOMER_TYPES, CODE_PREFIX } = require("../lib/customerTypes");

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

/** The LPG plant registered as this lpg_stations row, if any — migration 0061. */
const findByLpgStationId = async (lpgStationId) => {
  if (lpgStationId == null) return null;
  const [row] = await db
    .select()
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.lpgStationId, Number(lpgStationId)))
    .limit(1);
  return row || null;
};

const findAll = async ({
  type,
  search,
  status,
  /** Only these rows — a station-assigned person's stations. Null for all. */
  ids = null,
  /**
   * Only rows linked to these lpg_stations — a plant-assigned person's
   * plants (lib/stationScope.js, scopedPlantIds). Null for all.
   */
  lpgStationIds = null,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (type && CUSTOMER_TYPES.includes(type)) {
    conditions.push(eq(deliveryCustomers.customerType, type));
  }

  if (status) {
    conditions.push(eq(deliveryCustomers.status, status));
  }

  if (Array.isArray(ids)) {
    conditions.push(ids.length ? inArray(deliveryCustomers.id, ids) : sql`false`);
  }

  if (Array.isArray(lpgStationIds)) {
    conditions.push(
      lpgStationIds.length ? inArray(deliveryCustomers.lpgStationId, lpgStationIds) : sql`false`
    );
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
  /** Only these rows. Null for all — see findOneWithSalesAggregation. */
  ids = null,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (type && CUSTOMER_TYPES.includes(type)) {
    conditions.push(eq(deliveryCustomers.customerType, type));
  }

  if (Array.isArray(ids)) {
    conditions.push(ids.length ? inArray(deliveryCustomers.id, ids) : sql`false`);
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
    /*
     * One row per load, then summed — never a plain SUM over sale rows.
     *
     * A customer's rows REPEAT their load: every instalment paid against a
     * truck carries the load's whole quantity and sales value again, so a
     * straight SUM billed a truck once per instalment. On production that put
     * one customer's sales at ₦24.2 billion and his debt at ₦20.6 billion,
     * where his loads come to ₦3.70 billion and he owes ₦100.8 million.
     *
     * So a load is a customer's rows for one truck on one loading day, worth
     * its largest sales value — or rate × quantity where nothing was billed —
     * with every payment against it coming off. The dashboard's own rule:
     * shareMoney in soromanfe/src/lib/delivery-records.ts.
     *
     * A station's rows ACCUMULATE instead — each is a day's pump sales — so
     * for a station they are summed, and what it owes here is what it sold
     * less what it banked. Its account proper (product at landed cost) is
     * built by the dashboard from its loads; see lib/customer-accounts there.
     */
    const salesAggregation = await db.execute(sql`
      WITH loads AS (
        SELECT s.customer_id,
               dc.customer_type IN ('filling_station', 'lpg_plant') AS station,
               MAX(s.sales_value::numeric)  AS top_value,
               SUM(s.sales_value::numeric)  AS all_value,
               -- A row's quantity, read off its money where the two disagree:
               -- a split truck's rows can carry the whole truck's litres
               -- (quantityOf in soromanfe/src/lib/load-split.ts).
               MAX(CASE WHEN s.rate::numeric > 0 AND s.sales_value::numeric > 0
                         AND abs(s.sales_value::numeric / s.rate::numeric - COALESCE(s.quantity::numeric, 0)) > 1
                        THEN s.sales_value::numeric / s.rate::numeric
                        ELSE s.quantity::numeric END) AS top_qty,
               SUM(CASE WHEN s.sales_value::numeric > 0 THEN s.quantity::numeric ELSE 0 END) AS sold_qty,
               MAX(s.rate::numeric)         AS rate,
               SUM(COALESCE(s.payment_amount::numeric, 0)) AS paid,
               MAX(s.date_of_payment)       AS last_date
          FROM delivery_sales s
          JOIN delivery_customers dc ON dc.id = s.customer_id
         WHERE s.customer_id IN ${sql.raw(`(${customerIds.map(Number).join(",")})`)}
         GROUP BY s.customer_id, dc.customer_type,
                  regexp_replace(upper(coalesce(s.truck_number, '')), '\\s', '', 'g'),
                  left(coalesce(s.date_loaded, ''), 10)
      )
      SELECT customer_id AS "customerId",
             SUM(CASE WHEN station THEN COALESCE(all_value, 0)
                      WHEN COALESCE(top_value, 0) > 0 THEN top_value
                      ELSE COALESCE(rate, 0) * COALESCE(top_qty, 0) END) AS "totalSalesValue",
             SUM(paid) AS "totalPayments",
             SUM(CASE WHEN station THEN sold_qty ELSE COALESCE(top_qty, 0) END) AS "totalQty",
             MAX(last_date) AS "lastTransactionDate"
        FROM loads
       GROUP BY customer_id`);

    const salesMap = new Map();
    for (const s of salesAggregation.rows ?? salesAggregation) {
      salesMap.set(Number(s.customerId), s);
    }

    enrichedCustomers = rows.map((c) => {
      const sales = salesMap.get(c.id);
      if (sales) {
        return {
          ...c,
          totalSalesValue: Number(sales.totalSalesValue) || 0,
          totalPayments: Number(sales.totalPayments) || 0,
          totalQty: Number(sales.totalQty) || 0,
          outstanding: (Number(sales.totalSalesValue) || 0) - (Number(sales.totalPayments) || 0),
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

/**
 * One customer with the same sales totals the directory list carries, so a
 * profile opened by its link reads the same as one opened from the list.
 */
const findOneWithSalesAggregation = async (id) => {
  const { customers } = await findAllWithSalesAggregation({ ids: [Number(id)], limit: 1 });
  return customers[0] || null;
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
  const prefix = CODE_PREFIX[customerType] || CODE_PREFIX.customer;
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
  findOneWithSalesAggregation,
  findByLpgStationId,
  create,
  update,
  deleteById,
  generateCustomerCode,
};
