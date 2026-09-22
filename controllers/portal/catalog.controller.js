const asyncHandler = require("express-async-handler");
const { publicCatalog } = require("../../services/catalog.service");
const { orderExpiryDisabled, expiryDeadline } = require("../../config/orderExpiry");

/**
 * GET /api/catalog — the orderable depots with priced products, public.
 *
 * Public on purpose: the marketing site shows live prices to visitors who have
 * no account yet, and WhatsApp already quotes the same prices to anyone who
 * messages in. What stays private is quantities — publicCatalog strips stock
 * litres before anything leaves the process.
 *
 * ── The payment window ─────────────────────────────────────────────────────
 *
 * An unpaid order lapses at 23:59 Lagos on the day it is placed, so the window
 * is an INSTANT, not a duration — someone ordering at 09:00 has fifteen hours
 * and someone ordering at 23:00 has an hour. `orderExpiryAt` is that instant
 * for an order placed right now.
 *
 * `orderExpiryHours` is kept, and kept null, on purpose. It used to carry
 * ORDER_EXPIRY_HOURS so the portal could promise "pay within 24 hours". Under
 * an end-of-day deadline that sentence is wrong for every order but one placed
 * at midnight, and wrong in the customer's favour. Null is the value the
 * portal already handles — it drops the payment-window promise rather than
 * stating a deadline nothing enforces — so an un-migrated caller degrades to
 * saying nothing instead of saying something false. Callers that want the real
 * deadline read `orderExpiryAt`.
 */
const getCatalog = asyncHandler(async (req, res) => {
  const depots = await publicCatalog();
  const off = orderExpiryDisabled();
  res.json({
    success: true,
    data: {
      depots,
      orderExpiryHours: null,
      orderExpiryAt: off ? null : expiryDeadline(new Date()).toISOString(),
      orderExpiryPolicy: off ? null : "end-of-day",
    },
  });
});

module.exports = { getCatalog };
