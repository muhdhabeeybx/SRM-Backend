const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const {
  idParamSchema,
  submitDailyReportSchema,
  amendDailyReportSchema,
  reviewDailyReportSchema,
  dailyReportQuerySchema,
  emailReportsHubSchema,
  whatsappReportSchema,
  operationsReportQuerySchema,
  emailPreviewSchema,
  reportReminderSchema,
} = require("../../schemas/dailyReport.schema");
const {
  getDailyReports,
  getReportActuals,
  getDailyReportById,
  submitDailyReport,
  deleteDailyReport,
  amendDailyReport,
  reviewDailyReport,
  emailDailyReports,
  getOperationsReport,
  previewDailyReportEmail,
  whatsappDailyReports,
  getOutstandingReports,
  sendReportReminders,
  CAN_VIEW_ALL_REPORTS,
} = require("../../controllers/administration/dailyReport.controller");

router.get("/", verifyStaff, validate({ query: dailyReportQuerySchema }), getDailyReports);
router.post(
  "/email",
  verifyStaff,
  denyPfiScoped,
  requireRole(...CAN_VIEW_ALL_REPORTS, { message: "Reports Hub access required" }),
  validate({ body: emailReportsHubSchema }),
  emailDailyReports
);
// The email as it would arrive, for the sender to read before it goes.
router.post(
  "/email/preview",
  verifyStaff,
  denyPfiScoped,
  requireRole(...CAN_VIEW_ALL_REPORTS, { message: "Reports Hub access required" }),
  validate({ body: emailPreviewSchema }),
  previewDailyReportEmail
);
// Same gate as the email: whoever may read the whole hub may send it on.
router.post(
  "/whatsapp",
  verifyStaff,
  denyPfiScoped,
  requireRole(...CAN_VIEW_ALL_REPORTS, { message: "Reports Hub access required" }),
  validate({ body: whatsappReportSchema }),
  whatsappDailyReports
);

// The emailed Sales & Operations Report, as data for the Hub to draw. Every
// batch's money is on it, so it is gated exactly as the email is. Above /:id,
// or "operations" is read as an id.
router.get(
  "/operations",
  verifyStaff,
  denyPfiScoped,
  requireRole(...CAN_VIEW_ALL_REPORTS, { message: "Reports Hub access required" }),
  validate({ query: operationsReportQuerySchema }),
  getOperationsReport
);

// Who has not filed, per desk and batch, and the SMS that chases them. Gated
// as the report is: it names every officer and texts them. Above /:id.
router.get(
  "/outstanding",
  verifyStaff,
  denyPfiScoped,
  requireRole(...CAN_VIEW_ALL_REPORTS, { message: "Reports Hub access required" }),
  validate({ query: operationsReportQuerySchema }),
  getOutstandingReports
);
router.post(
  "/reminders",
  verifyStaff,
  denyPfiScoped,
  requireRole(...CAN_VIEW_ALL_REPORTS, { message: "Reports Hub access required" }),
  validate({ body: reportReminderSchema }),
  sendReportReminders
);

// What the system holds for a PFI on a date, read live while a report is being
// typed. Above /:id, or "actuals" is read as an id.
router.get("/actuals", verifyStaff, getReportActuals);

router.get("/:id", verifyStaff, validate({ params: idParamSchema }), getDailyReportById);
router.delete("/:id", verifyStaff, deleteDailyReport);
router.post("/", verifyStaff, validate({ body: submitDailyReportSchema }), submitDailyReport);
router.patch(
  "/:id",
  verifyStaff,
  validate({ params: idParamSchema, body: amendDailyReportSchema }),
  amendDailyReport
);
router.post(
  "/:id/review",
  verifyStaff,
  validate({ params: idParamSchema, body: reviewDailyReportSchema }),
  reviewDailyReport
);

module.exports = router;
