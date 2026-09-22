const { assertOrderVisible } = require("../../lib/pfiScope");
const asyncHandler = require("express-async-handler");
const { ticketRepo } = require("../../repositories");

const getTickets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, search, status } = req.query;

  const result = await ticketRepo.findAll({ search, status, page, limit, scopeUser: req.user });

  res.json({ success: true, data: result });
});

const getTicketByIdOrCode = asyncHandler(async (req, res) => {
  const { idOrCode } = req.params;

  const ticket = await ticketRepo.findByIdOrCodeFull(idOrCode);

  // A ticket on another PFI's order reads as not found.
  if (ticket) {
    try {
      await assertOrderVisible(req.user, ticket.orderId ?? ticket.order?.id ?? ticket.order);
    } catch {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }
  }

  if (!ticket) {
    return res
      .status(404)
      .json({ success: false, message: "Ticket not found" });
  }

  res.json({ success: true, data: { ticket } });
});

const redeemTicket = asyncHandler(async (req, res) => {
  const { idOrCode } = req.params;
  const adminId = req.user?.id || req.user?._id;

  if (!adminId) {
    return res
      .status(401)
      .json({ success: false, message: "Unauthorized admin ID" });
  }

  const ticket = await ticketRepo.findByIdOrCode(idOrCode);
  if (ticket) {
    try {
      await assertOrderVisible(req.user, ticket.orderId ?? ticket.order?.id ?? ticket.order);
    } catch {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }
  }

  if (!ticket) {
    return res
      .status(404)
      .json({ success: false, message: "Ticket not found" });
  }

  if (ticket.status === "Redeemed") {
    return res
      .status(400)
      .json({ success: false, message: "Ticket has already been redeemed" });
  }

  await ticketRepo.update(ticket.id, {
    status: "Redeemed",
    redeemedAt: new Date(),
    redeemedBy: adminId,
  });

  /**
   * Redeeming a ticket does NOT complete the order.
   *
   * It used to, unconditionally: one redeemed ticket wrote Completed onto the
   * whole order however many trucks were still to come. 3,505 orders carry
   * 5,241 trucks that never gated out because of it — and once an order reads
   * Completed the gate refuses it ("Order is Completed; it is not open for
   * gating"), so those trucks could not be exited even by hand.
   *
   * It also wrote through orderRepo.update rather than orderStatus.transition,
   * so it bypassed the state machine and left no audit row. That is why almost
   * none of the affected orders can say how they were completed.
   *
   * An order is completed by the LAST TRUCK OUT, in gateOutTruck, which is the
   * only place that knows whether any remain — and it already requires both
   * that no load is outstanding and that the full quantity has been ticketed.
   * A ticket is permission to load; it is not evidence that loading finished.
   *
   * Deskless orders (gantry, delivery) have no gate and no trucks, and are
   * completed at payment by order.service — they never reach here.
   */

  const updatedTicket = await ticketRepo.findByIdOrCodeFull(ticket.id);

  res.json({
    success: true,
    message: "Ticket redeemed successfully",
    data: { ticket: updatedTicket },
  });
});

module.exports = {
  getTickets,
  getTicketByIdOrCode,
  redeemTicket,
};
