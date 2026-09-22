const { eq, and, ilike, desc, count, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { customerLicenses, customers } = require("../db/schema");

const findByCustomerId = async (customerId, tx = db) => {
  return tx
    .select()
    .from(customerLicenses)
    .where(eq(customerLicenses.customerId, customerId))
    .orderBy(customerLicenses.createdAt);
};

const findById = async (id, tx = db) => {
  const [row] = await tx
    .select()
    .from(customerLicenses)
    .where(eq(customerLicenses.id, id))
    .limit(1);
  return row || null;
};

const findByIdWithCustomer = async (id, tx = db) => {
  const [row] = await tx
    .select({
      id: customerLicenses.id,
      customerId: customerLicenses.customerId,
      companyName: customerLicenses.companyName,
      licenseUrl: customerLicenses.licenseUrl,
      licensePublicId: customerLicenses.licensePublicId,
      expiryDate: customerLicenses.expiryDate,
      status: customerLicenses.status,
      verifiedBy: customerLicenses.verifiedBy,
      verifiedByName: customerLicenses.verifiedByName,
      verifiedAt: customerLicenses.verifiedAt,
      verificationComment: customerLicenses.verificationComment,
      createdAt: customerLicenses.createdAt,
      updatedAt: customerLicenses.updatedAt,
      customerName: customers.name,
      customerEmail: customers.email,
      customerPhone: customers.phone,
      customerCompanyName: customers.companyName,
    })
    .from(customerLicenses)
    .leftJoin(customers, eq(customerLicenses.customerId, customers.id))
    .where(eq(customerLicenses.id, id))
    .limit(1);
  return row || null;
};

const findAll = async ({
  status,
  search,
  customerId,
  page = 1,
  limit = 50,
  /** Only customers with an order on these PFIs. Null for everyone. */
  onlyPfiIds = null,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (Array.isArray(onlyPfiIds)) {
    conditions.push(
      onlyPfiIds.length
        ? sql`EXISTS (SELECT 1 FROM orders op WHERE op.customer_id = ${customerLicenses.customerId}
                        AND op.pfi_id IN (${sql.join(onlyPfiIds.map((id) => sql`${Number(id)}`), sql`, `)}))`
        : sql`false`,
    );
  }
  if (customerId) conditions.push(eq(customerLicenses.customerId, customerId));
  if (status) conditions.push(eq(customerLicenses.status, status));
  if (search) conditions.push(ilike(customerLicenses.companyName, `%${search}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: customerLicenses.id,
        customerId: customerLicenses.customerId,
        companyName: customerLicenses.companyName,
        licenseUrl: customerLicenses.licenseUrl,
        licensePublicId: customerLicenses.licensePublicId,
        expiryDate: customerLicenses.expiryDate,
        status: customerLicenses.status,
        verifiedBy: customerLicenses.verifiedBy,
        verifiedByName: customerLicenses.verifiedByName,
        verifiedAt: customerLicenses.verifiedAt,
        verificationComment: customerLicenses.verificationComment,
        createdAt: customerLicenses.createdAt,
        updatedAt: customerLicenses.updatedAt,
        customerName: customers.name,
      })
      .from(customerLicenses)
      .leftJoin(customers, eq(customerLicenses.customerId, customers.id))
      .where(whereClause)
      .orderBy(desc(customerLicenses.createdAt))
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(customerLicenses).where(whereClause),
  ]);

  return {
    licenses: rows,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data, tx = db) => {
  const [row] = await tx.insert(customerLicenses).values(data).returning();
  return row;
};

const update = async (id, data, tx = db) => {
  const [row] = await tx
    .update(customerLicenses)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(customerLicenses.id, id))
    .returning();
  return row || null;
};

const deleteById = async (id, tx = db) => {
  const [row] = await tx
    .delete(customerLicenses)
    .where(eq(customerLicenses.id, id))
    .returning();
  return row || null;
};

module.exports = {
  findByCustomerId,
  findById,
  findByIdWithCustomer,
  findAll,
  create,
  update,
  deleteById,
};
