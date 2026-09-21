const { z } = require("zod");

/**
 * Refund requests and payments.
 *
 * Zod strips unknown keys, so these double as whitelists — which is what stops
 * a request naming its own status, or setting paidAt on something nobody has
 * paid.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listRefunds = z.object({
  status: z.enum(["requested", "refunded", "cancelled", "skipped"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const listRefundable = z.object({
  search: z.string().max(120).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const createRefund = z.object({
  orderId: z.coerce.number().int().positive(),
  /**
   * Omitted means the order's whole overpayment, which is the ordinary case —
   * the point of a refund is that the overpayment becomes nothing. A figure
   * may be smaller; the service refuses anything larger.
   */
  amount: z.coerce.number().positive().optional(),
  // Where the money goes. Required: it is what the person paying works from,
  // and a request without it cannot be acted on.
  destinationBank: z.string().min(1, "The customer's bank is needed").max(255),
  destinationName: z.string().min(1, "The account name is needed").max(255),
  destinationNumber: z.string().min(1, "The account number is needed").max(30),
  reason: z.string().max(2000).optional(),
});

const payRefund = z.object({
  paidFromAccountId: z.coerce.number().int().positive(),
  paymentReference: z.string().max(255).optional(),
  /** The day the money left — what the CFO report counts it against. */
  paidAt: z.string().datetime().or(z.string().date()).optional(),
});

/**
 * Setting an overpayment aside needs a reason and nothing else — the amount is
 * whatever the order holds at that moment, read by the service rather than
 * sent, so nobody can waive a different figure from the one on screen.
 */
const skipOrder = z.object({
  orderId: z.coerce.number().int().positive(),
  reason: z.string().min(1, "Say why this one is not being refunded").max(2000),
});

/** Both undoing acts need a reason: a money record changed silently is worse. */
const reasonBody = z.object({ reason: z.string().min(1, "A reason is required").max(2000) });

module.exports = {
  idParam, listRefunds, listRefundable, createRefund, payRefund, reasonBody, skipOrder,
};
