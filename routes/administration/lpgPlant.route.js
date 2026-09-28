const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const { denyPfiScopedUnlessPlants } = require("../../lib/pfiScope");
const { getLpgPlants, getLpgPlantById } = require("../../controllers/administration/lpgPlant.controller");

/**
 * LPG plants registered as delivery customers — migration 0061.
 *
 * Read only: a plant is created, edited and removed through
 * /delivery-customers, the way every other customer is. Guarded like the
 * filling-station register, which has no PFI link either.
 */
router.get("/", verifyStaff, denyPfiScopedUnlessPlants, validate({ query: misc.listStations }), getLpgPlants);
router.get("/:id", verifyStaff, denyPfiScopedUnlessPlants, validate({ params: misc.idParam }), getLpgPlantById);

module.exports = router;
