const { eq, and, isNull, isNotNull, desc, count, sql, inArray, notInArray, lt } = require("drizzle-orm");
const { db } = require("../config/db");
const { notifications } = require("../db/schema");
const { principalValues, principalWhere } = require("../utils/principal");

/**
 * The in-app inbox. Every read here is scoped to a principal — there is no
 * "find any notification by id" helper on purpose, because an unscoped lookup
 * is exactly how one customer ends up reading another's row.
 */

/**
 * Insert one inbox row.
 *
 * Returns null when a `dedupeKey` collides: the caller has already sent this,
 * and a second buzz for the same event is a bug, not a feature. Callers treat
 * null as "already delivered, do nothing further".
 */
const create = async (data, tx = db) => {
  const { principal, ...rest } = data;
  const values = {
    ...rest,
    ...principalValues(principal, "recipientType"),
  };

  const rows = await tx
    .insert(notifications)
    .values(values)
    .onConflictDoNothing({
      target: notifications.dedupeKey,
      where: sql`${notifications.dedupeKey} IS NOT NULL`,
    })
    .returning();

  return rows[0] || null;
};

/** Bulk insert for fan-out to many recipients. Same dedupe semantics. */
const createMany = async (rows, tx = db) => {
  if (!rows.length) return [];
  const values = rows.map(({ principal, ...rest }) => ({
    ...rest,
    ...principalValues(principal, "recipientType"),
  }));

  return tx
    .insert(notifications)
    .values(values)
    .onConflictDoNothing({
      target: notifications.dedupeKey,
      where: sql`${notifications.dedupeKey} IS NOT NULL`,
    })
    .returning();
};

/**
 * `excludeTypes` hides the types a staff member has had switched off on Manage
 * Users (notifications/staffChoices.js), so an untick clears their bell at
 * once instead of after their backlog of old rows is read.
 */
const withoutTypes = (excludeTypes) =>
  excludeTypes?.length ? [notInArray(notifications.type, excludeTypes)] : [];

const buildFilters = (principal, { category, type, unreadOnly, includeArchived, excludeTypes } = {}) => {
  const conditions = [principalWhere(notifications, principal), ...withoutTypes(excludeTypes)];
  if (category && category !== "all") conditions.push(eq(notifications.category, category));
  if (type) conditions.push(eq(notifications.type, type));
  if (unreadOnly) conditions.push(isNull(notifications.readAt));
  if (!includeArchived) conditions.push(isNull(notifications.archivedAt));
  return and(...conditions);
};

/** The inbox screen: newest first, paginated, with the unread badge alongside. */
const findForPrincipal = async (
  principal,
  { page = 1, limit = 20, category, type, unreadOnly = false, includeArchived = false, excludeTypes } = {}
) => {
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const offset = (pageNum - 1) * limitNum;

  const whereClause = buildFilters(principal, { category, type, unreadOnly, includeArchived, excludeTypes });

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(whereClause)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(notifications).where(whereClause),
  ]);

  return {
    rows,
    pagination: {
      total: Number(total),
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(Number(total) / limitNum) || 1,
    },
  };
};

/** The badge. Hits the partial unread index; called on every app foreground. */
const unreadCount = async (principal, { excludeTypes } = {}) => {
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(
      and(
        principalWhere(notifications, principal),
        ...withoutTypes(excludeTypes),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt)
      )
    );
  return Number(row?.total || 0);
};

/** Per-category unread tallies, for tabbed inboxes. */
const unreadCountsByCategory = async (principal, { excludeTypes } = {}) => {
  const rows = await db
    .select({ category: notifications.category, total: count() })
    .from(notifications)
    .where(
      and(
        principalWhere(notifications, principal),
        ...withoutTypes(excludeTypes),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt)
      )
    )
    .groupBy(notifications.category);

  return rows.reduce((acc, r) => {
    acc[r.category] = Number(r.total);
    return acc;
  }, {});
};

/** Scoped read — returns null when the row belongs to someone else. */
const findByIdForPrincipal = async (id, principal) => {
  const [row] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, Number(id)), principalWhere(notifications, principal)))
    .limit(1);
  return row || null;
};

/** Idempotent: re-reading an already-read row keeps the original timestamp. */
const markRead = async (id, principal) => {
  const [row] = await db
    .update(notifications)
    .set({ readAt: sql`COALESCE(${notifications.readAt}, NOW())` })
    .where(and(eq(notifications.id, Number(id)), principalWhere(notifications, principal)))
    .returning();
  return row || null;
};

const markUnread = async (id, principal) => {
  const [row] = await db
    .update(notifications)
    .set({ readAt: null })
    .where(and(eq(notifications.id, Number(id)), principalWhere(notifications, principal)))
    .returning();
  return row || null;
};

/** "Mark all read", optionally narrowed to one category or an explicit set. */
const markAllRead = async (principal, { category, ids } = {}) => {
  const conditions = [principalWhere(notifications, principal), isNull(notifications.readAt)];
  if (category && category !== "all") conditions.push(eq(notifications.category, category));
  if (Array.isArray(ids) && ids.length > 0) {
    conditions.push(inArray(notifications.id, ids.map(Number)));
  }

  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });

  return rows.length;
};

const archive = async (id, principal) => {
  const [row] = await db
    .update(notifications)
    .set({ archivedAt: sql`COALESCE(${notifications.archivedAt}, NOW())` })
    .where(and(eq(notifications.id, Number(id)), principalWhere(notifications, principal)))
    .returning();
  return row || null;
};

const archiveAll = async (principal, { category } = {}) => {
  const conditions = [principalWhere(notifications, principal), isNull(notifications.archivedAt)];
  if (category && category !== "all") conditions.push(eq(notifications.category, category));

  const rows = await db
    .update(notifications)
    .set({ archivedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });

  return rows.length;
};

/** Hard delete of one row the principal owns. */
const remove = async (id, principal) => {
  const rows = await db
    .delete(notifications)
    .where(and(eq(notifications.id, Number(id)), principalWhere(notifications, principal)))
    .returning({ id: notifications.id });
  return rows.length > 0;
};

/**
 * Retention sweep. Deletes READ or ARCHIVED rows past the cutoff only —
 * something the recipient has never seen is never swept out from under them,
 * however old it is.
 */
const purgeOlderThan = async (cutoff) => {
  const rows = await db
    .delete(notifications)
    .where(
      and(
        lt(notifications.createdAt, cutoff),
        sql`(${notifications.readAt} IS NOT NULL OR ${notifications.archivedAt} IS NOT NULL)`
      )
    )
    .returning({ id: notifications.id });
  return rows.length;
};

/** Everything ever sent about one entity — the support view on an order. */
const findByEntity = async (entityType, entityId, { limit = 50 } = {}) => {
  return db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.entityType, entityType), eq(notifications.entityId, String(entityId)))
    )
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(200, Math.max(1, parseInt(limit) || 50)));
};

module.exports = {
  create,
  createMany,
  findForPrincipal,
  unreadCount,
  unreadCountsByCategory,
  findByIdForPrincipal,
  markRead,
  markUnread,
  markAllRead,
  archive,
  archiveAll,
  remove,
  purgeOlderThan,
  findByEntity,
};
