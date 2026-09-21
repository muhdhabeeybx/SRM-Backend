const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const saleSchemas = require("../../schemas/deliverySale.schema");
const {
  getDeliverySales,
  getDeliverySaleById,
  createDeliverySale,
  createDeliverySalesBulk,
  updateDeliverySale,
  setDeliverySaleDepositStatus,
  deleteDeliverySale,
  transferDeliveryOverpayment,
  getDeliveryCycleStanding,
} = require("../../controllers/administration/deliverySale.controller");

router.get("/", verifyStaff, validate({ query: saleSchemas.listDeliverySales }), getDeliverySales);
// Both of these sit above "/:id" — Express matches in order, and a literal
// path declared after a parameter route is swallowed by it.
router.get("/cycle-standing", verifyStaff, validate({ query: saleSchemas.cycleStandingQuery }), getDeliveryCycleStanding);
// One transaction for many rows — see the controller.
router.post("/bulk", verifyStaff, validate({ body: saleSchemas.createDeliverySalesBulk }), createDeliverySalesBulk);
router.post("/transfer", verifyStaff, validate({ body: saleSchemas.transferOverpayment }), transferDeliveryOverpayment);
router.get("/:id", verifyStaff, validate({ params: saleSchemas.idParam }), getDeliverySaleById);
router.post("/", verifyStaff, validate({ body: saleSchemas.createDeliverySale }), createDeliverySale);
router.patch("/:id", verifyStaff, validate({ params: saleSchemas.idParam, body: saleSchemas.updateDeliverySale }), updateDeliverySale);
// Narrower than the update route above, and deliberately so — it accepts
// depositStatus and nothing else.
router.patch("/:id/deposit-status", verifyStaff, validate({ params: saleSchemas.idParam, body: saleSchemas.setDepositStatus }), setDeliverySaleDepositStatus);
router.delete("/:id", verifyStaff, validate({ params: saleSchemas.idParam }), deleteDeliverySale);

module.exports = router;
