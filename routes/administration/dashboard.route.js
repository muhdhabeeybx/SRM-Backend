const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { getStats, getOverview, getWorkQueues, getActivity } = require("../../controllers/administration/dashboard.controller");
const {
  getDeskAssignments, getDeskNudges, sendDeskNudges, smsDeskNudge,
} = require("../../controllers/administration/deskNudge.controller");

router.get("/stats", verifyStaff, getStats);
router.get("/overview", verifyStaff, getOverview);
// Sidebar badges and the "my work" landing page. Any signed-in staff member —
// it reports how much work is waiting on THEM, scoped to their own locations.
router.get("/work-queues", verifyStaff, getWorkQueues);
// The full activity log. Same source as the overview’s ten rows.
router.get("/activity", verifyStaff, getActivity);

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
router.get("/desk-assignments", verifyStaff, getDeskAssignments);
router.get("/desk-nudges", verifyStaff, getDeskNudges);
router.post("/desk-nudges/notify", verifyStaff, sendDeskNudges);
router.post("/desk-nudges/sms", verifyStaff, smsDeskNudge);

module.exports = router;
