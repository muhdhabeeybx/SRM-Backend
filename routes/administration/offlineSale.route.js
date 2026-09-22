const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const {
  idParamSchema,
  createOfflineSaleSchema,
  offlinePaymentSchema,
  reviewOfflineSaleSchema,
  offlineSaleQuerySchema,
} = require("../../schemas/offlineSale.schema");
const {
  getOfflineSales,
  getOfflineSaleById,
  createOfflineSale,
  recordOfflinePayment,
  reviewOfflineSale,
  reconcileOfflineSale,
} = require("../../controllers/administration/offlineSale.controller");

router.get("/", verifyStaff, denyPfiScoped, validate({ query: offlineSaleQuerySchema }), getOfflineSales);
router.get("/:id", verifyStaff, denyPfiScoped, validate({ params: idParamSchema }), getOfflineSaleById);
router.post("/", verifyStaff, denyPfiScoped, validate({ body: createOfflineSaleSchema }), createOfflineSale);
router.post(
  "/:id/payments",
  verifyStaff,
  denyPfiScoped,
  validate({ params: idParamSchema, body: offlinePaymentSchema }),
  recordOfflinePayment
);
router.post(
  "/:id/review",
  verifyStaff,
  denyPfiScoped,
  validate({ params: idParamSchema, body: reviewOfflineSaleSchema }),
  reviewOfflineSale
);
router.post(
  "/:id/reconcile",
  verifyStaff,
  denyPfiScoped,
  validate({ params: idParamSchema }),
  reconcileOfflineSale
);

module.exports = router;
