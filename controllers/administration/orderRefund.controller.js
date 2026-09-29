const asyncHandler = require("express-async-handler");
const refundService = require("../../services/orderRefund.service");
const { client } = require("../../config/db");

/**
 * The refund desk's scope check: PFIs if assigned, else depots, else all — see
 * scopeFilter in the service. Every read and every action goes through it.
 */
const assertOrderVisible = (user, orderId) => refundService.assertOrderInScope(user, orderId);

/**
 * A refund row's order, checked against the person's scope before anything is
 * done with it. A refund outside it reads as not found.
 */
const assertRefundVisible = async (user, refundId) => {
  const [row] = await client`SELECT order_id FROM order_refunds WHERE id = ${Number(refundId)}`;
  if (!row) return; // the service answers 404 itself
  await assertOrderVisible(user, row.order_id);
};

/**
 * Overpayment refunds — the replacement for moving surplus between orders.
 *
 * All the reasoning lives in services/orderRefund.service.js, including why a
 * request changes nothing about the order and why the amounts read past the
 * migration-0021 duplicates.
 */

/** Orders genuinely holding money beyond their value. */
const getRefundable = asyncHandler(async (req, res) => {
  const orders = await refundService.listRefundable({
    search: req.query.search,
    limit: req.query.limit,
    scopeUser: req.user,
  });
  res.json({ success: true, data: { orders } });
});

const getRefunds = asyncHandler(async (req, res) => {
  const refunds = await refundService.listRefunds({
    status: req.query.status || null,
    pfiId: req.query.pfiId || null,
    from: req.query.from || null,
    to: req.query.to || null,
    search: req.query.search || "",
    limit: req.query.limit,
    scopeUser: req.user,
  });
  res.json({ success: true, data: { refunds } });
});

/** One refund, with the account to pay and every step it has been through. */
const getRefund = asyncHandler(async (req, res) => {
  const refund = await refundService.getRefund({ refundId: req.params.id, scopeUser: req.user });
  res.json({ success: true, data: { refund } });
});

const createRefund = asyncHandler(async (req, res) => {
  await assertOrderVisible(req.user, req.body.orderId);
  const refund = await refundService.requestRefund({ ...req.body, staffId: req.user?.id ?? null });
  res.status(201).json({
    success: true,
    message: "Refund requested. The overpayment stays on the order until the money has been sent.",
    data: { refund },
  });
});

const payRefund = asyncHandler(async (req, res) => {
  await assertRefundVisible(req.user, req.params.id);
  const result = await refundService.markRefunded({
    refundId: Number(req.params.id),
    ...req.body,
    staffId: req.user?.id ?? null,
  });
  res.json({
    success: true,
    message: "Refund recorded. The order no longer shows an overpayment.",
    data: result,
  });
});

const cancelRefund = asyncHandler(async (req, res) => {
  await assertRefundVisible(req.user, req.params.id);
  const refund = await refundService.cancelRefund({
    refundId: Number(req.params.id),
    reason: req.body.reason,
    staffId: req.user?.id ?? null,
  });
  res.json({ success: true, message: "Refund request cancelled.", data: { refund } });
});

const undoRefund = asyncHandler(async (req, res) => {
  await assertRefundVisible(req.user, req.params.id);
  const result = await refundService.undoRefund({
    refundId: Number(req.params.id),
    reason: req.body.reason,
    staffId: req.user?.id ?? null,
  });
  res.json({
    success: true,
    message: "Refund undone. It is waiting to be paid again, and the overpayment is back on the order.",
    data: result,
  });
});

/** Not refunding this one, and why. Nothing about the order changes. */
const skipRefund = asyncHandler(async (req, res) => {
  await assertOrderVisible(req.user, req.body.orderId);
  const refund = await refundService.skipOrder({
    orderId: Number(req.body.orderId),
    reason: req.body.reason,
    staffId: req.user?.id ?? null,
  });
  res.status(201).json({
    success: true,
    message: "Set aside. The money is still on the order — this records that it is not being refunded.",
    data: { refund },
  });
});

const restoreSkipped = asyncHandler(async (req, res) => {
  await assertRefundVisible(req.user, req.params.id);
  const refund = await refundService.restoreSkipped({
    refundId: Number(req.params.id),
    reason: req.body?.reason,
    staffId: req.user?.id ?? null,
  });
  res.json({ success: true, message: "Back on the refund list.", data: { refund } });
});

module.exports = {
  getRefundable, getRefunds, getRefund, createRefund, payRefund, cancelRefund, undoRefund,
  skipRefund, restoreSkipped,
};
