const z = require("zod");
const { id, enumOf, searchTerm } = require("./fields");

/** Surplus transfer requests — services/orderTransferRequest.service.js. */

const reason = z
  .string({ error: "Say why this money is moving" })
  .trim()
  .min(5, "Say why this money is moving — the approver decides on it, and the record keeps it")
  .max(2000, "Keep the reason under 2000 characters");
const note = z.string().trim().max(2000, "Keep the note under 2000 characters").optional();
const amount = z.coerce
  .number({ error: "Amount must be a number" })
  .positive("Amount must be greater than zero");

const createRequest = z.object({
  fromOrderId: id("The order the money comes from"),
  toOrderId: id("The order the money goes to"),
  amount,
  reason,
  note,
});

const createReversal = z.object({ transferId: id("Transfer"), reason, note });

const approve = z.object({ note });
const reject = z.object({
  note: z.string({ error: "Say why it is rejected" }).trim().min(3, "Say why it is rejected").max(2000),
});
const cancel = z.object({ note });

const idParam = z.object({ id: id("Request") });
const orderIdParam = z.object({ orderId: id("Order") });

const list = z.object({
  status: enumOf("Status", ["requested", "approved", "rejected", "cancelled", ""]).optional(),
  search: searchTerm,
  pfi: id("PFI").optional(),
  orderId: id("Order").optional(),
});

module.exports = { createRequest, createReversal, approve, reject, cancel, idParam, orderIdParam, list };
