const { eq, and, or, ilike, asc, desc, count, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const { incidentRecords } = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");
const { dayEdge, lagosToday, localDateStr } = require("../lib/zonedDay");

// Whitelist, not passthrough: sort input never reaches SQL unvalidated.
const SORTABLE = {
  createdAt: incidentRecords.createdAt,
  status: incidentRecords.status,
  incidentType: incidentRecords.incidentType,
  amount: incidentRecords.amount,
};

const findById = async (id) => {
  const [row] = await db
    .select()
    .from(incidentRecords)
    .where(eq(incidentRecords.id, id))
    .limit(1);
  return row || null;
};

const findAll = async ({
  incidentType,
  status,
  search,
  submittedBy,
  dateFrom,
  dateTo,
  sort,
  order,
  page = 1,
  limit = 50,
  scopeUser,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  // An incident is raised against a batch, so the batch is the dimension.
  const scope = scopeCondition(scopeUser, { pfiColumn: incidentRecords.pfiId });
  if (scope) conditions.push(scope);

  if (incidentType) conditions.push(eq(incidentRecords.incidentType, incidentType));
  if (status) conditions.push(eq(incidentRecords.status, status));
  if (submittedBy) conditions.push(eq(incidentRecords.submittedBy, submittedBy));
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(incidentRecords.title, pattern),
        ilike(incidentRecords.location, pattern),
        ilike(incidentRecords.pfiNumber, pattern)
      )
    );
  }
  if (dateFrom) conditions.push(gte(incidentRecords.createdAt, dayEdge(dateFrom, "start")));
  if (dateTo) conditions.push(lte(incidentRecords.createdAt, dayEdge(dateTo, "end")));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(incidentRecords)
      .where(whereClause)
      .orderBy(
        (order === "asc" ? asc : desc)(SORTABLE[sort] || incidentRecords.createdAt),
        desc(incidentRecords.id)
      )
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(incidentRecords).where(whereClause),
  ]);

  return {
    records: rows,
    pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  };
};

const create = async (data) => {
  const [row] = await db.insert(incidentRecords).values(data).returning();
  return row;
};

const update = async (id, data) => {
  const [row] = await db
    .update(incidentRecords)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(incidentRecords.id, id))
    .returning();
  return row || null;
};

module.exports = { findById, findAll, create, update };
