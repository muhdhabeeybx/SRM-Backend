const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/orderRefund.schema");
const {
  getRefundable, getRefunds, createRefund, payRefund, cancelRefund, undoRefund,
  skipRefund, restoreSkipped,
} = require("../../controllers/administration/orderRefund.controller");

/**
 * Overpayment refunds. Replaces moving surplus between orders, which now
 * answers 410 — see controllers/administration/order.controller.js.
 *
 * The requireRole lists are documentation: gating is open dashboard-wide (see
 * middleware/verifyStaff), and they record who each endpoint was built for.
 */

router.get("/refundable", verifyStaff, validate({ query: s.listRefundable }), getRefundable);
router.get("/", verifyStaff, validate({ query: s.listRefunds }), getRefunds);

router.post(
  "/",
  verifyStaff,
  requireRole("finance", "admin", "super_admin", { message: "Finance access required" }),
  validate({ body: s.createRefund }),
  createRefund,
);

// The money has left. This is the one that clears the overpayment.
router.patch(
  "/:id/pay",
  verifyStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to pay a refund" }),
  validate({ params: s.idParam, body: s.payRefund }),
  payRefund,
);

router.patch(
  "/:id/cancel",
  verifyStaff,
  requireRole("finance", "admin", "super_admin", { message: "Finance access required" }),
  validate({ params: s.idParam, body: s.reasonBody }),
  cancelRefund,
);

// Marked paid by mistake: puts the request back and the overpayment with it.
router.patch(
  "/:id/undo",
  verifyStaff,
  requireRole("finance", "super_admin", { message: "Finance access required to undo a refund" }),
  validate({ params: s.idParam, body: s.reasonBody }),
  undoRefund,
);

/*
  Setting one aside, and putting it back.

  Same gate as raising a refund: deciding NOT to return money is as much a
  finance decision as deciding to return it, and it is reversible from the
  route below.
*/
router.post(
  "/skip",
  verifyStaff,
  requireRole("finance", "admin", "super_admin", { message: "Finance access required" }),
  validate({ body: s.skipOrder }),
  skipRefund,
);

router.patch(
  "/:id/restore",
  verifyStaff,
  requireRole("finance", "admin", "super_admin", { message: "Finance access required" }),
  validate({ params: s.idParam }),
  restoreSkipped,
);

module.exports = router;
