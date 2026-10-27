/**
 * What a truck's trip cost, and what it earned.
 *
 * Four figures are entered — diesel litres, diesel price, feeding allowance,
 * product price — and five follow from them. The five are computed here,
 * wherever they are read, and never written to a column. Feeding marked as
 * paid through Expenses (0091) is kept on the row but not added. Loading
 * money (0099) is a fifth, counted the way feeding is.
 *
 * A third-party truck's trip (0094) has a fifth, the haulage its owner
 * charges. Its carriage is the haulage, the AGO is sold to the owner at the
 * AGO price, and the owner is paid haulage − AGO (`haulageBalance`).
 *
 * Owners quote a rate per litre (0098): the haulage is that rate × the litres
 * loaded. A lump sum typed before rates existed still counts where no rate is.
 *
 * The owner is paid through Expenses — an advance, then the balance (0098,
 * services/ownerPayments.service.js). What is already PAID to the owner is in
 * the PFI's paid expenses, so the trip adds its haulage less that: counted
 * once, before, during and after the owner is paid.
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
  const feedingInExpenses = Boolean(row.feedingInExpenses ?? row.feeding_in_expenses);
  /**
   * The feeding this trip adds — none when it was paid through Expenses.
   *
   * Drivers' feeding is often paid as an expense on the PFI, which is already
   * in the PFI's cost. Adding the truck's figure as well counted the same naira
   * twice and pushed the landing cost up. The figure stays on the truck so the
   * record is whole; it is just not added again. Known-and-zero, not null: the
   * feeding is accounted for, only somewhere else.
   */
  /**
   * Feeding on a payment request raised from Delivery Costing (0095) counts on
   * the truck until that request is paid; from then the PFI's paid expenses
   * carry it. Either way it is counted once.
   */
  const feedingPaidByRequest = (row.feedingRequest?.status ?? null) === "paid";
  const feedingAdded = feeding === null ? null : feedingInExpenses || feedingPaidByRequest ? 0 : feeding;
  /** Loading money (0099), on every truck, hired ones too: counted once, as feeding is. */
  const loading = num(row.loadingCost ?? row.loading_cost);
  const loadingInExpenses = Boolean(row.loadingCostInExpenses ?? row.loading_cost_in_expenses);
  const loadingPaidByRequest = (row.loadingRequest?.status ?? null) === "paid";
  const loadingAdded = loading === null ? null : loadingInExpenses || loadingPaidByRequest ? 0 : loading;
  const productPrice = num(row.productPrice ?? row.product_price);
  const rate = num(row.rate);
  const quantity = num(row.quantityAllocated ?? row.quantity_allocated);
  const haulageRate = num(row.haulageRate ?? row.haulage_rate);
  /** Rate × litres loaded; a lump sum only where no rate was entered. */
  const haulage = haulageRate !== null
    ? (quantity !== null ? Math.round(haulageRate * quantity * 100) / 100 : null)
    : num(row.haulageAmount ?? row.haulage_amount);
  /**
   * A hired truck's trip (0094): the truck is a third party's, or haulage was
   * entered on it. Its owner charges haulage and buys the AGO from us out of
   * it, so the AGO is a sale to the owner, not diesel we burnt.
   */
  const thirdParty = Boolean(row.truckThirdParty) || haulage !== null;
  /** Its part of the payment requests raised to its owner (repositories/tripOwnerPayment). */
  const owner = row.ownerPayments ?? null;
  const ownerPaid = owner ? Number(owner.paid) || 0 : 0;
  const ownerRequested = owner ? Number(owner.requested) || 0 : 0;

  /** Diesel is only a value once both halves are known. */
  const agoValue = agoLitres !== null && agoPrice !== null ? agoLitres * agoPrice : null;

  /**
   * What the owner is paid: haulage less the AGO they bought. Unknown while
   * the haulage is, or while AGO was given at no price yet — paying the whole
   * haulage then would overpay by exactly the AGO.
   */
  const haulageBalance =
    !thirdParty || haulage === null ? null
      : agoLitres === null || agoLitres === 0 ? haulage
        : agoValue === null ? null : haulage - agoValue;

  /**
   * Total expenses tolerates one half being absent.
   *
   * A trip with feeding and no diesel is unusual but real, and refusing to
   * total it would hide a cost that was genuinely incurred. Both absent is
   * still null — that is "not costed", not "cost nothing".
   *
   * On a hired trip the carriage is the haulage, all of it: the AGO the owner
   * bought back is paid for out of it, so it is neither added nor taken off.
   */
  /**
   * What the owner has been paid already is in the PFI's paid expenses, and
   * comes off here, so the haulage is counted once whichever side holds it.
   */
  const carriage = thirdParty ? (haulage === null ? null : haulage - ownerPaid) : agoValue;
  const totalExpenses =
    carriage === null && feedingAdded === null && loadingAdded === null
      ? null
      : (carriage ?? 0) + (feedingAdded ?? 0) + (loadingAdded ?? 0);

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

  /** What the owner is still owed: what they get in all, less what has been paid. */
  const ownerOwed = haulageBalance === null ? null : haulageBalance - ownerPaid;

  return {
    agoLitres,
    agoPrice,
    agoValue: kobo(agoValue),
    thirdParty,
    haulageRate,
    haulageAmount: haulage,
    haulageBalance: kobo(haulageBalance),
    /** The haulage this trip adds: all of it less what is paid through Expenses. */
    haulageAdded: thirdParty && haulage !== null ? kobo(carriage) : null,
    ownerPaid: thirdParty ? kobo(ownerPaid) : null,
    /** Raised to the owner and not paid yet. */
    ownerRequested: thirdParty ? kobo(ownerRequested) : null,
    ownerAdvance: thirdParty ? kobo(owner ? Number(owner.advance) || 0 : 0) : null,
    ownerOwed: thirdParty ? kobo(ownerOwed) : null,
    /** Still to be raised: owed less what is already asked for. */
    ownerToRaise: thirdParty && ownerOwed !== null ? kobo(ownerOwed - ownerRequested) : null,
    /** The day the owner was last paid, once nothing is owed — when the balance was paid. */
    ownerPaidOffOn: thirdParty && ownerOwed !== null && ownerOwed <= 0.005 && ownerPaid > 0 ? owner?.lastPaidAt ?? null : null,
    ownerPayments: thirdParty ? owner?.payments ?? [] : [],
    feedingAllowance: feeding,
    feedingInExpenses,
    feedingRequest: row.feedingRequest ?? null,
    loadingCost: loading,
    loadingCostInExpenses: loadingInExpenses,
    loadingRequest: row.loadingRequest ?? null,
    totalExpenses: kobo(totalExpenses),
    costPerLitre: kobo(costPerLitre),
    productPrice,
    landingCost: kobo(landingCost),
    rate,
    margin: kobo(margin),
    /** Total margin on the load, not per litre — what the trip actually made. */
    marginValue: margin !== null && quantity !== null ? kobo(margin * quantity) : null,
    /** True once anything has been entered, so "uncosted" is distinguishable. */
    costed: [agoLitres, agoPrice, feeding, loading, productPrice, haulage, haulageRate].some((v) => v !== null),
    /** What is still needed before a margin can be shown. */
    missing: [
      costPerLitre === null ? "trip expenses" : null,
      productPrice === null ? "product price" : null,
      rate === null ? "selling rate" : null,
    ].filter(Boolean),
  };
};

module.exports = { tripCosts };
