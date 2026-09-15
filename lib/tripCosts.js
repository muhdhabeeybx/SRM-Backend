/**
 * What a truck's trip cost, and what it earned.
 *
 * Four figures are entered — diesel litres, diesel price, feeding allowance,
 * product price — and five follow from them. The five are computed here,
 * wherever they are read, and never written to a column.
 *
 * ── Why nothing is stored ──────────────────────────────────────────────────
 *
 * A stored total goes stale the moment somebody corrects a price, and this
 * row already carries `rate`, which the margin is measured against. So a
 * cached margin would drift every time a rate was edited — silently, and in
 * whichever direction happened to flatter. Recomputing costs nothing and
 * cannot disagree with its inputs.
 *
 * ── Why null is not zero ───────────────────────────────────────────────────
 *
 * A trip nobody has costed has an UNKNOWN margin, not a perfect one. If the
 * inputs a figure depends on are missing, that figure is null and the screen
 * shows a dash. The alternative — treating blank as zero — reports a 100%
 * margin on every truck nobody has got round to, which is the most flattering
 * possible lie and the easiest to believe.
 */

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Rounded to kobo — these are naira figures, not float artefacts. */
const kobo = (n) => (n === null ? null : Math.round(n * 100) / 100);

const tripCosts = (row = {}) => {
  const agoLitres = num(row.agoLitres ?? row.ago_litres);
  const agoPrice = num(row.agoPrice ?? row.ago_price);
  const feeding = num(row.feedingAllowance ?? row.feeding_allowance);
  const productPrice = num(row.productPrice ?? row.product_price);
  const rate = num(row.rate);
  const quantity = num(row.quantityAllocated ?? row.quantity_allocated);

  /** Diesel is only a value once both halves are known. */
  const agoValue = agoLitres !== null && agoPrice !== null ? agoLitres * agoPrice : null;

  /**
   * Total expenses tolerates one half being absent.
   *
   * A trip with feeding and no diesel is unusual but real, and refusing to
   * total it would hide a cost that was genuinely incurred. Both absent is
   * still null — that is "not costed", not "cost nothing".
   */
  const totalExpenses =
    agoValue === null && feeding === null ? null : (agoValue ?? 0) + (feeding ?? 0);

  /**
   * Cost per litre needs a denominator. A truck allocated nothing yet cannot
   * have a per-litre cost, and dividing by zero would print Infinity onto a
   * report.
   */
  const costPerLitre =
    totalExpenses !== null && quantity !== null && quantity > 0
      ? totalExpenses / quantity
      : null;

  /** Landing cost is what the litre cost us all in: carriage plus product. */
  const landingCost =
    costPerLitre === null && productPrice === null
      ? null
      : (costPerLitre ?? 0) + (productPrice ?? 0);

  /**
   * Margin is only meaningful against a full landing cost.
   *
   * Specifically: a landing cost missing its product price would show the
   * whole selling rate as margin, which is the number most likely to be
   * quoted and most likely to be wrong. So both sides are required.
   */
  const margin =
    rate !== null && landingCost !== null && productPrice !== null && costPerLitre !== null
      ? rate - landingCost
      : null;

  return {
    agoLitres,
    agoPrice,
    agoValue: kobo(agoValue),
    feedingAllowance: feeding,
    totalExpenses: kobo(totalExpenses),
    costPerLitre: kobo(costPerLitre),
    productPrice,
    landingCost: kobo(landingCost),
    rate,
    margin: kobo(margin),
    /** Total margin on the load, not per litre — what the trip actually made. */
    marginValue: margin !== null && quantity !== null ? kobo(margin * quantity) : null,
    /** True once anything has been entered, so "uncosted" is distinguishable. */
    costed: [agoLitres, agoPrice, feeding, productPrice].some((v) => v !== null),
    /** What is still needed before a margin can be shown. */
    missing: [
      costPerLitre === null ? "trip expenses" : null,
      productPrice === null ? "product price" : null,
      rate === null ? "selling rate" : null,
    ].filter(Boolean),
  };
};

module.exports = { tripCosts };
