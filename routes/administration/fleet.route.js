const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const {
  idParamSchema,
  createFleetTruckSchema,
  updateFleetTruckSchema,
  thirdPartyTruckSchema,
  fleetQuerySchema,
  fleetLedgerEntrySchema,
  fleetLedgerBatchSchema,
  fleetLedgerQuerySchema,
} = require("../../schemas/fleet.schema");
const {
  getFleetTrucks,
  getFleetTruckById,
  createFleetTruck,
  addThirdPartyTruck,
  updateFleetTruck,
  getComplianceWatchlist,
  recordLedgerEntry,
  recordLedgerBatch,
  getLedgerEntries,
  getAllLedgerEntries,
  updateLedgerEntry,
  deleteLedgerEntry,
  deleteFleetTruck,
} = require("../../controllers/administration/fleet.controller");

router.get("/", verifyStaff, validate({ query: fleetQuerySchema }), getFleetTrucks);
// Static path before "/:id" so "compliance" is never parsed as a truck id.
router.get("/compliance", verifyStaff, getComplianceWatchlist);
// Flat ledger: the Directory rolls money up across every truck.
router.get("/ledger", verifyStaff, getAllLedgerEntries);
// Before "/ledger/:entryId" would ever be considered, and before "/:id" —
// "batch" is a verb here, never an entry id.
router.post(
  "/ledger/batch",
  verifyStaff,
  validate({ body: fleetLedgerBatchSchema }),
  recordLedgerBatch
);
router.patch("/ledger/:entryId", verifyStaff, updateLedgerEntry);
router.delete("/ledger/:entryId", verifyStaff, deleteLedgerEntry);
router.delete("/:id", verifyStaff, deleteFleetTruck);
router.get("/:id", verifyStaff, validate({ params: idParamSchema }), getFleetTruckById);
router.post("/", verifyStaff, validate({ body: createFleetTruckSchema }), createFleetTruck);
// A hired truck, added from the Allocate trucks dialog. Static, so before "/:id".
router.post("/third-party", verifyStaff, validate({ body: thirdPartyTruckSchema }), addThirdPartyTruck);
router.patch(
  "/:id",
  verifyStaff,
  validate({ params: idParamSchema, body: updateFleetTruckSchema }),
  updateFleetTruck
);

// Fleet ledger — same workflow as the Django FleetLedgerEntry screens:
// entries are appended, never edited.
router.get(
  "/:id/ledger",
  verifyStaff,
  validate({ params: idParamSchema, query: fleetLedgerQuerySchema }),
  getLedgerEntries
);
router.post(
  "/:id/ledger",
  verifyStaff,
  validate({ params: idParamSchema, body: fleetLedgerEntrySchema }),
  recordLedgerEntry
);

module.exports = router;
