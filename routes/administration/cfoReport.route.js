const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const {
  cfoReportQuerySchema,
  cfoReportEntrySchema,
  cfoReportEntryKeySchema,
} = require("../../schemas/cfoReport.schema");
const {
  getCfoReport,
  saveCfoReportEntry,
  deleteCfoReportEntry,
} = require("../../controllers/administration/cfoReport.controller");

/**
 * The CFO report and its corrections.
 *
 * The requireRole arguments on the write paths are documentation: gating is
 * open dashboard-wide (see middleware/verifyStaff), and the list records who
 * the endpoint was built for — the desks that sign this report off — so that
 * intent survives if gating is ever reinstated.
 */

router.get("/", verifyStaff, validate({ query: cfoReportQuerySchema }), getCfoReport);

router.put(
  "/entries",
  verifyStaff,
  requireRole("super_admin", "admin", "finance", "audit", {
    message: "CFO report access required",
  }),
  validate({ body: cfoReportEntrySchema }),
  saveCfoReportEntry
);

router.delete(
  "/entries",
  verifyStaff,
  requireRole("super_admin", "admin", "finance", "audit", {
    message: "CFO report access required",
  }),
  validate({ query: cfoReportEntryKeySchema }),
  deleteCfoReportEntry
);

module.exports = router;
