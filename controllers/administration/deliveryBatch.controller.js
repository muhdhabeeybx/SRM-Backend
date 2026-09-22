const { allocationCodesFor } = require("../../lib/pfiScope");
const asyncHandler = require("express-async-handler");
const { deliveryBatchRepo } = require("../../repositories");

/**
 * Closing a delivery batch, and reopening it.
 *
 * A batch is a code and the loads recorded under it, so the code is the
 * identifier here — there is no batch id to take. See
 * db/migrations/0028_delivery_batch_status.sql.
 */

const STATUSES = ["active", "completed"];

/** Every batch that has a status row. Codes with none are active. */
const getDeliveryBatchStatuses = asyncHandler(async (req, res) => {
  const all = await deliveryBatchRepo.findStatuses();
  // Staff assigned to a PFI see its batches' statuses and no others.
  const codes = await allocationCodesFor(req.user);
  const batches = codes === null
    ? all
    : Object.fromEntries(Object.entries(all || {}).filter(([k]) => codes.includes(String(k).trim().toUpperCase())));
  res.json({ success: true, data: { batches } });
});

const setDeliveryBatchStatus = asyncHandler(async (req, res) => {
  const code = deliveryBatchRepo.normalise(req.params.code);
  if (!code) {
    return res.status(400).json({ success: false, message: "A batch code is required" });
  }
  const codes = await allocationCodesFor(req.user);
  if (codes !== null && !codes.includes(String(code).trim().toUpperCase())) {
    return res.status(403).json({ success: false, message: "That batch is not on your PFI." });
  }

  const status = String(req.body?.status || "").trim();
  if (!STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${STATUSES.join(", ")}`,
    });
  }

  /**
   * The name is taken from the session, never from the request body. A closed
   * batch says who finished with it, and a client that can name somebody else
   * makes that line worth nothing.
   */
  const staffName = String(req.user?.name || req.user?.email || "").trim();

  const batch = await deliveryBatchRepo.setStatus(code, {
    status,
    staffName,
    note: String(req.body?.note || "").slice(0, 2000),
  });

  res.json({ success: true, data: { batch } });
});

// ── Filling-station delivery cycles ─────────────────────────────────────────

/** Every cycle that has a status row. Keys with none are active. */
const getStationCycleStatuses = asyncHandler(async (req, res) => {
  const cycles = await deliveryBatchRepo.findCycleClosures();
  res.json({ success: true, data: { cycles } });
});

/**
 * The key travels in the body, not the path.
 *
 * A cycle key is the register's own group key — "sale:AKR-221|2026-08-04::812::
 * IBADAN OYO RD" — and it carries whatever the location field holds, slashes
 * included. In a path that is a routing accident waiting to happen however
 * carefully it is encoded; in the body it is just a string.
 */
const setStationCycleStatus = asyncHandler(async (req, res) => {
  const cycleKey = String(req.body?.key || "").trim();
  if (!cycleKey) {
    return res.status(400).json({ success: false, message: "A cycle key is required" });
  }

  const status = String(req.body?.status || "").trim();
  if (!STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `status must be one of: ${STATUSES.join(", ")}`,
    });
  }

  const staffName = String(req.user?.name || req.user?.email || "").trim();

  const cycle = await deliveryBatchRepo.setCycleStatus(cycleKey, {
    status,
    staffName,
    note: String(req.body?.note || "").slice(0, 2000),
  });

  res.json({ success: true, data: { cycle } });
});

module.exports = {
  getDeliveryBatchStatuses,
  setDeliveryBatchStatus,
  getStationCycleStatuses,
  setStationCycleStatus,
};
