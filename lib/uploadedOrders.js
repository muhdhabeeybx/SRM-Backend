/**
 * An order uploaded by staff from a list (services/orderUpload.service.js).
 *
 * Keyed `order-upload:<batch>:<row>` on the order row itself, the same way a
 * truck allocation's order is keyed (lib/allocationOrders.js), so the rules
 * that treat these orders differently read it off the row they already hold.
 *
 * What is different about them: they are orders the business already took —
 * often on an earlier day — entered after the fact to wait for their payment.
 * The end-of-day lapse exists to clear orders a customer placed and walked
 * away from; applied to these it would expire a back-dated order the moment
 * it was entered. So they never lapse. They are paid, or cancelled by a
 * person, like any other order.
 *
 * The key also makes an upload safe to run twice: the same row of the same
 * list maps to the same key, and placeOrder returns the order it already made.
 */
const PREFIX = "order-upload:";

const orderKey = (batch, row) => `${PREFIX}${batch}:${row}`;

/** Accepts a drizzle row (camelCase) or a raw SQL row (snake_case). */
const isUploadedOrder = (order) =>
  String(order?.idempotencyKey ?? order?.idempotency_key ?? "").startsWith(PREFIX);

module.exports = { PREFIX, orderKey, isUploadedOrder };
