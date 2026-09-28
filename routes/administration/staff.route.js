const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const {
  createAdmin,
  getAllAdmins,
  getAdminById,
  updateAdmin,
  updateMyProfile,
  changeMyPassword,
  deleteAdmin,
  resendInvite,
  getNotificationChoices,
  getPfiAssignments,
} = require("../../controllers/administration/staff.controller");
const { requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");

router.use(verifyStaff);

router.post("/", requireRole("super_admin"), validate({ body: misc.createStaff }), createAdmin);

// Self-service. Declared before "/:id" so "me" is never read as an id, and
// deliberately ungated — every signed-in person owns their own profile. What
// they may change is decided in the handlers: name, other names, phone and
// picture, never email, roles, suspension or scope.
router.patch("/me", validate({ body: misc.updateMyProfile }), updateMyProfile);
router.post("/me/password", validate({ body: misc.changeMyPassword }), changeMyPassword);

router.get("/", validate({ query: misc.listStaff }), getAllAdmins);
// Before "/:id", so it is never read as an id.
router.get("/notification-choices", getNotificationChoices);
router.get("/:id", validate({ params: misc.idParam }), getAdminById);
router.get("/:id/pfi-assignments", validate({ params: misc.idParam }), getPfiAssignments);
// No route-level role gate on purpose: updateAdmin gates the privilege fields
// (roles, suspended) per-field, so a super_admin route check here would also
// block a normal staff member editing their own name/phone. See the comment in
// staff.controller.js#updateAdmin.
router.patch("/:id", validate({ params: misc.idParam, body: misc.updateStaff }), updateAdmin);
router.delete("/:id", requireRole("super_admin"), validate({ params: misc.idParam }), deleteAdmin);
router.post("/:id/resend-invite", validate({ params: misc.idParam }), resendInvite);

module.exports = router;
