/**
 * What a PFI has to sell, in one place.
 *
 *   stock    = starting_qty_litres + evacuation_surplus_litres - operational_loss_litres
 *   sellable = stock - sold_qty_litres
 *
 * starting_qty_litres is the tank figure measured at landing; an evacuation
 * surplus is product found when the PFI was run down (migration 0053); an
 * operational loss is product that left without being sold (migration 0073).
 * Every balance reads the three together — but only the landing
 * figure is what the cargo is costed on, which is why lib/pfiFinance.js keeps
 * reading startingQtyLitres alone.
 *
 * Accepts a drizzle row (camelCase) or a raw SQL row (snake_case), because
 * both reach the places that compute a balance.
 */

const num = (v) => Number(v) || 0;

/** Everything the PFI has had to sell: landed, plus any surplus found, less any loss. */
const stockQty = (pfi) =>
  num(pfi?.startingQtyLitres ?? pfi?.starting_qty_litres) +
  num(pfi?.evacuationSurplusLitres ?? pfi?.evacuation_surplus_litres) -
  num(pfi?.operationalLossLitres ?? pfi?.operational_loss_litres);

/** What is still there to sell. Never negative. */
const sellableQty = (pfi) =>
  Math.max(0, stockQty(pfi) - num(pfi?.soldQtyLitres ?? pfi?.sold_qty_litres));

module.exports = { stockQty, sellableQty };
