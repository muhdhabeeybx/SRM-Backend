const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/lpgDelivery.schema");
const c = require("../../controllers/administration/lpgDelivery.controller");

/**
 * An LPG plant's deliveries: the truck, driver, dates, kg loaded and received,
 * and cost per kg — one at a time or uploaded. A plant manager sees and
 * records only their own plant (lib/stationScope plantVisible).
 */
router.get("/pfis", verifyStaff, c.listPfis);
router.get("/", verifyStaff, validate({ query: s.list }), c.listDeliveries);
router.post("/", verifyStaff, validate({ body: s.record }), c.recordDeliveries);
router.patch("/:id", verifyStaff, validate({ params: s.idParam, body: s.update }), c.updateDelivery);
router.delete("/:id", verifyStaff, validate({ params: s.idParam }), c.deleteDelivery);

module.exports = router;
