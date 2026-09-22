const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { authenticateStaff, requireRole } = verifyStaff;
const validate = require("../../middleware/validate");
const lpgOrderSchemas = require("../../schemas/lpgOrderRequest.schema");
const {
  getLpgOrderRequests,
  getLpgOrderRequestById,
  createLpgOrderRequest,
  reviewLpgOrderRequest,
  updateLpgOrderPaymentStatus,
  updateLpgOrderCollectionStatus,
  getPayableLpgOrders,
  payLpgOrder,
  cancelLpgOrderRequest,
} = require("../../controllers/administration/lpgOrder.controller");

router.get("/lpg-order-requests/payable", verifyStaff, denyPfiScoped, getPayableLpgOrders);
router.get(
  "/lpg-order-requests",
  verifyStaff,
  denyPfiScoped,
  validate({ query: lpgOrderSchemas.listLpgOrderRequests }),
  getLpgOrderRequests
);
router.get(
  "/lpg-order-requests/:id",
  verifyStaff,
  denyPfiScoped,
  validate({ params: lpgOrderSchemas.idParam }),
  getLpgOrderRequestById
);
router.post(
  "/lpg-order-requests",
  verifyStaff,
  denyPfiScoped,
  validate({ body: lpgOrderSchemas.createLpgOrderRequest }),
  createLpgOrderRequest
);
router.put(
  "/lpg-order-requests/:id/review",
  authenticateStaff,
  denyPfiScoped,
  requireRole("orders_manager", "orders_operator", "lpg_manager", "lpg_operator", "super_admin", { message: "Order review access required" }),
  validate({ params: lpgOrderSchemas.idParam, body: lpgOrderSchemas.reviewLpgOrderRequest }),
  reviewLpgOrderRequest
);
router.put(
  "/lpg-order-requests/:id/pay",
  authenticateStaff,
  denyPfiScoped,
  requireRole("finance", "super_admin", { message: "Finance access required to pay" }),
  validate({ params: lpgOrderSchemas.idParam }),
  payLpgOrder
);
router.put(
  "/lpg-order-requests/:id/payment-status",
  verifyStaff,
  denyPfiScoped,
  validate({ params: lpgOrderSchemas.idParam, body: lpgOrderSchemas.updateLpgOrderPaymentStatus }),
  updateLpgOrderPaymentStatus
);
router.put(
  "/lpg-order-requests/:id/collection-status",
  verifyStaff,
  denyPfiScoped,
  validate({ params: lpgOrderSchemas.idParam, body: lpgOrderSchemas.updateLpgOrderCollectionStatus }),
  updateLpgOrderCollectionStatus
);
router.put(
  "/lpg-order-requests/:id/cancel",
  authenticateStaff,
  denyPfiScoped,
  requireRole("orders_manager", "orders_operator", "lpg_manager", "lpg_operator", "super_admin", { message: "Order review access required" }),
  validate({ params: lpgOrderSchemas.idParam }),
  cancelLpgOrderRequest
);

module.exports = router;
