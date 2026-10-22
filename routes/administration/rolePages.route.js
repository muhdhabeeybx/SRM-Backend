const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const schemas = require("../../schemas/rolePages.schema");
const { getRolePages, setRolePages, setSwitch, getPreview } = require("../../controllers/administration/rolePages.controller");

/**
 * The pages each role opens, and the switch that lets them decide people's
 * pages — migration 0096, services/rolePages.service.js. Read by anybody
 * signed in (Manage Users shows what a person's roles give); changed by
 * admins only, the same people who keep Manage Users.
 */
const ADMINS = enforceRole("admin", { message: "Only an admin can change the pages each role opens." });

router.get("/", verifyStaff, getRolePages);
router.get("/preview", verifyStaff, ADMINS, getPreview);
// Before /:role, which would otherwise read "switch" as a role.
router.put("/switch", verifyStaff, ADMINS, validate({ body: schemas.setSwitch }), setSwitch);
router.put("/:role", verifyStaff, ADMINS, validate({ params: schemas.roleParam, body: schemas.setRolePages }), setRolePages);

module.exports = router;
