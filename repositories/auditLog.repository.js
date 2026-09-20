const { eq, and, asc, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { auditLogs } = require("../db/schema");

const ACTOR_TYPES = Object.freeze(["staff", "customer", "system"]);

/**
 * Normalise an actor descriptor to the exclusive-arc columns the CHECK
 * enforces. Throwing here (rather than letting the DB reject it) turns a
 * caller mistake into a clear message instead of a 23514.
 *
 * @param {{type: "staff"|"customer"|"system", staffId?: number, customerId?: number}} actor
 */
function actorColumns(actor) {
  if (!actor || !ACTOR_TYPES.includes(actor.type)) {
    throw new TypeError(`auditLog: actor.type must be one of ${ACTOR_TYPES.join("|")}`);
  }
  if (actor.type === "staff") {
    if (!actor.staffId) throw new TypeError("auditLog: staff actor requires staffId");
    return { actorType: "staff", actorStaffId: actor.staffId, actorCustomerId: null };
  }
  if (actor.type === "customer") {
    if (!actor.customerId) throw new TypeError("auditLog: customer actor requires customerId");
    return { actorType: "customer", actorStaffId: null, actorCustomerId: actor.customerId };
  }
  return { actorType: "system", actorStaffId: null, actorCustomerId: null };
}

/**
 * Append one audit event. Takes a tx so it commits atomically with the state
 * change it records — a transition that persisted without its audit row would
 * make the log a liar.
 *
 * @param {object} event
 * @param {string} event.entityType   'order' | 'customer' | …
 * @param {number} event.entityId
 * @param {string} event.action       human label, e.g. 'order.released'
 * @param {string|null} [event.prevState]
 * @param {string|null} [event.newState]  the single source of a timeline entry
 * @param {object} event.actor        { type, staffId?, customerId? }
 * @param {object} [event.metadata]
 * @param {string|null} [event.ipAddress]
 * @param {string|null} [event.userAgent]
 */
const record = async (event, tx = db) => {
  const [row] = await tx
    .insert(auditLogs)
    .values({
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      prevState: event.prevState ?? null,
      newState: event.newState ?? null,
      ...actorColumns(event.actor),
      metadata: event.metadata ?? null,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
    })
    .returning();
  return row;
};

/**
 * Append many audit events in one round trip — the batched sibling of
 * `record`, for a loop that would otherwise write one row per iteration
 * (e.g. a ticket generated per truck in a multi-truck request).
 */
const recordMany = async (events, tx = db) => {
  if (!events.length) return [];
  return tx
    .insert(auditLogs)
    .values(
      events.map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        prevState: event.prevState ?? null,
        newState: event.newState ?? null,
        ...actorColumns(event.actor),
        metadata: event.metadata ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
      })),
    )
    .returning();
};

/** Every event for one entity, oldest first — the raw material for a timeline. */
const findByEntity = async (entityType, entityId) => {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)))
    .orderBy(asc(auditLogs.createdAt));
};

/** State-changing events only — the projected pipeline timeline. */
const findStateTimeline = async (entityType, entityId) => {
  const rows = await findByEntity(entityType, entityId);
  return rows.filter((r) => r.newState !== null);
};

/**
 * Everything that ever happened to one order, oldest first — the order's own
 * events AND the events of every truck on it, merged into a single stream.
 *
 * Two entity types have to be read together because the story is split between
 * them by design: the order carries its status transitions (`order.released`,
 * `order.completed`), while every gate action is recorded against the truck it
 * happened to (`order_truck.gated_in`, `order_truck.loaded`). Reading only the
 * order's own rows would produce a timeline in which no truck ever moves.
 *
 * The actor is resolved to a name here rather than in the caller: `actor_type`
 * decides WHICH table holds it (staff and customers are both serial from 1, so
 * the id alone is ambiguous — see the CHECK on audit_logs), and that is a fact
 * about the schema, not about the page. A `system` actor resolves to no name at
 * all, which the UI renders as "System".
 *
 * `truckNumber` is joined in so a truck event can name its plate. It is NULL on
 * the order's own rows, which is how the caller tells the two apart without
 * parsing `action`.
 */
const findOrderTimeline = async (orderId) => {
  const id = Number(orderId);
  const result = await db.execute(sql`
    SELECT a.id,
           a.entity_type  AS "entityType",
           a.entity_id    AS "entityId",
           a.action,
           a.prev_state   AS "prevState",
           a.new_state    AS "newState",
           a.actor_type   AS "actorType",
           a.actor_staff_id    AS "actorStaffId",
           a.actor_customer_id AS "actorCustomerId",
           a.metadata,
           a.created_at   AS "createdAt",
           CASE a.actor_type
             WHEN 'staff'    THEN NULLIF(TRIM(CONCAT(s.first_name, ' ', s.surname)), '')
             WHEN 'customer' THEN c.name
             ELSE NULL
           END AS "actorName",
           CASE a.actor_type WHEN 'staff' THEN s.email ELSE NULL END AS "actorEmail",
           t.truck_number AS "truckNumber",
           t.truck_index  AS "truckIndex"
      FROM audit_logs a
      LEFT JOIN staff     s ON a.actor_type = 'staff'    AND s.id = a.actor_staff_id
      LEFT JOIN customers c ON a.actor_type = 'customer' AND c.id = a.actor_customer_id
      LEFT JOIN order_trucks t ON a.entity_type = 'order_truck' AND t.id = a.entity_id
     WHERE (a.entity_type = 'order' AND a.entity_id = ${id})
        OR (a.entity_type = 'order_truck'
            AND a.entity_id IN (SELECT ot.id FROM order_trucks ot WHERE ot.order_id = ${id}))
     ORDER BY a.created_at ASC, a.id ASC
  `);
  return result.rows ?? result;
};

module.exports = {
  ACTOR_TYPES,
  actorColumns,
  record,
  recordMany,
  findByEntity,
  findStateTimeline,
  findOrderTimeline,
};
