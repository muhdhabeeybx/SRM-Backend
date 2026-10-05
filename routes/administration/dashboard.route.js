const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const { getStats, getOverview, getWorkQueues, getMyPfis, getMyNotifications, getActivity } = require("../../controllers/administration/dashboard.controller");
const {
  getDeskAssignments, getDeskNudges, sendDeskNudges, smsDeskNudge,
} = require("../../controllers/administration/deskNudge.controller");
const { getWorkReminders, sendWorkReminders } = require("../../controllers/administration/workReminders.controller");

/*
  The company's dashboard, its activity log and its desk backlogs are
  company-wide by nature — revenue, fleet, drivers, wallets, Dangote, LPG,
  every desk's queue — so staff assigned to a PFI are refused them outright
  (lib/pfiScope.js). Their figures are on PFI Tracking, the finance report and
  the CFO report, all filtered to their PFI. The work queues stay: they are
  already this person's own.
*/
router.get("/stats", verifyStaff, denyPfiScoped, getStats);
router.get("/overview", verifyStaff, denyPfiScoped, getOverview);
// Sidebar badges and the "my work" landing page. Any signed-in staff member —
// it reports how much work is waiting on THEM, scoped to their own locations.
router.get("/work-queues", verifyStaff, getWorkQueues);
// The PFIs this person is assigned to, for their dashboard. Their own
// assignments only, so it is not refused to PFI-confined staff — they are
// exactly who it is for.
router.get("/my-pfis", verifyStaff, getMyPfis);
// Their notifications, narrowed to what is about them. Their own inbox only.
router.get("/my-notifications", verifyStaff, getMyNotifications);
// The full activity log. Same source as the overview’s ten rows.
router.get("/activity", verifyStaff, denyPfiScoped, getActivity);

/**
 * Chasing the desks.
 *
 * The two-hourly work reminders chase every desk on their own (below); these
 * are for an admin looking at one queue and not wanting to wait for the next
 * round. The SMS route is one desk per call and takes a dryRun flag,
 * because texting eleven people is a decision, not a page load.
 */
// Who owes what, by name. Admin-gated inside the controller — it names
// individuals and what they are holding up.
router.get("/desk-assignments", verifyStaff, denyPfiScoped, getDeskAssignments);
router.get("/desk-nudges", verifyStaff, denyPfiScoped, getDeskNudges);
router.post("/desk-nudges/notify", verifyStaff, denyPfiScoped, sendDeskNudges);
router.post("/desk-nudges/sms", verifyStaff, denyPfiScoped, smsDeskNudge);

/**
 * The two-hourly reminders of waiting work (services/workReminders.service.js).
 * Admin-only: the page names each person and what they are holding up, and
 * sending texts them. Mirrored in soromanfe lib/serverGates.ts.
 */
const adminOnly = enforceRole("admin", { message: "Only an admin may see or send work reminders" });
router.get("/work-reminders", verifyStaff, adminOnly, getWorkReminders);
router.post("/work-reminders/send", verifyStaff, adminOnly, sendWorkReminders);

module.exports = router;
