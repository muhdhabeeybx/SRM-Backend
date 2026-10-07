const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/orderTransferRequest.schema");
const c = require("../../controllers/administration/orderTransferRequest.controller");

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
