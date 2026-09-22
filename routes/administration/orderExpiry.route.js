const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const { authenticateStaff, requireRole } = require("../../middleware/verifyStaff");
const { runExpiry } = require("../../controllers/administration/orderExpiry.controller");

/**
 * Lapse unpaid orders past the expiry window. It releases reserved stock and
 * capacity, so it is gated like the order-cancel / settlement sweeps — driven
 * by cron in production, triggerable by finance/super_admin on demand.
 */
router.post(
  "/run",
  authenticateStaff,
  denyPfiScoped,
  requireRole("super_admin", "finance", { message: "Finance access required" }),
  runExpiry
);

module.exports = router;
