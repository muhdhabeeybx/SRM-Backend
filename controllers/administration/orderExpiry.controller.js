const asyncHandler = require("express-async-handler");
const { expireStaleOrders } = require("../../services/order.service");
const { expireStaleRequests } = require("../../services/requestExpiry.service");

/**
 * Expire everything whose day has ended (23:59 Africa/Lagos):
 * - Depot orders: Pending + wholly unpaid, placed on an earlier day
 * - Dangote requests: Approved + unpaid, reviewed on an earlier day
 * - LPG requests: Approved + unpaid, reviewed on an earlier day
 *
 * The nightly cron in jobs/scheduler.js does this at 23:59; this endpoint is
 * the manual lever for when the scheduler is off or a run was missed. Run at
 * any hour it only lapses what is genuinely past its deadline — orders placed
 * today survive a midday run — so it is idempotent and safe to call twice.
 */
const runExpiry = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const expired = await expireStaleOrders();
  const requests = await expireStaleRequests();

  const totalExpired = expired + requests.dangote + requests.lpg;

  console.log(
    `[expiry] manual run by staff ${req.user.id} expired ${expired} depot order(s), ` +
    `${requests.dangote} Dangote request(s), ${requests.lpg} LPG request(s) in ${Date.now() - startedAt}ms`
  );

  res.json({
    success: true,
    message: `Expired ${totalExpired} order(s)/request(s) (${expired} depot, ${requests.dangote} Dangote, ${requests.lpg} LPG)`,
    data: { depotOrders: expired, dangoteRequests: requests.dangote, lpgRequests: requests.lpg, durationMs: Date.now() - startedAt },
  });
});

module.exports = { runExpiry };
