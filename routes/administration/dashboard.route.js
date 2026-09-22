const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { getStats, getOverview, getWorkQueues, getActivity } = require("../../controllers/administration/dashboard.controller");
const {
  getDeskAssignments, getDeskNudges, sendDeskNudges, smsDeskNudge,
} = require("../../controllers/administration/deskNudge.controller");

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
// The full activity log. Same source as the overview’s ten rows.
router.get("/activity", verifyStaff, denyPfiScoped, getActivity);

/**
 * Chasing the desks.
 *
 * The daily 08:00 sweep nudges in-app on its own; these are for an admin
 * looking at a queue that has been sitting for months and not wanting to wait
 * until tomorrow. The SMS route is one desk per call and takes a dryRun flag,
 * because texting eleven people is a decision, not a page load.
 */
// Who owes what, by name. Admin-gated inside the controller — it names
// individuals and what they are holding up.
router.get("/desk-assignments", verifyStaff, denyPfiScoped, getDeskAssignments);
router.get("/desk-nudges", verifyStaff, denyPfiScoped, getDeskNudges);
router.post("/desk-nudges/notify", verifyStaff, denyPfiScoped, sendDeskNudges);
router.post("/desk-nudges/sms", verifyStaff, denyPfiScoped, smsDeskNudge);

module.exports = router;
