const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { authenticateStaff, requireRole } = verifyStaff;
const validate = require("../../middleware/validate");
const orderSchemas = require("../../schemas/order.schema");
const { getGateQueue } = require("../../controllers/administration/gateQueue.controller");
const {
  getOrders,
  getOrderById,
  createOrder,
  updateOrder,
  releaseOrder,
  cancelOrder,
  deleteOrder,
  generateOrderTickets,
  getTruckTicketPrintData,
  getOrderTrucks,
  gateInTruck,
  markTruckLoaded,
  updateTruckLoad,
  gateOutTruck,
  getPayableOrders,
  confirmOrderPayment,
  getOrderPayments,
  getOrderTimeline,
  authoriseCreditRelease,
  revokeCreditRelease,
  getReceivables,
  setOrderPrice,
  removeOrderPayment,
  transferOrderPayment,
  reverseOrderPaymentTransfer,
  reviewOrderPayment,
  reviewOrderPaymentTransfer,
  getPaymentReviewQueue,
  getOrdersWithSurplus,
  reconcileOrderEffects,
} = require("../../controllers/administration/order.controller");

// Payable orders (must be before /:id to avoid param conflict)
// Hard delete, paid orders included. super_admin only: it destroys the payment
// trail along with the order, leaving only the audit row behind.
router.delete(
  "/:id",
  verifyStaff,
  requireRole("super_admin", { message: "Only a super admin can delete an order" }),
  validate({ params: orderSchemas.idParam }),
  deleteOrder
);

router.get("/payable", verifyStaff, getPayableOrders);

// What has left the yard unpaid. Before "/:id" so the literal segment wins the
// match, like /payable and /with-surplus above it.
router.get("/receivables", verifyStaff, getReceivables);

// Reads and creation stay behind the admin gate (verifyStaff).
// The gate's own queue, before any "/:id" route can swallow the path.
router.get("/gate-queue/:stage", verifyStaff, getGateQueue);

router.get("/", verifyStaff, validate({ query: orderSchemas.listOrders }), getOrders);
router.get("/:id", verifyStaff, validate({ params: orderSchemas.idParam }), getOrderById);
router.post("/", verifyStaff, validate({ body: orderSchemas.createOrder }), createOrder);

// Edit anything about an order short of its status — customer, PFI, date,
// quantity, price, logistics text. Open to any signed-in staff, same as the
// reads/create above; the handler itself gates a PFI reassignment against
// the caller's own PFI scope (see orderService.updateOrder).
router.patch(
  "/:id",
  verifyStaff,
  validate({ params: orderSchemas.idParam, body: orderSchemas.updateOrder }),
  updateOrder
);

// Lifecycle transitions are role-gated to the desk that owns the action, and
// each flows through the state machine (see services/orderStatus.service.js).
// The raw `PUT /:id` status setter and `POST /:id/complete` are removed (H1):
// Released is a "release"-desk action; Loading/Completed are driven by truck
// gate actions in a later commit; cancel + refund belongs to finance.
router.post(
  "/:id/release",
  authenticateStaff,
  requireRole("release", "super_admin", { message: "Release desk access required" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.releaseOrder }),
  releaseOrder
);
router.post(
  "/:id/cancel",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to cancel" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.cancelOrder }),
  cancelOrder
);

/**
 * Release an order for loading before it has been paid for.
 *
 * Finance-gated, not ticketing-gated. Cutting a ticket is the loading desk's
 * act; deciding that this customer may owe us for a truckload is not, and the
 * person standing in front of the customer is the worst-placed one to decide
 * it. The body carries a quantity and a required reason.
 */
router.post(
  "/:id/credit-release",
  authenticateStaff,
  requireRole("finance", "super_admin", {
    message: "Finance access required to release an order before payment",
  }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.creditRelease }),
  authoriseCreditRelease
);

router.delete(
  "/:id/credit-release",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.revokeCreditRelease }),
  revokeCreditRelease
);

/**
 * Put a price on an order raised without one — the invoice that follows a
 * handwritten ticket. Finance-gated, and refused once an order has a price.
 */
router.post(
  "/:id/price",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to price an order" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.setOrderPrice }),
  setOrderPrice
);

// Orders holding money beyond their own value — where the desk finds surplus
// that needs moving. Before /:id so the literal segment wins the match.
router.get(
  "/with-surplus",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required" }),
  getOrdersWithSurplus
);

/**
 * Confirm payment on an order from the bank statement lines that paid for it.
 *
 * This is the ONLY way an order becomes paid. There is no endpoint that draws
 * on a customer's wallet balance, and no amount is accepted from the client —
 * see schemas/order.schema.js and db/migrations/0021.
 */
router.post(
  "/:id/payments",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to confirm payment" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.confirmOrderPayment }),
  confirmOrderPayment
);

router.get(
  "/:id/payments",
  authenticateStaff,
  validate({ params: orderSchemas.idParam }),
  getOrderPayments
);

// The order's full history, read back out of audit_logs. A read, gated like
// every other read on this router (verifyStaff) — seeing what happened is not
// a finance act, and a desk that cannot see the trail keeps phoning one that can.
router.get(
  "/:id/timeline",
  verifyStaff,
  validate({ params: orderSchemas.idParam }),
  getOrderTimeline
);

// Correcting a mis-matched payment: the row goes, its statement line returns
// to the unmatched pool. Finance only, and a reason is required.
router.delete(
  "/:id/payments/:paymentId",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required" }),
  validate({ params: orderSchemas.paymentParam, body: orderSchemas.removeOrderPayment }),
  removeOrderPayment
);

// Move this order's surplus to another order.
router.post(
  "/:id/payments/transfer",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to move money between orders" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.transferOrderPayment }),
  transferOrderPayment
);

router.delete(
  "/:id/payments/transfer/:transferId",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required" }),
  validate({ params: orderSchemas.transferParam }),
  reverseOrderPaymentTransfer
);

/**
 * Vouch for an attribution the system made on its own.
 *
 * Not a correction — no money moves. Reversal was ruled out on the data (see
 * scripts/review-system-attributions.js): none of these can be undone without
 * dropping an already-released, already-ticketed order below its own value. So
 * the fix is to the record: a name and a reason against a row that had neither.
 *
 * Finance-gated like every other money route, because vouching for ₦3.675bn is
 * a finance act even though it moves nothing.
 */
router.post(
  "/:id/payments/:paymentId/review",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to review a payment" }),
  validate({ params: orderSchemas.paymentParam, body: orderSchemas.reviewOrderPayment }),
  reviewOrderPayment
);

router.post(
  "/:id/payments/transfer/:transferId/review",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to review a transfer" }),
  validate({ params: orderSchemas.transferParam, body: orderSchemas.reviewOrderPayment }),
  reviewOrderPaymentTransfer
);

// Re-run post-payment effects for a paid order whose ticket/commission failed.
router.post(
  "/:id/reconcile",
  authenticateStaff,
  requireRole("finance", "super_admin", { message: "Finance access required" }),
  validate({ params: orderSchemas.idParam }),
  reconcileOrderEffects
);

// The truck gate flow — each checkpoint gated to its security/ticketing post.
router.post(
  "/:id/generate-tickets",
  authenticateStaff,
  requireRole("ticketing", "super_admin", { message: "Ticketing access required" }),
  validate({ params: orderSchemas.idParam }),
  generateOrderTickets
);
router.get("/:id/trucks/:loadId/print", verifyStaff, getTruckTicketPrintData);
router.get("/:id/trucks", verifyStaff, getOrderTrucks);

router.post(
  "/:id/gate-in",
  authenticateStaff,
  requireRole("security_entry", "super_admin", { message: "Entry-gate security access required" }),
  validate({ params: orderSchemas.idParam, body: orderSchemas.gateIn }),
  gateInTruck
);
router.post(
  "/:id/trucks/:loadId/load",
  authenticateStaff,
  requireRole("ticketing", "super_admin", { message: "Ticketing access required" }),
  validate({ params: orderSchemas.loadParam, body: orderSchemas.loadTruck }),
  markTruckLoaded
);
// Correct a load's own details after the fact — quantity, plate, driver.
// Open to any signed-in staff, same as the order-edit route above; refused
// once the truck has gated out (see updateTruckLoad).
router.patch(
  "/:id/trucks/:loadId",
  verifyStaff,
  validate({ params: orderSchemas.loadParam, body: orderSchemas.updateTruckLoad }),
  updateTruckLoad
);
router.post(
  "/:id/trucks/:loadId/gate-out",
  authenticateStaff,
  requireRole("security_exit", "super_admin", { message: "Exit-gate security access required" }),
  validate({ params: orderSchemas.loadParam }),
  gateOutTruck
);

module.exports = router;
