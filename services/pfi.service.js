const { pfiRepo } = require("../repositories");
const { sellableQty } = require("../lib/pfiStock");

async function getAvailableCapacity(depotId, productId) {
  const activePfis = await pfiRepo.findActiveByDepotAndProduct(depotId, productId);

  return activePfis.reduce((total, pfi) => {
    const available = sellableQty(pfi);
    return total + available;
  }, 0);
}

/**
 * How much of each product a depot can actually sell right now.
 *
 * Matches the two ways a batch reaches a depot, the same pair
 * findActiveByDepotAndProduct uses:
 *
 *   the batch lives here      `location_id` — a coastal cargo is sold out of
 *                             the depot it landed at
 *   the batch is lent here    a delivery allocation is loaded at one depot
 *                             and drawn on by others, so a depot on its
 *                             allowlist may sell from it too
 *
 * Both halves were needed and only one was widened. Placing an order already
 * found a lent batch, but the order wizard asks THIS for the figure it
 * validates against, and it still matched on `location_id` alone — so a
 * delivery batch lent to Kano read as 0 available there and the wizard
 * refused the order before the server ever saw it. "Out of stock at Soroman
 * Kano (no active PFI stock assigned)" over a live batch with a million
 * litres on it and Kano ticked on its own allowlist.
 */
async function getDepotCapacities(depotId) {
  const { db } = require("../config/db");
  const { pfis } = require("../db/schema");
  const { eq, and, or, sql } = require("drizzle-orm");

  const numericDepotId = parseInt(depotId, 10);
  if (isNaN(numericDepotId)) return {};

  const activePfis = await db
    .select({
      productId: pfis.productId,
      startingQtyLitres: pfis.startingQtyLitres,
      evacuationSurplusLitres: pfis.evacuationSurplusLitres,
      soldQtyLitres: pfis.soldQtyLitres,
    })
    .from(pfis)
    .where(
      and(
        eq(pfis.status, "active"),
        or(
          eq(pfis.locationId, numericDepotId),
          // Raw because pfi_allowed_locations has no drizzle schema — it is a
          // hand-written table (migration 0027), same as in the repository.
          sql`EXISTS (
            SELECT 1 FROM pfi_allowed_locations al
             WHERE al.pfi_id = ${pfis.id} AND al.depot_id = ${numericDepotId}
          )`
        )
      )
    );

  const capacityMap = {};
  for (const pfi of activePfis) {
    const prodKey = pfi.productId;
    if (!prodKey) continue;
    const available = sellableQty(pfi);
    capacityMap[prodKey] = (capacityMap[prodKey] || 0) + available;
    capacityMap[String(prodKey)] = capacityMap[prodKey];
  }

  return capacityMap;
}

/**
 * The same figure for several depots at once, with the same two matches.
 *
 * The UNION is what stops a double count. A batch may be lent to the depot it
 * was already loaded at — both the PFI form and the New PFI dialog let you
 * tick it, and doing so is harmless by design — so without deduplicating the
 * (batch, depot) pair that batch's litres would be added to that depot twice
 * and the depot would report stock it does not have.
 */
async function getMultiDepotCapacities(depotIds) {
  const { db } = require("../config/db");
  const { sql } = require("drizzle-orm");

  const numericIds = (depotIds || []).map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
  if (numericIds.length === 0) return {};

  const result = await db.execute(sql`
    SELECT reach.depot_id     AS "locationId",
           p.product_id       AS "productId",
           p.starting_qty_litres AS "startingQtyLitres",
           p.evacuation_surplus_litres AS "evacuationSurplusLitres",
           p.sold_qty_litres     AS "soldQtyLitres"
      FROM pfis p
      JOIN (
             SELECT id AS pfi_id, location_id AS depot_id FROM pfis
              WHERE location_id IS NOT NULL
             UNION
             SELECT pfi_id, depot_id FROM pfi_allowed_locations
           ) reach ON reach.pfi_id = p.id
     WHERE p.status = 'active'
       AND reach.depot_id IN ${sql`(${sql.join(numericIds.map((n) => sql`${n}`), sql`, `)})`}
  `);
  const activePfis = result.rows ?? result;

  const pfiCapacityMap = {};
  for (const pfi of activePfis) {
    const depotKey = pfi.locationId;
    const prodKey = pfi.productId;
    if (!prodKey) continue;
    if (!pfiCapacityMap[depotKey]) pfiCapacityMap[depotKey] = {};
    if (!pfiCapacityMap[String(depotKey)]) pfiCapacityMap[String(depotKey)] = pfiCapacityMap[depotKey];
    const available = sellableQty(pfi);
    pfiCapacityMap[depotKey][prodKey] =
      (pfiCapacityMap[depotKey][prodKey] || 0) + available;
    pfiCapacityMap[depotKey][String(prodKey)] = pfiCapacityMap[depotKey][prodKey];
  }

  return pfiCapacityMap;
}

/**
 * Find one or more PFIs that can collectively fulfil an order.
 *
 * When a single PFI has enough stock it is returned alone (backward-compatible
 * behaviour). When stock is spread across multiple PFIs a greedy fill picks
 * enough PFIs to cover the requested quantity.
 *
 * @returns {{ allocations: Array<{pfi: object, quantity: number}>, totalAvailableStock: number }}
 *   allocations — PFI + quantity pairs to reserve (empty when stock is short)
 *   totalAvailableStock — sum of all available PFI stock (for error messages)
 */
async function findPfiForOrder(depotId, productId, quantity) {
  const activePfis = await pfiRepo.findActiveByDepotAndProduct(depotId, productId);

  const needed = Number(quantity);
  let remaining = needed;
  const allocations = [];
  let totalAvailableStock = 0;

  for (const pfi of activePfis) {
    if (remaining <= 0) break;
    const available = sellableQty(pfi);
    if (available <= 0) continue;
    totalAvailableStock += available;

    const take = Math.min(available, remaining);
    allocations.push({ pfi, quantity: take });
    remaining -= take;
  }

  return { allocations, totalAvailableStock };
}

module.exports = {
  getAvailableCapacity,
  getDepotCapacities,
  getMultiDepotCapacities,
  findPfiForOrder,
};
