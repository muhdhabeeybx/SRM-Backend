const { and, eq, isNull, desc, count, or, ne, notInArray, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { notifications, orders } = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");
const { isConfined } = require("../lib/pfiScope");
const staffChoices = require("../notifications/staffChoices");

/**
 * A staff member's notifications, as their dashboard shows them: only what is
 * about them.
 *
 * Their own inbox — the bell's rows, never anybody else's — less two kinds of
 * notice that are sent to everybody holding a role and so reach people they
 * have nothing to do with:
 *
 *   order placed, payment received   sent to every sales and finance manager
 *                                    for every order in the company. Kept only
 *                                    when the order is inside this person's
 *                                    scope, by the same rule their order list
 *                                    uses (lib/scopeFilter.js): their PFIs if
 *                                    they have any, else their depots, else
 *                                    everything.
 *
 *   Dangote and LPG requests         kept for everyone except staff confined
 *                                    to a PFI, who cannot open those pages
 *                                    (lib/pfiScope.js, denyPfiScoped).
 *
 * Everything else in the inbox — their expense requests moving, their desk's
 * backlog nudges — was addressed to them in particular, and stays, unless an
 * admin has switched that kind of notice off for them on Manage Users
 * (notifications/staffChoices.js), exactly as the bell hides it.
 *
 * Read-only. Marking read goes through the inbox's own endpoints, so the bell
 * and the dashboard cannot disagree about what has been seen.
 */

/** Requests from areas with no PFI link. */
const UNLINKED_REQUESTS = ["dangote_request", "lpg_request"];

/** The order a notification is about, when it is about one. */
const ORDER_JOIN = sql`${orders.id} = CASE
  WHEN ${notifications.entityType} = 'order' AND ${notifications.entityId} ~ '^[0-9]+$'
  THEN ${notifications.entityId}::int END`;

const aboutThem = (user, hiddenTypes = []) => {
  const conditions = [
    eq(notifications.recipientType, "staff"),
    eq(notifications.staffId, Number(user.id)),
    isNull(notifications.archivedAt),
  ];

  const orderScope = scopeCondition(user, { depotColumn: orders.depotId, pfiColumn: orders.pfiId });
  if (orderScope) conditions.push(or(ne(notifications.entityType, "order"), orderScope));

  if (isConfined(user)) conditions.push(notInArray(notifications.entityType, UNLINKED_REQUESTS));
  if (hiddenTypes.length) conditions.push(notInArray(notifications.type, hiddenTypes));

  return and(...conditions);
};

/**
 * @param user  the authenticated staff member (req.user)
 * @returns {Promise<{ items: object[], unreadCount: number }>}
 */
const getMyNotifications = async (user, { limit = 8 } = {}) => {
  if (!user?.id) return { items: [], unreadCount: 0 };
  const take = Math.min(30, Math.max(1, parseInt(limit) || 8));
  const where = aboutThem(user, await staffChoices.mutedTypesFor(user.id));

  const [rows, [{ unread }]] = await Promise.all([
    db
      .select({ n: notifications })
      .from(notifications)
      .leftJoin(orders, ORDER_JOIN)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(take),
    db
      .select({ unread: count() })
      .from(notifications)
      .leftJoin(orders, ORDER_JOIN)
      .where(and(where, isNull(notifications.readAt))),
  ]);

  return {
    items: rows.map(({ n }) => ({
      id: n.id,
      type: n.type,
      category: n.category,
      priority: n.priority,
      title: n.title,
      body: n.body,
      actionUrl: n.actionUrl || null,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    unreadCount: Number(unread || 0),
  };
};

module.exports = { getMyNotifications };
