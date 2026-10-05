const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const schemas = require("../../schemas/stationEntryStaff.schema");
const { listEntryStaff, setEntryStaff } = require("../../controllers/administration/stationEntryStaff.controller");

/**
 * Who enters a station's sales and expenses, and who enters its deposits —
 * migration 0067, lib/stationEntry.js.
 *
 * Fuel stations and LPG plants alike: both are delivery_customers rows, so
 * one route serves both, keyed on the customer id.
 */
router.get("/", verifyStaff, validate({ query: schemas.listEntryStaff }), listEntryStaff);
// Admins only — one of the enforced exceptions (soromanfe lib/serverGates.ts).
router.put(
  "/",
  verifyStaff,
  enforceRole("admin", { message: "Only an admin can change who enters a station's records." }),
  validate({ body: schemas.setEntryStaff }),
  setEntryStaff,
);

module.exports = router;
