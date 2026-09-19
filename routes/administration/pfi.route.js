const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
  getPfiLocations,
  setPfiLocations,
  getPfiTrucks,
  setPfiTrucks,
  getPfis,
  getPfiById,
  createPfi,
  updatePfi,
  deletePfi,
  startPfi,
  activatePfi,
  finishPfi,
  getPfiOutstanding,
  getPfiSummary,
  getPfiExpenses,
  addPfiExpense,
  getStockSummary,
  assignOrdersToPfi,
} = require("../../controllers/administration/pfi.controller");

// Stock across every PFI. Declared before "/:id" so it is not swallowed by it.
router.get("/stock-summary", verifyStaff, getStockSummary);
// Bulk assignment lives here rather than under /orders because it is the PFI
// that validates the request.
router.post("/assign-orders", verifyStaff, assignOrdersToPfi);

router.get("/", verifyStaff, validate({ query: misc.listPfis }), getPfis);
router.post("/", verifyStaff, validate({ body: misc.createPfi }), createPfi);

router.get("/:id", verifyStaff, validate({ params: misc.idParam }), getPfiById);
router.patch("/:id", verifyStaff, validate({ params: misc.idParam, body: misc.updatePfi }), updatePfi);
router.delete("/:id", verifyStaff, validate({ params: misc.idParam }), deletePfi);

// Releasing a PFI to trade. "/start" stays as the old name for anything still
// calling it — it is the same handler, which now requires a bank account and
// officers rather than flipping a status.
router.post("/:id/start", verifyStaff, validate({ params: misc.idParam }), startPfi);
router.post("/:id/activate", verifyStaff, validate({ params: misc.idParam }), activatePfi);
router.post("/:id/finish", verifyStaff, validate({ params: misc.idParam }), finishPfi);
router.get("/:id/summary", verifyStaff, validate({ params: misc.idParam }), getPfiSummary);
// A delivery batch's two extra facts: where it may be sold, and what carried
// it. Both no-ops on a coastal cargo, which has neither.
router.get("/:id/locations", verifyStaff, validate({ params: misc.idParam }), getPfiLocations);
router.put("/:id/locations", verifyStaff, validate({ params: misc.idParam }), setPfiLocations);
router.get("/:id/trucks", verifyStaff, validate({ params: misc.idParam }), getPfiTrucks);
router.put(
  "/:id/trucks",
  verifyStaff,
  validate({ params: misc.idParam, body: misc.setPfiTrucks }),
  setPfiTrucks
);

// What is still moving on a batch — read before closing it. See the controller.
router.get("/:id/outstanding", verifyStaff, validate({ params: misc.idParam }), getPfiOutstanding);

router.get("/:id/expenses", verifyStaff, validate({ params: misc.idParam }), getPfiExpenses);
router.post("/:id/expenses", verifyStaff, validate({ params: misc.idParam }), addPfiExpense);

module.exports = router;
