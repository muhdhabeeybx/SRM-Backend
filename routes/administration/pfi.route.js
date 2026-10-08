const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = verifyStaff;
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
  getPfiSurpluses,
  addPfiSurplus,
  voidPfiSurplus,
  getPfiLosses,
  addPfiLoss,
  voidPfiLoss,
  getPfiFile,
  getPfiRegister,
  listPfiNotes,
  addPfiNote,
  updatePfiNote,
  deletePfiNote,
} = require("../../controllers/administration/pfi.controller");
const {
  listAllocations,
  getPfiAllocations,
  raiseAllocation,
  approveAllocation,
  rejectAllocation,
  withdrawAllocation,
} = require("../../controllers/administration/pfiAllocation.controller");

// Stock across every PFI. Declared before "/:id" so it is not swallowed by it.
router.get("/stock-summary", verifyStaff, getStockSummary);
// Bulk assignment lives here rather than under /orders because it is the PFI
// that validates the request.
router.post("/assign-orders", verifyStaff, assignOrdersToPfi);
// What the full PFI report needs beyond the list — banks, people, activity,
// notes — for every PFI in the caller's scope. Also before "/:id".
router.get("/register", verifyStaff, getPfiRegister);

// Trucks allocated off a cargo (migration 0063). Before "/:id", which would
// otherwise take "allocations" for an id.
router.get("/allocations", verifyStaff, validate({ query: misc.listPfiAllocations }), listAllocations);
router.post(
  "/allocations/:allocationId/approve",
  verifyStaff,
  validate({ params: misc.pfiAllocationParam, body: misc.decidePfiAllocation }),
  approveAllocation,
);
router.post(
  "/allocations/:allocationId/reject",
  verifyStaff,
  validate({ params: misc.pfiAllocationParam, body: misc.decidePfiAllocation }),
  rejectAllocation,
);
router.post(
  "/allocations/:allocationId/withdraw",
  verifyStaff,
  validate({ params: misc.pfiAllocationParam, body: misc.decidePfiAllocation }),
  withdrawAllocation,
);

router.get("/", verifyStaff, validate({ query: misc.listPfis }), getPfis);
router.post("/", verifyStaff, validate({ body: misc.createPfi }), createPfi);

router.get("/:id", verifyStaff, validate({ params: misc.idParam }), getPfiById);
router.patch("/:id", verifyStaff, validate({ params: misc.idParam, body: misc.updatePfi }), updatePfi);
// Deleting a PFI takes its movements, locations and expense categories with
// it and cannot be undone: a super admin's alone.
router.delete("/:id", verifyStaff, enforceRole({ message: "Only a super admin can delete a PFI" }), validate({ params: misc.idParam }), deletePfi);

// Releasing a PFI to trade. "/start" stays as the old name for anything still
// calling it — it is the same handler, which now requires a bank account and
// officers rather than flipping a status.
// Releasing a PFI to trade names its bank account and officers: an admin's act.
const ACTIVATE = enforceRole("admin", { message: "Only an admin or a super admin can release a PFI to trade" });
router.post("/:id/start", verifyStaff, ACTIVATE, validate({ params: misc.idParam }), startPfi);
router.post("/:id/activate", verifyStaff, ACTIVATE, validate({ params: misc.idParam }), activatePfi);
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

// Evacuation surplus — product found when a PFI is run down. See migration 0053.
router.get("/:id/surpluses", verifyStaff, validate({ params: misc.idParam }), getPfiSurpluses);
router.post(
  "/:id/surpluses",
  verifyStaff,
  validate({ params: misc.idParam, body: misc.recordPfiSurplus }),
  addPfiSurplus
);
router.post(
  "/:id/surpluses/:entryId/void",
  verifyStaff,
  validate({ params: misc.pfiSurplusParam, body: misc.voidPfiSurplus }),
  voidPfiSurplus
);

// Operational loss — product gone from the tank without being sold. The
// mirror of the surplus. See migration 0073.
router.get("/:id/losses", verifyStaff, validate({ params: misc.idParam }), getPfiLosses);
router.post(
  "/:id/losses",
  verifyStaff,
  validate({ params: misc.idParam, body: misc.recordPfiLoss }),
  addPfiLoss
);
router.post(
  "/:id/losses/:entryId/void",
  verifyStaff,
  validate({ params: misc.pfiLossParam, body: misc.voidPfiLoss }),
  voidPfiLoss
);

// The PFI file: everything about one PFI, for its page and its report.
router.get("/:id/allocations", verifyStaff, validate({ params: misc.idParam }), getPfiAllocations);
router.post(
  "/:id/allocations",
  verifyStaff,
  validate({ params: misc.idParam, body: misc.raisePfiAllocation }),
  raiseAllocation,
);
router.get("/:id/file", verifyStaff, validate({ params: misc.idParam }), getPfiFile);

// Notes on the file — what happened, what went wrong, what was decided. See
// migration 0058.
router.get("/:id/notes", verifyStaff, validate({ params: misc.idParam }), listPfiNotes);
router.post(
  "/:id/notes",
  verifyStaff,
  validate({ params: misc.idParam, body: misc.addPfiNote }),
  addPfiNote
);
router.patch(
  "/:id/notes/:noteId",
  verifyStaff,
  validate({ params: misc.pfiNoteParam, body: misc.updatePfiNote }),
  updatePfiNote
);
router.delete("/:id/notes/:noteId", verifyStaff, validate({ params: misc.pfiNoteParam }), deletePfiNote);

module.exports = router;
