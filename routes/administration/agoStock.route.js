const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/agoStock.schema");
const c = require("../../controllers/administration/agoStock.controller");

// The AGO stock ledger (0093). See services/agoStock.service.js.
router.get("/", verifyStaff, c.getLedger);
// The loads AGO can be given to, with whether each has had it.
router.get("/trips", verifyStaff, c.getTrips);
router.post("/stock", verifyStaff, validate({ body: s.stockBody }), c.addStock);
router.post("/given", verifyStaff, validate({ body: s.giveBody }), c.give);
// A top-up or retrieval on AGO already given.
router.post("/:entryId/changes", verifyStaff, validate({ params: s.entryParam, body: s.changeBody }), c.change);
router.patch("/:entryId", verifyStaff, validate({ params: s.entryParam, body: s.updateBody }), c.update);
router.delete("/:entryId", verifyStaff, validate({ params: s.entryParam }), c.remove);

module.exports = router;
