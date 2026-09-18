const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const commissionSchemas = require("../../schemas/commission.schema");
const {
  getCommissions,
  getCommissionById,
  confirmPayment,
  skipCommission,
  revertCommission,
  bulkResolve,
  getSummary,
  getRates,
  upsertRate,
  setCustomerRate,
  getCustomerRates,
  generateDailyReport,
} = require("../../controllers/administration/commission.controller");

router.get("/", verifyStaff, validate({ query: commissionSchemas.listCommissions }), getCommissions);
router.get("/summary", verifyStaff, getSummary);
router.get("/rates", verifyStaff, getRates);
// Above /:id, which would otherwise answer for it — "customer-rates" is
// not an id, but the route matcher does not know that.
router.get("/customer-rates", verifyStaff, getCustomerRates);
router.get("/:id", verifyStaff, validate({ params: commissionSchemas.idParam }), getCommissionById);
router.patch("/:id/confirm-payment", verifyStaff, validate({ params: commissionSchemas.idParam }), confirmPayment);
// The second exit: settled without crediting anybody. See the service.
router.patch("/:id/skip", verifyStaff, validate({ params: commissionSchemas.idParam, body: commissionSchemas.skipCommission }), skipCommission);
// Undoing either settlement. Mistakes are made, and an exit that cannot be
// reversed quietly encourages leaving a wrong row settled.
router.patch("/:id/revert", verifyStaff, validate({ params: commissionSchemas.idParam, body: commissionSchemas.revertCommission }), revertCommission);
// Both acts over a selection. Above nothing it could be mistaken for — /bulk
// is not an id, and GET /:id would answer for it if this sat lower.
router.post("/bulk", verifyStaff, validate({ body: commissionSchemas.bulkResolve }), bulkResolve);
router.post("/rates", verifyStaff, validate({ body: commissionSchemas.upsertRate }), upsertRate);
// A rate that belongs to the customer rather than the depot. Sits with the
// other rate endpoint because both decide what the company owes somebody.
router.post("/customer-rate", verifyStaff, validate({ body: commissionSchemas.setCustomerRate }), setCustomerRate);
router.post("/daily-report", verifyStaff, validate({ body: commissionSchemas.dailyReport }), generateDailyReport);

module.exports = router;
