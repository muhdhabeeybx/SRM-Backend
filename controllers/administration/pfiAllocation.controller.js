const asyncHandler = require("express-async-handler");
const allocations = require("../../services/pfiAllocation.service");

/**
 * Trucks allocated off a cargo. The rules live in
 * services/pfiAllocation.service.js; these only carry the request to it.
 */

/** GET /pfis/allocations?status=pending|approved|rejected|withdrawn|all */
const listAllocations = asyncHandler(async (req, res) => {
  const rows = await allocations.list({ status: req.query.status || "pending", scopeUser: req.user });
  res.json({ success: true, data: { allocations: rows, canApprove: allocations.isApprover(req.user) } });
});

/** GET /pfis/:id/allocations — its allocations, the one that made it, and the form's preview. */
const getPfiAllocations = asyncHandler(async (req, res) => {
  const data = await allocations.forPfi(req.params.id);
  res.json({ success: true, data: { ...data, canApprove: allocations.isApprover(req.user) } });
});

/** POST /pfis/:id/allocations */
const raiseAllocation = asyncHandler(async (req, res) => {
  const allocation = await allocations.raise({
    parentId: req.params.id,
    loadingDate: req.body.loadingDate,
    price: req.body.price,
    trucks: req.body.trucks,
    note: req.body.note,
    user: req.user,
  });
  res.status(201).json({
    success: true,
    message: `${allocation.pfiNumber} sent for approval`,
    data: { allocation },
  });
});

const approveAllocation = asyncHandler(async (req, res) => {
  const allocation = await allocations.approve({
    allocationId: req.params.allocationId,
    user: req.user,
    note: req.body?.note,
  });
  res.json({
    success: true,
    message: `${allocation.pfiNumber} approved — the order is placed and the PFI is raised`,
    data: { allocation },
  });
});

const rejectAllocation = asyncHandler(async (req, res) => {
  const allocation = await allocations.reject({
    allocationId: req.params.allocationId,
    user: req.user,
    note: req.body?.note,
  });
  res.json({ success: true, message: `${allocation.pfiNumber} rejected`, data: { allocation } });
});

const withdrawAllocation = asyncHandler(async (req, res) => {
  const allocation = await allocations.withdraw({
    allocationId: req.params.allocationId,
    user: req.user,
    note: req.body?.note,
  });
  res.json({ success: true, message: `${allocation.pfiNumber} withdrawn`, data: { allocation } });
});

module.exports = {
  listAllocations,
  getPfiAllocations,
  raiseAllocation,
  approveAllocation,
  rejectAllocation,
  withdrawAllocation,
};
