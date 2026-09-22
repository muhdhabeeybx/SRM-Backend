const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const { authenticateStaff, requireRole } = require("../../middleware/verifyStaff");
const { runSettlement } = require("../../controllers/administration/settlement.controller");

/**
 * Settlement is a money-moving operation, so it is gated on finance rather
 * than on the generic elevated-staff check. It used to run automatically on
 * every server boot with no gate at all.
 */
router.post(
  "/run",
  authenticateStaff,
  denyPfiScoped,
  requireRole("super_admin", "finance", { message: "Finance access required" }),
  runSettlement
);

module.exports = router;
