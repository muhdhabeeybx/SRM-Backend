const asyncHandler = require("express-async-handler");
const agoStock = require("../../services/agoStock.service");

/**
 * The AGO stock ledger — see services/agoStock.service.js for its rules.
 * Every refusal the service raises carries a status and a sentence the desk
 * can act on, and is answered as it is.
 */

const actorOf = (req) => ({ staffId: req.user?.id ?? null, staffName: req.user?.name || req.user?.email || "" });
const L = (n) => `${Number(n).toLocaleString("en-NG")} L`;

const answer = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ success: false, message: err.message });
  }
});

const getLedger = answer(async (req, res) => {
  res.json({ success: true, data: await agoStock.list() });
});

const getTrips = answer(async (req, res) => {
  res.json({ success: true, data: { trips: await agoStock.trips() } });
});

const STOCK_SAID = {
  opening: "Opening balance entered",
  received: "Stock received recorded",
  adjust_in: "Count adjustment recorded",
  adjust_out: "Count adjustment recorded",
};

const addStock = answer(async (req, res) => {
  const data = await agoStock.addStock(req.body, actorOf(req));
  res.status(201).json({ success: true, message: STOCK_SAID[req.body.kind], data });
});

const give = answer(async (req, res) => {
  const data = await agoStock.give(req.body, actorOf(req));
  res.status(201).json({
    success: true,
    message: `${L(data.litres)} of AGO given to ${data.trucks} truck${data.trucks === 1 ? "" : "s"}`,
    data,
  });
});

const change = answer(async (req, res) => {
  const data = await agoStock.change(req.params.entryId, req.body, actorOf(req));
  res.status(201).json({
    success: true,
    message: req.body.kind === "top_up"
      ? `Top-up of ${L(req.body.litres)} recorded for ${data.truckNumber}`
      : `${L(req.body.litres)} retrieved from ${data.truckNumber} and back in stock`,
    data,
  });
});

const update = answer(async (req, res) => {
  const data = await agoStock.update(req.params.entryId, req.body, actorOf(req));
  res.json({ success: true, message: "Entry corrected", data });
});

const remove = answer(async (req, res) => {
  const data = await agoStock.remove(req.params.entryId, actorOf(req));
  res.json({ success: true, message: "Entry deleted from the ledger", data });
});

module.exports = { getLedger, getTrips, addStock, give, change, update, remove };
