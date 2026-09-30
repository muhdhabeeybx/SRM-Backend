const asyncHandler = require("express-async-handler");
const { client } = require("../../db");
const { fleetTruckRepo } = require("../../repositories");
const fleetService = require("../../services/fleet.service");
const { sendServiceResult } = require("../../utils/serviceResult");
const { staffActor } = require("../../utils/actor");
const { dayEdge, lagosToday, localDateStr } = require("../../lib/zonedDay");

const getFleetTrucks = asyncHandler(async (req, res) => {
  const result = await fleetTruckRepo.findAll(req.query);
  res.json({ success: true, data: result });
});

const getFleetTruckById = asyncHandler(async (req, res) => {
  const truck = await fleetTruckRepo.findById(req.params.id);
  if (!truck) {
    return res.status(404).json({ success: false, message: "Fleet truck not found" });
  }
  res.json({ success: true, data: { truck } });
});

const createFleetTruck = asyncHandler(async (req, res) => {
  const result = await fleetService.createTruck(req.body, { actor: staffActor(req) });
  sendServiceResult(res, result, { successStatus: 201, message: "Fleet truck created" });
});

const updateFleetTruck = asyncHandler(async (req, res) => {
  const result = await fleetService.updateTruck(req.params.id, req.body, { actor: staffActor(req) });
  sendServiceResult(res, result, { message: "Fleet truck updated" });
});

const getComplianceWatchlist = asyncHandler(async (req, res) => {
  // Everything expiring in the next 30 days by default.
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const byDate = localDateStr(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
  const trucks = await fleetTruckRepo.findExpiringCompliance(byDate);
  res.json({ success: true, data: { byDate, trucks } });
});

const recordLedgerEntry = asyncHandler(async (req, res) => {
  const result = await fleetService.recordLedgerEntry(req.params.id, req.body, {
    actor: staffActor(req),
  });
  sendServiceResult(res, result, { successStatus: 201, message: "Ledger entry recorded" });
});

/** POST /api/fleet/ledger/batch — one posting spread across many trucks. */
const recordLedgerBatch = asyncHandler(async (req, res) => {
  const result = await fleetService.recordLedgerEntriesBatch(req.body.entries, {
    actor: staffActor(req),
  });
  sendServiceResult(res, result, {
    successStatus: 201,
    message: `${req.body.entries.length} ledger entries recorded`,
  });
});

const getLedgerEntries = asyncHandler(async (req, res) => {
  const result = await fleetTruckRepo.findLedgerEntries({ ...req.query, truckId: req.params.id });
  const summary = await fleetTruckRepo.summarizeLedger({
    truckId: req.params.id,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  });
  res.json({ success: true, data: { ...result, summary } });
});

/** GET /api/fleet/ledger — every entry, for the Directory's money rollup. */
const getAllLedgerEntries = asyncHandler(async (req, res) => {
  // Denormalised plate and driver ride on each row so the table renders in
  // one pass without a second lookup per entry.
  const rows = await client`
    SELECT l.*, t.plate_number AS truck_plate, t.driver_name AS truck_driver
    FROM fleet_ledger_entries l
    JOIN fleet_trucks t ON t.id = l.truck_id
    ORDER BY l.entry_date DESC, l.id DESC
  `;
  res.json({ success: true, data: { entries: rows } });
});

/** PATCH /api/fleet/ledger/:entryId */
const updateLedgerEntry = asyncHandler(async (req, res) => {
  const id = Number(req.params.entryId);
  const { truckId, entryType, category, amount, entryDate, description } = req.body || {};

  if (entryType && !["expense", "income"].includes(entryType)) {
    return res.status(400).json({ success: false, message: "entryType must be expense or income" });
  }
  if (amount !== undefined && Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: "Amount must be greater than zero" });
  }
  // A bad truck id 404s rather than silently detaching the entry.
  if (truckId !== undefined) {
    const [t] = await client`SELECT id FROM fleet_trucks WHERE id = ${Number(truckId)}`;
    if (!t) return res.status(404).json({ success: false, message: "Truck not found" });
  }

  const [row] = await client`
    UPDATE fleet_ledger_entries SET
      truck_id     = COALESCE(${truckId ?? null}::int, truck_id),
      entry_type   = COALESCE(${entryType ?? null}, entry_type),
      category     = COALESCE(${category ?? null}, category),
      amount       = COALESCE(${amount ?? null}::numeric, amount),
      entry_date   = COALESCE(${entryDate ?? null}::date, entry_date),
      description  = COALESCE(${description ?? null}, description),
      updated_at   = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) return res.status(404).json({ success: false, message: "Entry not found" });
  res.json({ success: true, message: "Entry updated", data: { entry: row } });
});

/** DELETE /api/fleet/ledger/:entryId */
const deleteLedgerEntry = asyncHandler(async (req, res) => {
  const [row] = await client`
    DELETE FROM fleet_ledger_entries WHERE id = ${Number(req.params.entryId)} RETURNING id
  `;
  if (!row) return res.status(404).json({ success: false, message: "Entry not found" });
  res.json({ success: true, message: "Entry deleted", data: { id: row.id } });
});

/**
 * DELETE /api/fleet/:id
 *
 * Conditional. A truck carrying ledger entries is soft-deleted so the money
 * history stays intact; only a truck with none is actually removed.
 */
const deleteFleetTruck = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const [{ count }] = await client`
    SELECT count(*)::int AS count FROM fleet_ledger_entries WHERE truck_id = ${id}
  `;

  if (count > 0) {
    const [row] = await client`
      UPDATE fleet_trucks SET is_active = false, updated_at = now()
      WHERE id = ${id} RETURNING id
    `;
    if (!row) return res.status(404).json({ success: false, message: "Truck not found" });
    return res.json({
      success: true,
      message: `Truck retired — ${count} ledger entr${count === 1 ? "y" : "ies"} kept`,
      data: { id, softDeleted: true, entries: count },
    });
  }

  const [row] = await client`DELETE FROM fleet_trucks WHERE id = ${id} RETURNING id`;
  if (!row) return res.status(404).json({ success: false, message: "Truck not found" });
  res.json({ success: true, message: "Truck deleted", data: { id, softDeleted: false } });
});

module.exports = {
  getFleetTrucks,
  getFleetTruckById,
  createFleetTruck,
  updateFleetTruck,
  getComplianceWatchlist,
  recordLedgerEntry,
  recordLedgerBatch,
  getLedgerEntries,
  getAllLedgerEntries,
  updateLedgerEntry,
  deleteLedgerEntry,
  deleteFleetTruck,
};
