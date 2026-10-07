const asyncHandler = require("express-async-handler");
const svc = require("../../services/lpgDelivery.service");

/** LPG plant deliveries — the rules are in services/lpgDelivery.service.js. */

const guarded = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || err.statusCode;
    if (!status) throw err;
    res.status(status).json({ success: false, message: err.message, details: err.details });
  }
});

const listDeliveries = guarded(async (req, res) => {
  res.json({ success: true, data: await svc.list({ plantId: Number(req.query.plant), user: req.user }) });
});

const listPfis = guarded(async (req, res) => {
  res.json({ success: true, data: { pfis: await svc.lpgPfis() } });
});

const recordDeliveries = guarded(async (req, res) => {
  const out = await svc.record({ ...req.body, user: req.user });
  const { summary } = out;
  const message = req.body.dryRun
    ? `${summary.toRecord} to record, ${summary.alreadyRecorded} already recorded, ${summary.errors} to fix`
    : summary.errors
      ? `Nothing recorded — ${summary.errors} row${summary.errors === 1 ? " needs" : "s need"} fixing first`
      : `${out.recorded} deliver${out.recorded === 1 ? "y" : "ies"} recorded` +
        (summary.alreadyRecorded ? `, ${summary.alreadyRecorded} already on record` : "");
  res.status(req.body.dryRun || summary.errors || !out.recorded ? 200 : 201).json({ success: true, message, data: out });
});

const updateDelivery = guarded(async (req, res) => {
  res.json({ success: true, message: "Delivery updated", data: await svc.update({ id: Number(req.params.id), patch: req.body, user: req.user }) });
});

const deleteDelivery = guarded(async (req, res) => {
  res.json({ success: true, message: "Delivery deleted", data: await svc.remove({ id: Number(req.params.id), user: req.user }) });
});

module.exports = { listDeliveries, listPfis, recordDeliveries, updateDelivery, deleteDelivery };
