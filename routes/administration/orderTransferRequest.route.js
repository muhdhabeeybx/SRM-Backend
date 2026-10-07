const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/orderTransferRequest.schema");
const c = require("../../controllers/administration/orderTransferRequest.controller");

/**
 * Switched off for now — the owner's call, 7 October 2026: overpayment goes
 * back to the customer through refunds only. SURPLUS_TRANSFERS_ENABLED=true
 * turns every route below back on; nothing else needs to change.
 */
const transfersOn = () => process.env.SURPLUS_TRANSFERS_ENABLED === "true";
router.use((req, res, next) => {
  if (transfersOn()) return next();
  return res.status(410).json({
    success: false,
    message: "Moving surplus between orders is switched off for now. Refund the overpayment instead.",
  });
});

/**
 * Surplus transfers between orders, by request and approval — the owner's
 * rule of 7 October 2026. Finance or an admin asks (enforced); deciding is
 * checked in the service against the named approvers (lib/transferApprovers),
 * because being named, not a role, is what lets somebody approve.
 */

router.get("/", verifyStaff, validate({ query: s.list }), c.listRequests);
router.get("/spare/:orderId", verifyStaff, validate({ params: s.orderIdParam }), c.spare);

router.post(
  "/",
  verifyStaff,
  enforceRole("finance", "admin", { message: "Only finance or an admin can ask to move money between orders" }),
  validate({ body: s.createRequest }),
  c.createRequest,
);
router.post(
  "/reversal",
  verifyStaff,
  enforceRole("finance", "admin", { message: "Only finance or an admin can ask to undo a transfer" }),
  validate({ body: s.createReversal }),
  c.createReversal,
);

router.post("/:id/approve", verifyStaff, validate({ params: s.idParam, body: s.approve }), c.approve);
router.post("/:id/reject", verifyStaff, validate({ params: s.idParam, body: s.reject }), c.reject);
router.post("/:id/cancel", verifyStaff, validate({ params: s.idParam, body: s.cancel }), c.cancel);

module.exports = router;
