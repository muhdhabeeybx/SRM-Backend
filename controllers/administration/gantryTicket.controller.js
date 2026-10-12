const asyncHandler = require("express-async-handler");
const gantryTickets = require("../../services/gantryTickets.service");
const { actorFor } = require("./expense.controller");
const { pfiRepo } = require("../../repositories");
const { scopedPfiIds } = require("../../lib/pfiBankScope");

/**
 * Gantry tickets — see services/gantryTickets.service.js for the rule.
 *
 *   GET  /pfis/gantry-ticket-desk                   the stock desk
 *   GET  /pfis/:id/gantry-tickets                   a PFI's tickets
 *   POST /pfis/:id/gantry-tickets                   enter tickets
 *   POST /pfis/:id/gantry-tickets/:ticketId/void    take one off
 *   GET  /orders/:id/gantry-tickets                 an order's tickets
 *   POST /orders/:id/gantry-tickets                 issue them — completes it
 *   PUT  /orders/:id/gantry-tickets                 change them, with a reason
 *
 * The service checks who may write (the stock officer on the PFI, or an
 * admin); the frontend hides the buttons from everybody else.
 */

const pfiInScope = async (req) => {
  const pfi = await pfiRepo.findById(req.params.id);
  const ids = scopedPfiIds(req.user);
  if (!pfi || (ids !== null && !ids.includes(Number(pfi.id)))) {
    throw Object.assign(new Error("PFI not found"), { status: 404 });
  }
  return pfi;
};

const getDesk = asyncHandler(async (req, res) => {
  const data = await gantryTickets.deskOrders(req.user);
  res.json({ success: true, data });
});

const getPfiTickets = asyncHandler(async (req, res) => {
  const pfi = await pfiInScope(req);
  const data = await gantryTickets.listForPfi(pfi.id, req.user);
  res.json({ success: true, data });
});

const addPfiTickets = asyncHandler(async (req, res) => {
  const pfi = await pfiInScope(req);
  const { actorName } = await actorFor(req);
  const result = await gantryTickets.addTickets({
    pfiId: pfi.id,
    entries: req.body?.tickets,
    user: req.user,
    actorName,
  });
  res.status(201).json({
    success: true,
    message: `${result.added.toLocaleString()} ticket${result.added === 1 ? "" : "s"} (${result.litres.toLocaleString()} L) entered on ${result.pfiNumber}`,
    data: result,
  });
});

const voidPfiTicket = asyncHandler(async (req, res) => {
  const pfi = await pfiInScope(req);
  const { actorName } = await actorFor(req);
  const result = await gantryTickets.voidTicket({
    pfiId: pfi.id,
    ticketId: req.params.ticketId,
    reason: req.body?.reason,
    user: req.user,
    actorName,
  });
  res.json({ success: true, message: `Ticket ${result.ticketNumber} taken off`, data: result });
});

const getOrderTickets = asyncHandler(async (req, res) => {
  const data = await gantryTickets.forOrder(req.params.id, req.user);
  res.json({ success: true, data });
});

const issueOrderTickets = asyncHandler(async (req, res) => {
  const { actorName } = await actorFor(req);
  const result = await gantryTickets.issue({
    orderId: req.params.id,
    ticketIds: req.body?.ticketIds,
    user: req.user,
    actorName,
  });
  res.json({
    success: true,
    message: `${result.ref} completed on ticket${result.numbers.length === 1 ? "" : "s"} ${result.numbers.join(", ")}`,
    data: result,
  });
});

const changeOrderTickets = asyncHandler(async (req, res) => {
  const { actorName } = await actorFor(req);
  const result = await gantryTickets.change({
    orderId: req.params.id,
    ticketIds: req.body?.ticketIds,
    reason: req.body?.reason,
    user: req.user,
    actorName,
  });
  res.json({
    success: true,
    message: `${result.ref} is now on ${result.after.join(", ")}`,
    data: result,
  });
});

module.exports = {
  getDesk,
  getPfiTickets,
  addPfiTickets,
  voidPfiTicket,
  getOrderTickets,
  issueOrderTickets,
  changeOrderTickets,
};
