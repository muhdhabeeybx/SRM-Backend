const { eq, and, or, ilike, desc, asc, sql, count, ne, isNull, isNotNull } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff } = require("../db/schema");
const bcrypt = require("bcrypt");

const findById = async (id) => {
  const numericId = parseInt(id, 10);
  const targetId = isNaN(numericId) ? id : numericId;
  const [row] = await db.select().from(staff).where(eq(staff.id, targetId)).limit(1);
  return row || null;
};

const findByEmail = async (email) => {
  const [row] = await db
    .select()
    .from(staff)
    .where(eq(staff.email, email.toLowerCase()))
    .limit(1);
  return row || null;
};

const findByPasswordResetToken = async (hashedToken) => {
  const [row] = await db
    .select()
    .from(staff)
    .where(
      and(
        eq(staff.passwordResetToken, hashedToken),
        sql`${staff.passwordResetExpires} > NOW()`
      )
    )
    .limit(1);
  return row || null;
};

const findAll = async ({ search, page = 1, limit = 50 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(staff.firstName, pattern),
        ilike(staff.surname, pattern),
        ilike(staff.email, pattern)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(staff)
      .where(whereClause)
      .orderBy(desc(staff.createdAt))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(staff)
      .where(whereClause),
  ]);

  return {
    staff: rows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data) => {
  const insertData = { ...data };
  if (insertData.password) {
    insertData.password = await bcrypt.hash(insertData.password, 10);
  }
  if (insertData.email) {
    insertData.email = insertData.email.toLowerCase();
  }
  const [row] = await db.insert(staff).values(insertData).returning();
  return row;
};

const update = async (id, data) => {
  const updateData = { ...data, updatedAt: new Date() };
  if (updateData.password) {
    updateData.password = await bcrypt.hash(updateData.password, 10);
  }
  if (updateData.email) {
    updateData.email = updateData.email.toLowerCase();
  }
  const [row] = await db
    .update(staff)
    .set(updateData)
    .where(eq(staff.id, id))
    .returning();
  return row || null;
};

const deleteById = async (id, tx = db) => {
  const [row] = await tx.delete(staff).where(eq(staff.id, id)).returning();
  return row || null;
};

const comparePassword = async (staffMember, candidatePassword) => {
  if (!staffMember.password) return false;
  return bcrypt.compare(candidatePassword, staffMember.password);
};

module.exports = {
  findById,
  findByEmail,
  findByPasswordResetToken,
  findAll,
  create,
  update,
  deleteById,
  comparePassword,
};
