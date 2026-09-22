const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
  getFilingStations,
  getFilingStationById,
  createFilingStation,
  updateFilingStation,
  deleteFilingStation,
} = require("../../controllers/administration/filingStation.controller");
const {
  getStationCycleStatuses,
  setStationCycleStatus,
} = require("../../controllers/administration/deliveryBatch.controller");

/**
 * Closing a delivery cycle on the station register, and reopening it.
 *
 * Above the /:id routes deliberately, or GET /:id reads "cycles" as an id. The
 * cycle key travels in the PATCH body rather than the path — see the
 * controller. Migration 0029.
 */
router.get("/cycles", verifyStaff, denyPfiScoped, getStationCycleStatuses);
router.patch("/cycles", verifyStaff, denyPfiScoped, setStationCycleStatus);

router.get("/", verifyStaff, denyPfiScoped, validate({ query: misc.listStations }), getFilingStations);
router.get("/:id", verifyStaff, denyPfiScoped, validate({ params: misc.idParam }), getFilingStationById);
router.post("/", verifyStaff, denyPfiScoped, validate({ body: misc.createStation }), createFilingStation);
router.patch("/:id", verifyStaff, denyPfiScoped, validate({ params: misc.idParam, body: misc.updateStation }), updateFilingStation);
router.delete("/:id", verifyStaff, denyPfiScoped, validate({ params: misc.idParam }), deleteFilingStation);

module.exports = router;
