const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
  getDeliveryInventory,
  getDeliveryInventoryById,
  createDeliveryInventory,
  updateDeliveryInventory,
  setDeliveryTripCosts,
  deleteDeliveryInventory,
} = require("../../controllers/administration/deliveryInventory.controller");
const {
  confirmAllocation,
  releaseAllocation,
  rejectAllocation,
} = require("../../controllers/administration/deliveryRelease.controller");
const {
  getDeliveryBatchStatuses,
  setDeliveryBatchStatus,
} = require("../../controllers/administration/deliveryBatch.controller");

/**
 * Closing a batch, and reopening it.
 *
 * Above the /:id routes deliberately: "batches" would otherwise be read as an
 * id by GET /:id and answer 404 for a request that is not about a row at all.
 * A batch is a code and the loads under it, so the code is the identifier —
 * see db/migrations/0028_delivery_batch_status.sql.
 */
router.get("/batches", verifyStaff, getDeliveryBatchStatuses);
router.patch("/batches/:code", verifyStaff, setDeliveryBatchStatus);

router.get("/", verifyStaff, validate({ query: misc.listInventory }), getDeliveryInventory);
router.get("/:id", verifyStaff, validate({ params: misc.idParam }), getDeliveryInventoryById);
router.post("/", verifyStaff, validate({ body: misc.createInventory }), createDeliveryInventory);
// Above "/:id" so "costs" is never read as an inventory id.
router.post(
  "/costs",
  verifyStaff,
  validate({ body: misc.bulkCostInventory }),
  setDeliveryTripCosts
);

router.patch("/:id", verifyStaff, validate({ params: misc.idParam, body: misc.updateInventory }), updateDeliveryInventory);
router.delete("/:id", verifyStaff, validate({ params: misc.idParam }), deleteDeliveryInventory);

// Release workflow: pending -> confirmed -> released, one-way. Releasing
// posts the sale to the customer's delivery ledger.
router.post("/:id/confirm", verifyStaff, confirmAllocation);
router.post("/:id/release", verifyStaff, releaseAllocation);
router.post("/:id/reject", verifyStaff, rejectAllocation);

module.exports = router;
