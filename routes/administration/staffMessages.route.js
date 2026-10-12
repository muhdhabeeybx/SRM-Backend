const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const {
  getPeople, getUnreadCount, getThread, sendMessage, getActivity,
} = require("../../controllers/administration/staffMessages.controller");

router.use(verifyStaff);

// Everybody signed in: these only ever read and write the caller's own
// conversations.
router.get("/people", getPeople);
router.get("/unread-count", getUnreadCount);
router.get("/with/:id", getThread);
router.post("/with/:id", sendMessage);

// Who wrote to whom and when, never what — admins only, enforced (see
// enforceRole), because even the pattern of who talks to whom is not for
// everybody.
router.get("/activity", enforceRole("admin", { message: "Only an admin can see message activity" }), getActivity);

module.exports = router;
