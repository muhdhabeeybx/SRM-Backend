const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { authenticateStaff, requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const schemas = require("../../schemas/notification.schema");
const ctrl = require("../../controllers/notification.controller");
const admin = require("../../controllers/administration/notificationAdmin.controller");

/**
 * Staff notifications — the dashboard's bell menu, plus the admin-only
 * broadcast and observability endpoints.
 *
 * Two authorisation levels, deliberately:
 *
 *   authenticateStaff  every signed-in staff member, for THEIR OWN inbox,
 *                      preferences and devices. `verifyStaff` would be wrong
 *                      here — it admits only admin/super_admin (see the note
 *                      in middleware/verifyStaff.js), which would leave a
 *                      depot manager unable to read a notification addressed
 *                      to them.
 *
 *   verifyStaff        broadcasting and the delivery logs. Sending to everyone
 *                      and reading who was contacted are administrative acts.
 */

// Literal paths before "/:id" — Express matches in declaration order.
router.get("/stream", ctrl.stream("staff"));
router.post("/stream-ticket", authenticateStaff, ctrl.issueStreamTicket);

router.get("/unread-count", authenticateStaff, ctrl.unreadCount);
router.get("/catalog", authenticateStaff, ctrl.getCatalog);

// Preferences
router.get("/preferences", authenticateStaff, ctrl.getPreferences);
router.patch(
  "/preferences",
  authenticateStaff,
  validate({ body: schemas.updatePreferences }),
  ctrl.updatePreferences
);
router.post(
  "/preferences/reset",
  authenticateStaff,
  validate({ body: schemas.resetPreferences }),
  ctrl.resetPreferences
);

// Push device registration
router.get("/devices", authenticateStaff, ctrl.listDevices);
router.post("/devices", authenticateStaff, validate({ body: schemas.registerDevice }), ctrl.registerDevice);
router.delete(
  "/devices",
  authenticateStaff,
  validate({ body: schemas.unregisterDevice }),
  ctrl.unregisterDevice
);

// Bulk actions
router.post("/read-all", authenticateStaff, validate({ body: schemas.markAllRead }), ctrl.markAllRead);
router.post("/archive-all", authenticateStaff, validate({ body: schemas.markAllRead }), ctrl.archiveAll);
router.post("/test", authenticateStaff, validate({ body: schemas.sendTest }), ctrl.sendTest);

// ─── Admin-only ─────────────────────────────────────────────────────────────
// Reaching every customer (or every staff member) is a step up from reading
// the delivery log, so this gets its own role gate on top of verifyStaff —
// the same admin/super_admin line the frontend's /messaging route already
// draws (src/lib/rbac.ts).
router.post(
  "/broadcast",
  verifyStaff,
  requireRole("admin", "super_admin"),
  validate({ body: schemas.broadcast }),
  admin.broadcast
);
router.get("/deliveries", verifyStaff, validate({ query: schemas.listDeliveries }), admin.listDeliveries);
router.get(
  "/delivery-summary",
  verifyStaff,
  validate({ query: schemas.deliverySummary }),
  admin.deliverySummary
);
router.get("/sms-balance", verifyStaff, admin.smsBalance);
// Every message sent and what it cost (migration 0064). Before "/:id/…".
const messageLogCtrl = require("../../controllers/administration/messageLog.controller");
router.get("/message-log", verifyStaff, validate({ query: schemas.messageLogQuery }), messageLogCtrl.listMessages);
router.get("/message-log/summary", verifyStaff, validate({ query: schemas.messageLogQuery }), messageLogCtrl.messageSummary);
router.post("/message-log/sync", verifyStaff, messageLogCtrl.syncMessages);
router.get("/campaigns", verifyStaff, validate({ query: schemas.listCampaigns }), admin.listCampaigns);
router.get(
  "/campaigns/:id",
  verifyStaff,
  validate({ params: schemas.campaignIdParam }),
  admin.getCampaign
);
router.get("/health", verifyStaff, admin.health);
router.get("/entity/:type/:id", verifyStaff, admin.forEntity);
router.post("/maintenance/run", verifyStaff, admin.runMaintenanceNow);

// ─── Inbox (parameterised — must come last) ─────────────────────────────────
router.get("/", authenticateStaff, validate({ query: schemas.listNotifications }), ctrl.list);
router.get("/:id", authenticateStaff, validate({ params: schemas.notificationIdParam }), ctrl.getOne);
router.get(
  "/:id/deliveries",
  verifyStaff,
  validate({ params: schemas.notificationIdParam }),
  admin.deliveriesForNotification
);
router.patch("/:id/read", authenticateStaff, validate({ params: schemas.notificationIdParam }), ctrl.markRead);
router.patch(
  "/:id/unread",
  authenticateStaff,
  validate({ params: schemas.notificationIdParam }),
  ctrl.markUnread
);
router.patch(
  "/:id/archive",
  authenticateStaff,
  validate({ params: schemas.notificationIdParam }),
  ctrl.archive
);
router.delete("/:id", authenticateStaff, validate({ params: schemas.notificationIdParam }), ctrl.remove);

module.exports = router;
