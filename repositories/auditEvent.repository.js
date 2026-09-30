const { eq, and, desc, count, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const { auditEvents } = require("../db/schema");
const { dayEdge, lagosToday, localDateStr } = require("../lib/zonedDay");

const create = async (data) => {
  const [row] = await db.insert(auditEvents).values(data).returning();
  return row;
};

const findAll = async ({
  action,
  entityType,
  entityId,
  actorId,
  dateFrom,
  dateTo,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (action) conditions.push(eq(auditEvents.action, action));
  if (entityType) conditions.push(eq(auditEvents.entityType, entityType));
  if (entityId) conditions.push(eq(auditEvents.entityId, String(entityId)));
  if (actorId) conditions.push(eq(auditEvents.actorId, actorId));
  if (dateFrom) conditions.push(gte(auditEvents.createdAt, dayEdge(dateFrom, "start")));
  if (dateTo) conditions.push(lte(auditEvents.createdAt, dayEdge(dateTo, "end")));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(whereClause)
      .orderBy(desc(auditEvents.createdAt))
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(auditEvents).where(whereClause),
  ]);

  return {
    events: rows,
    pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  };
};

// No update, no delete: the audit trail is append-only by construction.

module.exports = { create, findAll };
