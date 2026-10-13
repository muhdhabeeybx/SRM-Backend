const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { orderRepo } = require("../repositories");
const auditLogRepo = require("../repositories/auditLog.repository");
const { recomputeOrder } = require("./orderPayment.service");
const { round2 } = require("../lib/orderDelivery");

/**
 * Delivery money found in a paid order's surplus (migration 0080).
 *
 * A customer pays for product and delivery; nobody had entered the delivery
 * charge before the money landed (0078 allows that only while the order is
 * unpaid), so the delivery reads as overpayment "held" for them. Finance or an
 * admin records that part of the surplus as delivery:
 *
 *   - it joins the order's delivery_fee and total_amount, so the order is
 *     square on every page — no surplus to refund or move, no held balance;
 *   - the PFI's sales are untouched: every sales reader already takes
 *     delivery_fee back out of total_amount;
 *   - delivery_from_surplus remembers how much came in this way, so the
 *     Finance Report can leave the rows it already printed as they were and
 *     list these separately (the owner's choice), and so a recompute from the
 *     rate keeps it.
 *
 * Only on a delivery order, only up to the surplus actually there, and taken
 * back by voiding — never deleted. Each step is audited with who did it.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const kobo = (n) => Math.round(Number(n || 0) * 100);

const surplusOf = (order) => round2(Number(order.amountPaid || 0) - Number(order.totalAmount || 0));

/** The live entries on an order, oldest first. */
const listForOrder = async (orderId, tx = db) => {
  const result = await tx.execute(sql`
    SELECT id, order_id AS "orderId", amount::text AS amount, note,
           recorded_by AS "recordedBy", recorded_by_name AS "recordedByName", created_at AS "createdAt",
           voided_at AS "voidedAt", voided_by_name AS "voidedByName", void_reason AS "voidReason"
      FROM order_surplus_deliveries
     WHERE order_id = ${Number(orderId)}
     ORDER BY id`);
  return (result.rows ?? result).map((r) => ({ ...r, amount: Number(r.amount) }));
};

/**
 * Record `amount` of the order's surplus as its delivery.
 * @returns {Promise<{ entry, order }>}
 */
const record = async (orderId, { amount, note = "" }, actor) => {
  const value = round2(Number(String(amount ?? "").replace(/,/g, "")));
  if (!Number.isFinite(value) || value <= 0) throw httpError(400, "Enter the delivery amount, more than 0");

  return db.transaction(async (tx) => {
    const order = await orderRepo.lockById(Number(orderId), tx);
    if (!order) throw httpError(404, "Order not found");
    if (order.deliveryType !== "delivery") {
      throw httpError(400, "Delivery money goes only on a delivery order");
    }
    if (order.status === "Cancelled" || order.status === "Expired") {
      throw httpError(409, `${order.reference} is ${order.status.toLowerCase()}`);
    }
    const surplus = surplusOf(order);
    if (kobo(surplus) <= 0) {
      throw httpError(409, `${order.reference} has no surplus to record as delivery`);
    }
    if (kobo(value) > kobo(surplus)) {
      throw httpError(400, `That is more than the surplus on ${order.reference} (₦${surplus.toLocaleString("en-NG")})`);
    }

    const fee = round2(Number(order.deliveryFee || 0) + value);
    const fromSurplus = round2(Number(order.deliveryFromSurplus || 0) + value);
    const total = round2(Number(order.totalAmount || 0) + value);

    await tx.execute(sql`
      UPDATE orders SET
        delivery_fee = ${fee.toFixed(2)}::numeric,
        delivery_from_surplus = ${fromSurplus.toFixed(2)}::numeric,
        total_amount = ${total.toFixed(2)}::numeric,
        updated_at = now()
      WHERE id = ${order.id}`);
    await recomputeOrder(order.id, tx);

    const inserted = await tx.execute(sql`
      INSERT INTO order_surplus_deliveries (order_id, amount, note, recorded_by, recorded_by_name)
      VALUES (${order.id}, ${value.toFixed(2)}::numeric, ${String(note || "").trim()}, ${actor?.id ?? null}, ${actor?.name || ""})
      RETURNING id, created_at AS "createdAt"`);
    const entry = (inserted.rows ?? inserted)[0];

    await auditLogRepo.record({
      entityType: "order", entityId: order.id, action: "order.delivery_from_surplus",
      actor: { type: "staff", staffId: actor?.id ?? null },
      prevState: { totalAmount: order.totalAmount, deliveryFee: order.deliveryFee, surplus },
      newState: { totalAmount: total.toFixed(2), deliveryFee: fee.toFixed(2), surplus: round2(surplus - value) },
      metadata: { entryId: entry.id, amount: value, note: String(note || "").trim() },
    }, tx);

    return { entry: { id: entry.id, amount: value, createdAt: entry.createdAt }, order: await orderRepo.findById(order.id, tx) };
  });
};

/** Take an entry back: the money returns to the order's surplus. */
const voidEntry = async (orderId, entryId, { reason = "" }, actor) =>
  db.transaction(async (tx) => {
    const order = await orderRepo.lockById(Number(orderId), tx);
    if (!order) throw httpError(404, "Order not found");
    const found = await tx.execute(sql`
      SELECT id, amount::text AS amount FROM order_surplus_deliveries
       WHERE id = ${Number(entryId)} AND order_id = ${order.id} AND voided_at IS NULL
       FOR UPDATE`);
    const row = (found.rows ?? found)[0];
    if (!row) throw httpError(404, "That delivery entry is not on this order, or was already taken back");
    const value = Number(row.amount);
    if (kobo(value) > kobo(order.deliveryFromSurplus)) {
      throw httpError(409, "The order's delivery has changed since; this entry can no longer be taken back on its own");
    }

    const fee = round2(Number(order.deliveryFee || 0) - value);
    const fromSurplus = round2(Number(order.deliveryFromSurplus || 0) - value);
    const total = round2(Number(order.totalAmount || 0) - value);

    await tx.execute(sql`
      UPDATE orders SET
        delivery_fee = ${fee.toFixed(2)}::numeric,
        delivery_from_surplus = ${fromSurplus.toFixed(2)}::numeric,
        total_amount = ${total.toFixed(2)}::numeric,
        updated_at = now()
      WHERE id = ${order.id}`);
    await recomputeOrder(order.id, tx);

    await tx.execute(sql`
      UPDATE order_surplus_deliveries
         SET voided_at = now(), voided_by = ${actor?.id ?? null}, voided_by_name = ${actor?.name || ""},
             void_reason = ${String(reason || "").trim()}
       WHERE id = ${row.id}`);

    await auditLogRepo.record({
      entityType: "order", entityId: order.id, action: "order.delivery_from_surplus_voided",
      actor: { type: "staff", staffId: actor?.id ?? null },
      prevState: { totalAmount: order.totalAmount, deliveryFee: order.deliveryFee },
      newState: { totalAmount: total.toFixed(2), deliveryFee: fee.toFixed(2) },
      metadata: { entryId: row.id, amount: value, reason: String(reason || "").trim() },
    }, tx);

    return { order: await orderRepo.findById(order.id, tx) };
  });

/**
 * For the Finance Report's own block: every live entry on these orders, with
 * the order and customer they belong to.
 */
const listForOrders = async (orderIds, tx = db) => {
  const ids = [...new Set((orderIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return [];
  const result = await tx.execute(sql`
    SELECT e.id, e.order_id AS "orderId", e.amount::text AS amount, e.note,
           e.recorded_by_name AS "recordedByName", e.created_at AS "createdAt",
           c.name AS "customerName", COALESCE(NULLIF(o.company_name, ''), c.company_name, '') AS "companyName",
           o.quantity
      FROM order_surplus_deliveries e
      JOIN orders o ON o.id = e.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE e.voided_at IS NULL AND e.order_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
     ORDER BY e.created_at DESC, e.id DESC`);
  return (result.rows ?? result).map((r) => ({ ...r, amount: Number(r.amount) }));
};

module.exports = { record, voidEntry, listForOrder, listForOrders, surplusOf };
