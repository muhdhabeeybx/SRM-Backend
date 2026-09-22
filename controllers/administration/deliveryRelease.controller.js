const { client } = require("../../config/db");
const { allocationCodesFor } = require("../../lib/pfiScope");

/**
 * Staff assigned to a PFI may confirm, release or reject only the trucks on
 * its batches. One outside them reads as not found.
 */
const allocationVisible = async (user, id) => {
  const codes = await allocationCodesFor(user);
  if (codes === null) return true;
  const [row] = await client`
    SELECT upper(trim(allocation_code)) AS code FROM delivery_inventory WHERE id = ${Number(id)}`;
  return !!row && codes.includes(row.code);
};
const notFound = (res) => res.status(404).json({ success: false, message: "Allocation not found" });
const asyncHandler = require("express-async-handler");
const deliveryService = require("../../services/delivery.service");
const { sendServiceResult } = require("../../utils/serviceResult");
const { staffActor } = require("../../utils/actor");

// Release workflow endpoints for delivery allocations. Kept apart from the
// CRUD controller: these are state transitions with financial consequences,
// not field edits.

const confirmAllocation = asyncHandler(async (req, res) => {
  if (!(await allocationVisible(req.user, req.params.id))) return notFound(res);
  const result = await deliveryService.confirmAllocation(req.params.id, {
    actor: staffActor(req),
  });
  sendServiceResult(res, result, { message: "Allocation confirmed" });
});

const releaseAllocation = asyncHandler(async (req, res) => {
  if (!(await allocationVisible(req.user, req.params.id))) return notFound(res);
  const result = await deliveryService.releaseAllocation(req.params.id, {
    actor: staffActor(req),
  });
  sendServiceResult(res, result, { message: "Allocation released" });
});

const rejectAllocation = asyncHandler(async (req, res) => {
  if (!(await allocationVisible(req.user, req.params.id))) return notFound(res);
  const result = await deliveryService.rejectAllocation(req.params.id, {
    actor: staffActor(req),
    reason: req.body.reason || "",
  });
  sendServiceResult(res, result, { message: "Allocation rejected back to pending" });
});

module.exports = { confirmAllocation, releaseAllocation, rejectAllocation };
