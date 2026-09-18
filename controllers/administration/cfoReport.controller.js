const asyncHandler = require("express-async-handler");
const { cfoReportRepo } = require("../../repositories");
const cfoReportService = require("../../services/cfoReport.service");
const { CFO_OVERRIDE_FIELDS } = require("../../db/schema/cfoReportEntry");

/**
 * The CFO report — one block per day, one row per batch.
 *
 * All of the arithmetic is in services/cfoReport.service.js, including a full
 * account of where each column comes from. This only unpacks the query and
 * hands the answer back.
 */
const getCfoReport = asyncHandler(async (req, res) => {
  const result = await cfoReportService.build({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    depotId: req.query.depotId,
    pfiId: req.query.pfiId,
    includeAll: req.query.includeAll,
    // Location/PFI scope still narrows which batches a non-super_admin sees,
    // the same way it does on every other report.
    scopeUser: req.user,
  });

  res.json({ success: true, data: result });
});

/**
 * Save a correction against one batch on one date.
 *
 * ── Present-versus-absent, not truthy-versus-falsy ─────────────────────────
 *
 * The update is built from the keys the request actually carried. A field
 * sent as null clears its override; a field left out is not touched. Building
 * it from truthiness instead would make 0 unsavable and null indistinguishable
 * from "leave it alone" — and 0 is a real correction on a report where a
 * batch legitimately sold nothing.
 */
const saveCfoReportEntry = asyncHandler(async (req, res) => {
  const { reportDate, pfiId, remarks } = req.body;

  const values = {};
  for (const field of CFO_OVERRIDE_FIELDS) {
    if (Object.hasOwn(req.body, field)) {
      // Drizzle's decimal columns take a string; a JS number would arrive as
      // one anyway and round-trip through the driver's own formatting.
      values[field] = req.body[field] == null ? null : String(req.body[field]);
    }
  }
  if (remarks !== undefined) values.remarks = remarks;

  const row = await cfoReportRepo.upsertEntry({
    reportDate,
    pfiId: Number(pfiId),
    values,
    staffId: req.user?.id ?? null,
  });

  res.json({ success: true, data: row });
});

/**
 * Drop every correction on a row, putting it back to what the system says.
 *
 * Deleting the row rather than nulling its columns one at a time: "nobody has
 * corrected this cell" is exactly the absence of a row, and leaving an empty
 * one behind would put a name and a timestamp on a correction that is no
 * longer there.
 */
const deleteCfoReportEntry = asyncHandler(async (req, res) => {
  const row = await cfoReportRepo.deleteEntry({
    reportDate: req.query.reportDate,
    pfiId: Number(req.query.pfiId),
  });

  // A delete of something already absent is the state the caller asked for,
  // so it is a success with nothing to report — not a 404.
  res.json({ success: true, data: row });
});

module.exports = { getCfoReport, saveCfoReportEntry, deleteCfoReportEntry };
