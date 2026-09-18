/**
 * What `pfis.sold_qty_litres` is supposed to equal, in one place.
 *
 *   sold_qty_litres = SUM(orders.quantity) for every order on the batch
 *                     whose status is not Cancelled or Expired
 *
 * The counter means "litres spoken for on this batch". Payment is NOT part of
 * it: an order reserves its litres the moment it is placed, because product
 * cannot be offered twice while somebody is paying for it. That is why the
 * figure differs from the batch's SOLD figure, which counts confirmed payment
 * only (see lib/pfiFinance.js) — the two answer different questions and both
 * are right.
 *
 * The counter is not derived. `reserveStock` raises it and `releaseStock`
 * lowers it, inside the transaction of the order write that caused the change,
 * so it is only ever as correct as the last path that moved an order. A path
 * that forgets breaks it permanently and silently — which is what the
 * bulk-assign endpoint did to 38 of 47 batches.
 *
 * This module exists so the rule is stated once and can be asserted, rather
 * than being re-derived by each caller. scripts/reconcile-pfi-stock-counters.js
 * classifies with it; tests/pfi-stock-invariant.test.js pins it.
 */

/**
 * Orders that have released their claim on stock.
 *
 * A cancelled or expired order is not waiting on anything — expiry explicitly
 * gives the litres back. Everything else that exists holds its quantity,
 * whatever its payment state.
 */
const DEAD_ORDER_STATUSES = ["Cancelled", "Expired"];

/** Does this order still hold litres against its batch? */
function holdsStock(order) {
  if (!order) return false;
  return !DEAD_ORDER_STATUSES.includes(String(order.status));
}

/**
 * What the counter should read for a batch, given its orders.
 *
 * @param {Array<{quantity: number|string, status: string}>} orders
 * @returns {number}
 */
function expectedReservation(orders) {
  return (orders || [])
    .filter(holdsStock)
    .reduce((sum, o) => sum + (Number(o.quantity) || 0), 0);
}

/**
 * Which way a batch has drifted, and what it means for the shop floor.
 *
 * `tank` is starting_qty_litres — the measured quantity the batch sells from.
 * `offeredNow` / `offeredAfter` are what the Create Order page shows before and
 * after a repair, which is the whole reason the direction matters:
 *
 *   under_reserved  the batch OFFERS litres that are already on an order.
 *                   Repairing takes them off the shelf; it can only ever
 *                   prevent a sale that should not have been possible.
 *
 *   over_reserved   the batch HOLDS litres no live order claims, so stock
 *                   nobody can buy. Repairing puts them back on sale, which is
 *                   right only if the orders are complete for that batch — so
 *                   it is never applied without being asked for.
 *
 * @returns {{drift: number, direction: "ok"|"under_reserved"|"over_reserved",
 *            expected: number, offeredNow: number, offeredAfter: number}}
 */
function classifyDrift({ counter, expected, tank }) {
  const c = Number(counter) || 0;
  const e = Number(expected) || 0;
  const t = Number(tank) || 0;
  const drift = c - e;
  return {
    drift,
    direction: drift === 0 ? "ok" : drift < 0 ? "under_reserved" : "over_reserved",
    expected: e,
    // Negative availability is not a thing you can sell, and the depot figure
    // clamps the same way (services/pfi.service.js) — an oversold batch reads
    // as nothing left, not as a negative.
    offeredNow: Math.max(0, t - c),
    offeredAfter: Math.max(0, t - e),
  };
}

module.exports = {
  DEAD_ORDER_STATUSES,
  holdsStock,
  expectedReservation,
  classifyDrift,
};
