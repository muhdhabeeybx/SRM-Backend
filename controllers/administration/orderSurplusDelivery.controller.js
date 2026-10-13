const asyncHandler = require("express-async-handler");
const surplusDelivery = require("../../services/orderSurplusDelivery.service");
const { staffActor } = require("../../utils/actor");

/**
 * Delivery money found in a paid order's surplus —
 * services/orderSurplusDelivery.service.js.
 *
 * GET  /orders/:id/delivery-from-surplus                 the entries on the order
 * POST /orders/:id/delivery-from-surplus                 { amount, note } record some of the surplus as delivery
 * POST /orders/:id/delivery-from-surplus/:entryId/void   { reason } take one back
 *
 * Writing is finance or an admin, enforced on the route.
 */

const list = asyncHandler(async (req, res) => {
  const entries = await surplusDelivery.listForOrder(req.params.id);
  res.json({ success: true, data: { entries } });
});

const record = asyncHandler(async (req, res) => {
  const result = await surplusDelivery.record(req.params.id, req.body || {}, staffActor(req));
  res.status(201).json({ success: true, message: "Recorded as delivery", data: result });
});

const voidEntry = asyncHandler(async (req, res) => {
  const result = await surplusDelivery.voidEntry(req.params.id, req.params.entryId, req.body || {}, staffActor(req));
  res.json({ success: true, message: "Taken back into the surplus", data: result });
});

module.exports = { list, record, voidEntry };
