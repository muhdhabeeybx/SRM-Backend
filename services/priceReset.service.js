const { depotRepo, auditLogRepo } = require("../repositories");

/**
 * Take every depot price to 0 at the end of the trading day.
 *
 * A price is set for one day. Left standing overnight, yesterday's figure is
 * what the first order of the morning is billed at — before anybody has looked
 * at today's market. At 0 a product is off sale (nothing shows in the
 * catalogue and no order can be placed) until the desk sets the day's price.
 *
 * The same action as the "Set all prices to 0" button, run by the scheduler at
 * 23:59 Africa/Lagos (jobs/scheduler.js). Prices already at 0 are skipped, each
 * one moved is written to the depot price history, and the audit row keeps
 * what they were so the day's closing prices can always be read back.
 *
 * Price changes still waiting for approval are left alone: approving one sets
 * that price live, which is a person's decision rather than a leftover.
 */
const resetPricesForTheDay = async () => {
  const result = await depotRepo.zeroAllProductPrices();

  if (result.updated > 0) {
    await auditLogRepo.record({
      entityType: "depot",
      entityId: 0,
      action: "depot.prices_zeroed_nightly",
      actor: { type: "system" },
      metadata: { updated: result.updated, skipped: result.skipped, before: result.before },
    });
  }

  return result;
};

module.exports = { resetPricesForTheDay };
