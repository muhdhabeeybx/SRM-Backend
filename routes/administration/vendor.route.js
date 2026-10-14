const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const { statementQuery, vendorListQuery, vendorMergeBody } = require("../../schemas/statement.schema");
const {
  getVendors,
  getVendorById,
  getVendorStatement,
  createVendor,
  updateVendor,
  getTypedNames,
  linkTypedNames,
  getDuplicates,
  mergeVendors,
} = require("../../controllers/administration/vendor.controller");

/** Linking old expenses to vendors re-files money between statements: Finance's call. */
const FINANCE = enforceRole("finance", "audit", "admin", {
  message: "Only finance, audit or an admin can link expenses to vendors or merge vendors",
});

router.get("/", verifyStaff, validate({ query: vendorListQuery }), getVendors);
// Above /:id, which would otherwise answer for them.
router.get("/typed-names", verifyStaff, getTypedNames);
router.post("/link-typed-names", verifyStaff, FINANCE, linkTypedNames);
router.get("/duplicates", verifyStaff, getDuplicates);
router.post("/merge", verifyStaff, FINANCE, validate({ body: vendorMergeBody }), mergeVendors);
router.get("/:id", verifyStaff, validate({ query: statementQuery }), getVendorById);
router.get("/:id/statement", verifyStaff, validate({ params: misc.idParam, query: statementQuery }), getVendorStatement);
router.post("/", verifyStaff, validate({ body: misc.createVendor }), createVendor);
router.patch("/:id", verifyStaff, validate({ params: misc.idParam, body: misc.updateVendor }), updateVendor);

module.exports = router;
