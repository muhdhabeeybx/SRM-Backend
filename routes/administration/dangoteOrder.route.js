const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { authenticateStaff, requireRole } = verifyStaff;
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
  getDangoteProducts,
  getDangoteProductsActive,
  getDangoteProductById,
  createDangoteProduct,
  updateDangoteProduct,
  getDangoteOrderRequests,
  getDangoteOrderRequestById,
  createDangoteOrderRequest,
  reviewDangoteOrderRequest,
  updateDangoteOrderPaymentStatus,
  updateDangoteOrderCollectionStatus,
  getPayableDangoteOrders,
  payDangoteOrder,
} = require("../../controllers/administration/dangoteOrder.controller");

// Dangote Products
router.get("/dangote-products", verifyStaff, denyPfiScoped, getDangoteProducts);
router.get("/dangote-products/active", verifyStaff, denyPfiScoped, getDangoteProductsActive);
router.get("/dangote-products/:id", verifyStaff, denyPfiScoped, getDangoteProductById);
router.post("/dangote-products", verifyStaff, denyPfiScoped, validate({ body: misc.createDangoteProduct }), createDangoteProduct);
router.put("/dangote-products/:id", verifyStaff, denyPfiScoped, validate({ body: misc.updateDangoteProduct }), updateDangoteProduct);

// Dangote Order Requests
router.get("/dangote-order-requests/payable", verifyStaff, denyPfiScoped, getPayableDangoteOrders);
router.get("/dangote-order-requests", verifyStaff, denyPfiScoped, getDangoteOrderRequests);
router.get("/dangote-order-requests/:id", verifyStaff, denyPfiScoped, getDangoteOrderRequestById);
router.post("/dangote-order-requests", verifyStaff, denyPfiScoped, createDangoteOrderRequest);
router.put(
  "/dangote-order-requests/:id/review",
  authenticateStaff,
  denyPfiScoped,
  requireRole("orders_manager", "orders_operator", "super_admin", { message: "Order review access required" }),
  reviewDangoteOrderRequest
);
router.put(
  "/dangote-order-requests/:id/pay",
  authenticateStaff,
  denyPfiScoped,
  requireRole("finance", "super_admin", { message: "Finance access required to pay" }),
  payDangoteOrder
);
router.put("/dangote-order-requests/:id/payment-status", verifyStaff, denyPfiScoped, updateDangoteOrderPaymentStatus);
router.put("/dangote-order-requests/:id/collection-status", verifyStaff, denyPfiScoped, updateDangoteOrderCollectionStatus);

module.exports = router;
