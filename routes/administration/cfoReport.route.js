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
const { requireCfoReportAccess } = require("../../middleware/cfoReportAccess");

/**
 * The CFO report and its corrections.
 *
 * The requireRole arguments on the write paths are documentation: gating is
 * open dashboard-wide (see middleware/verifyStaff), and the list records who
 * the endpoint was built for — the desks that sign this report off — so that
 * intent survives if gating is ever reinstated.
 *
 * requireCfoReportAccess is NOT documentation. It is the one real restriction
 * on these routes: the report is allowlisted to three people, and the check
 * runs on the read path as well as the writes, because reading the sheet is
 * the thing being restricted. See middleware/cfoReportAccess.js.
 */

router.get("/", verifyStaff, requireCfoReportAccess, validate({ query: cfoReportQuerySchema }), getCfoReport);

router.put(
  "/entries",
  verifyStaff,
  requireCfoReportAccess,
  requireRole("super_admin", "admin", "finance", "audit", {
    message: "CFO report access required",
  }),
  validate({ body: cfoReportEntrySchema }),
  saveCfoReportEntry
);

router.delete(
  "/entries",
  verifyStaff,
  requireCfoReportAccess,
  requireRole("super_admin", "admin", "finance", "audit", {
    message: "CFO report access required",
  }),
  validate({ query: cfoReportEntryKeySchema }),
  deleteCfoReportEntry
);

module.exports = router;
