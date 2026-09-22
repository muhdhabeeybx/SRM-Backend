/**
 * Every PFI money figure, in one place.
 *
 * Nothing here is stored. Change an input and every downstream figure moves —
 * that is deliberate, and it is why a PFI can never drift out of step with its
 * own expense lines.
 *
 * The null discipline matters as much as the arithmetic. An uncosted PFI must
 * read "—" everywhere, not ₦0: a batch nobody has priced yet is not a batch
 * worth nothing. Only `totalExpenses` is always a number, because zero expense
 * lines legitimately means ₦0.
 */

/** Two-decimal rounding that does not drift on .005 the way toFixed can. */
const money = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A quantity or price of zero means "not entered". The columns default to 0
 * rather than null, so there is no way to tell an unset price from a free
 * cargo — and treating 0 as free would silently report a 100% margin.
 */
const positive = (v) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

/**
 * Order lifecycle states that imply a committed sale.
 *
 * No longer what drives revenue or sold litres — both now key off
 * payment_status = 'Paid', so a batch agrees with the finance report by
 * construction. Kept because it still names the set for anything reasoning
 * about order lifecycle rather than payment.
 */
const REVENUE_STATUSES = ["Paid", "Released", "Loading", "Completed"];

/**
 * @param pfi      the PFI row
 * @param agg      { expenses, revenue, movementQty, allocationQty } — all
 *                 pre-summed in SQL so this function stays pure arithmetic.
 */
/** Types with no shipping papers: one quantity, bought and billed as it stands. */
const BILLED_ON_OWN_QUANTITY = new Set(["gantry", "delivery", "trucking"]);

function computeFinancials(pfi, agg = {}) {
  // A gantry batch is an allocation bought at the loading gantry, and a
  // delivery batch is one loaded onto trucks: one quantity each, no shipping
  // papers, no discharge. Every figure below that reads a BL is therefore
  // coastal-only, and forcing either of them through the BL path would leave
  // it permanently uncosted — a batch with a real price and a real quantity
  // reporting "—" for its own value.
  //
  // `isGantry` is kept in the output under its old name because four screens
  // read it, but what it has always meant is "billed on its own quantity
  // rather than on a document", which is true of a delivery batch too.
  //
  // Trucking is the same: a batch of trucks loaded at a depot, billed on what
  // it loaded at the price it was bought at. Leaving it on the BL path left
  // every trucking PFI reading "—" for its own cost.
  const isGantry = BILLED_ON_OWN_QUANTITY.has(pfi.pfiType);

  const blQty = isGantry ? null : positive(pfi.blQtyLitres);
  const tankQty = num(pfi.startingQtyLitres) ?? 0;
  /**
   * Product found when the PFI was run down (migration 0053). It is stock, so
   * remaining and sell-through count it. It is not what landed, so nothing
   * that COSTS the cargo does — surplus/deficit against the BL, the landing
   * costs and the gantry billing quantity all stay on tankQty alone.
   */
  const evacuationSurplus = num(pfi.evacuationSurplusLitres) ?? 0;
  const stockQty = tankQty + evacuationSurplus;
  const pricePerLitre = positive(pfi.unitPrice);

  // Tank minus BL. Null — not zero — until BL is entered, because "no gap"
  // and "we don't know the gap" are different answers. Always null on gantry:
  // there is no second figure to differ from, so there is no gap to report.
  const surplusDeficitLitres = blQty == null ? null : tankQty - blQty;

  // What the batch is billed on. Coastal is billed for the documented BL
  // figure whatever actually made it into the tank; gantry and delivery are
  // billed for the quantity bought or loaded, which is the only quantity
  // either of them has.
  const costQty = isGantry ? positive(tankQty) : blQty;

  const pfiValue = costQty != null && pricePerLitre != null ? money(costQty * pricePerLitre) : null;

  // PAID only. Anything still walking the approval chain is reported beside
  // the cost, never inside it — see pendingExpenses below.
  const totalExpenses = money(num(agg.expenses) ?? 0);
  const pendingExpenses = money(num(agg.pendingExpenses) ?? 0);
  const totalCost = pfiValue == null ? null : money(pfiValue + totalExpenses);

  // A rebate, discount or claim credited back against the cargo — money that
  // reduces what the batch actually cost, without touching pfiValue (what you
  // were billed) or totalCost (what you were billed plus what you spent).
  const creditBalance = money(num(pfi.creditBalance) ?? 0) ?? 0;
  const grandTotalCost = totalCost == null ? null : money(totalCost - creditBalance);

  const revenue = money(num(agg.revenue) ?? 0);
  // Profit is read against the grand total, not the gross total — a credit
  // that lowers what the cargo really cost has to lower the loss it can show.
  const profitLoss = grandTotalCost == null ? null : money(revenue - grandTotalCost);

  // Sold is driven by confirmed-paid orders, resolved per order to the most
  // accurate quantity available (see aggregatesFor's `sold` query). It is
  // deliberately NOT movementQty + allocationQty: neither ledger is
  // guaranteed to hold a row — an order moved onto a batch by the bulk
  // assign action writes to neither — and summing only the ledgers reported
  // batches with millions of litres of confirmed sales as completely
  // untouched. movementQty/allocationQty stay exposed below for reference,
  // but nothing is computed from them.
  const movementQty = num(agg.movementQty) ?? 0;
  const allocationQty = num(agg.allocationQty) ?? 0;
  const sold = num(agg.soldQty) ?? 0;
  const remaining = stockQty - sold;

  /**
   * Stock on orders that exist but have not cleared payment.
   *
   * `sold` counts confirmed payment only, so an order placed — even loaded out
   * — against this batch reads as unsold stock until the money lands. That is
   * the right rule for revenue and the wrong story for a stock figure, and
   * with nothing naming the difference a batch could show hundreds of
   * thousands of litres "remaining" that are in fact spoken for.
   *
   * So the tank now reconciles in three parts rather than two:
   *   sold  +  awaiting payment  +  genuinely unsold  =  tank quantity
   *                                                        (+ evacuation surplus)
   */
  const awaitingPayment = num(agg.unpaidQty) ?? 0;
  const awaitingPaymentOrders = agg.unpaidOrderCount || 0;
  /** What is left once everything already spoken for is taken off. */
  const trulyUnsold = money(remaining - awaitingPayment);

  // The deficit priced at what you paid for it. The system charges you for the
  // BL quantity but you can only ever sell the tank quantity, so a deficit is
  // money spent on product that never arrived. It is already inside the loss
  // via pfiValue; this names it so it can be read rather than inferred.
  const deficitCost =
    surplusDeficitLitres != null && surplusDeficitLitres < 0 && pricePerLitre != null
      ? money(Math.abs(surplusDeficitLitres) * pricePerLitre)
      : null;

  // Share of the batch actually sold. This is what tells you whether the
  // profit figure means anything yet.
  const sellThrough = stockQty > 0 ? Math.min(1, Math.max(0, sold / stockQty)) : null;

  // Profit is only meaningful on a fully-sold batch. Below that the full cargo
  // cost is charged against partial revenue, so a healthy batch mid-flight
  // still shows a large paper loss.
  const profitIsMeaningful = sellThrough != null && sellThrough >= 0.995;

  // What the sold portion actually cost, so an in-flight batch can be read
  // honestly. Deliberately NOT called profit — it is a recovery indicator.
  const costOfSold =
    grandTotalCost != null && sellThrough != null ? money(grandTotalCost * sellThrough) : null;
  const marginOnSold =
    costOfSold != null && revenue > 0 ? money(((revenue - costOfSold) / revenue) * 100) : null;

  /**
   * Landing cost per litre — TOTAL COST ÷ BL QUANTITY, always.
   *
   * "Total cost" here means `grandTotalCost`: cargo value, plus paid expenses,
   * LESS any credit note. That is the figure every screen now prints under the
   * label "Total cost", and the two have to be the same number or the division
   * cannot be checked by eye — which was the original complaint. A rebate
   * genuinely lowers what the cargo cost, so it belongs inside the per-unit
   * cost as well as inside the profit.
   *
   * Nothing here is stored, so this moves the instant any input moves — add an
   * expense, correct the unit price, enter a credit note, fix the BL figure,
   * and the landing cost is already right the next time it is read.
   *
   * `costQty` is the BL figure on coastal — the quantity the papers say was
   * purchased and the one the business quotes. On gantry there are no shipping
   * papers at all, so it is the quantity bought; forcing a gantry batch down
   * the BL path would leave it permanently uncosted.
   */
  const landingCostPerLitre =
    grandTotalCost != null && costQty > 0 ? money(grandTotalCost / costQty) : null;

  // The same cost spread over what actually measured into the tank. Kept
  // alongside rather than instead of: a discharge shortage pushes this above
  // the BL figure, because the same total bought less product than the papers
  // promised, and the gap between the two IS the cost of the deficit. Divides
  // the same grand total, so the two landing costs differ only by their basis.
  const landingCostPerLitreTank =
    grandTotalCost != null && tankQty > 0 ? money(grandTotalCost / tankQty) : null;

  return {
    isGantry,
    blQtyLitres: blQty,
    blQtyMt: isGantry ? null : num(pfi.blQtyMt),
    tankQtyLitres: tankQty,
    evacuationSurplusLitres: evacuationSurplus,
    /** Landed plus surplus: everything this PFI has had to sell. */
    stockQtyLitres: stockQty,
    // The quantity every money figure above was computed against, so a reader
    // never has to work out which of the two it was.
    costQtyLitres: costQty,
    surplusDeficitLitres,
    pricePerLitre,
    pfiValue,
    totalExpenses,
    pendingExpenses,
    pendingExpenseCount: agg.pendingExpenseCount || 0,
    totalCost,
    creditBalance,
    grandTotalCost,
    landingCostPerLitre,
    landingCostPerLitreTank,
    revenue,
    profitLoss,
    margin: revenue > 0 && profitLoss != null ? money((profitLoss / revenue) * 100) : null,
    sold,
    remaining,
    awaitingPayment,
    awaitingPaymentOrders,
    trulyUnsold,
    movementQty,
    allocationQty,
    // Read-it-right helpers.
    deficitCost,
    sellThrough,
    profitIsMeaningful,
    costOfSold,
    marginOnSold,
  };
}

// ─── Saying how each figure was reached ─────────────────────────────────────

const NGN = (n) =>
  n == null
    ? "—"
    : `₦${Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const QTY = (n, unit = "Litres") =>
  n == null ? "—" : `${Number(n).toLocaleString("en-NG")} ${unit}`;

const PCT = (n) => (n == null ? "—" : `${Number(n).toFixed(2)}%`);

/**
 * Every figure, with its formula and that formula filled in with this batch's
 * own numbers.
 *
 * Deliberately in THIS file rather than in the report that prints it. A
 * formula written next to the report is a second description of the
 * arithmetic, free to drift from the arithmetic itself the first time either
 * changes — and a report that confidently explains the wrong sum is worse than
 * one that explains nothing. Written here, the sum and the sentence describing
 * it are edited together or not at all.
 *
 * `workings` is the part that does the work for the reader: not "Total Cost ÷
 * BL Quantity" in the abstract, but "₦4,182,000,000.00 ÷ 14,832,200 Litres =
 * ₦281.95", so the number on the page can be checked without a calculator or a
 * conversation.
 *
 * @param pfi the PFI row
 * @param f   the output of computeFinancials for that row
 * @returns {Array<{key: string, label: string, value: string, formula: string, workings: string, meaning: string}>}
 */
function explainFinancials(pfi, f) {
  const unit = pfi.productUnit || "Litres";
  const one = unit.replace(/s$/i, "");
  const gantry = f.isGantry;
  const billedLabel = gantry ? "Quantity Bought" : "BL Quantity";

  return [
    {
      key: "billedQty",
      label: billedLabel,
      value: QTY(f.costQtyLitres, unit),
      formula: gantry
        ? "The quantity bought at the gantry."
        : "The quantity on the shipping documents (Bill of Lading).",
      workings: gantry
        ? "Entered on the batch."
        : "Taken from the BL, not from the tank reading.",
      meaning: gantry
        ? "A gantry allocation has one quantity, there are no shipping papers and no discharge, so this is both what you paid for and what you received."
        : "This is what the supplier charges you for, regardless of whatever actually made it into the tank. Every cost figure below is worked out against it.",
    },
    {
      key: "tankQty",
      label: `Tank Quantity (${unit})`,
      value: QTY(f.tankQtyLitres, unit),
      formula: "The measured quantity that actually landed in the tank.",
      workings: "Entered from the tank reading after discharge.",
      meaning:
        "This is what you can actually sell. Stock balance runs off this figure and not off the BL.",
    },
    ...(gantry || f.surplusDeficitLitres == null
      ? []
      : [
          {
            key: "surplusDeficit",
            label: "Surplus / Deficit",
            value: QTY(f.surplusDeficitLitres, unit),
            formula: `Tank Quantity − ${billedLabel}`,
            workings: `${QTY(f.tankQtyLitres, unit)} − ${QTY(f.costQtyLitres, unit)} = ${QTY(f.surplusDeficitLitres, unit)}`,
            meaning:
              f.surplusDeficitLitres < 0
                ? "Negative means less arrived than you were billed for. You paid for product that never landed."
                : f.surplusDeficitLitres > 0
                  ? "Positive means more landed than the papers said. The extra is yours to sell."
                  : "The tank reading matched the shipping documents exactly.",
          },
        ]),
    {
      key: "pfiValue",
      label: gantry ? "PFI Value" : "PFI (Cargo) Value",
      value: NGN(f.pfiValue),
      formula: `${billedLabel} × Unit Price`,
      workings: `${QTY(f.costQtyLitres, unit)} × ${NGN(f.pricePerLitre)} = ${NGN(f.pfiValue)}`,
      meaning: "What the product itself cost, before any expenses are added.",
    },
    {
      key: "totalExpenses",
      label: "Total Expenses",
      value: NGN(f.totalExpenses),
      formula: "Sum of every PAID expense booked to this batch.",
      workings: `Paid expense lines on this batch = ${NGN(f.totalExpenses)}`,
      meaning:
        "Paid only. Anything still walking the approval chain is shown separately as Pending Expenses and is not inside any cost figure yet.",
    },
    ...(f.pendingExpenses > 0
      ? [
          {
            key: "pendingExpenses",
            label: "Pending Expenses",
            value: NGN(f.pendingExpenses),
            formula: "Sum of expenses raised against this batch but not yet paid.",
            workings: `${f.pendingExpenseCount} line(s) awaiting payment = ${NGN(f.pendingExpenses)}`,
            meaning:
              "Not included in Total Cost. If these are all approved and paid, Total Cost rises by this amount and the landing cost rises with it.",
          },
        ]
      : []),
    ...(f.creditBalance > 0
      ? [
          {
            key: "grossCost",
            label: "Cost Before Credit",
            value: NGN(f.totalCost),
            formula: "PFI Value + Total Expenses",
            workings: `${NGN(f.pfiValue)} + ${NGN(f.totalExpenses)} = ${NGN(f.totalCost)}`,
            meaning: "What you were billed and spent, before the credit note below is taken off.",
          },
          {
            key: "creditBalance",
            label: "Credit Note",
            value: NGN(f.creditBalance),
            formula: "A rebate, discount or claim credited back against this cargo.",
            workings: "Entered on the batch.",
            meaning:
              "Money returned to you. It lowers what the cargo really cost without changing what you were billed.",
          },
        ]
      : []),
    {
      key: "totalCost",
      label: "Total Cost",
      value: NGN(f.grandTotalCost),
      formula:
        f.creditBalance > 0
          ? "PFI Value + Total Expenses − Credit Note"
          : "PFI Value + Total Expenses",
      workings:
        f.creditBalance > 0
          ? `${NGN(f.pfiValue)} + ${NGN(f.totalExpenses)} − ${NGN(f.creditBalance)} = ${NGN(f.grandTotalCost)}`
          : `${NGN(f.pfiValue)} + ${NGN(f.totalExpenses)} = ${NGN(f.grandTotalCost)}`,
      meaning:
        "What this batch has actually cost — the product, plus every paid expense against it, less any credit note. This is the figure profit is measured against and the one the landing cost divides.",
    },
    {
      key: "landingCostPerLitre",
      label: `Landing Cost per ${one}`,
      value: NGN(f.landingCostPerLitre),
      formula: `Total Cost ÷ ${billedLabel}`,
      workings: `${NGN(f.grandTotalCost)} ÷ ${QTY(f.costQtyLitres, unit)} = ${NGN(f.landingCostPerLitre)}`,
      meaning: `What one ${one.toLowerCase()} of this batch cost you, all in. Sell below this and the batch loses money. It divides the Total Cost printed directly above, so the two can be checked against each other by eye — and it recalculates automatically, so adding an expense or entering a credit note moves it straight away.`,
    },
    ...(gantry || f.landingCostPerLitreTank == null || f.landingCostPerLitre == null
      ? []
      : [
          {
            key: "landingCostPerLitreTank",
            label: `Landing Cost per ${one} (against tank)`,
            value: NGN(f.landingCostPerLitreTank),
            formula: "Total Cost ÷ Tank Quantity",
            workings: `${NGN(f.grandTotalCost)} ÷ ${QTY(f.tankQtyLitres, unit)} = ${NGN(f.landingCostPerLitreTank)}`,
            meaning:
              "The same cost spread over what actually landed rather than what you were billed for. When product goes missing on discharge this is higher than the headline figure, and the gap between the two is exactly what the shortage cost you.",
          },
        ]),
    {
      key: "revenue",
      label: gantry ? "Sales Value" : "Revenue",
      value: NGN(f.revenue),
      formula: "Sum of every CONFIRMED-PAID order against this batch.",
      workings: `Paid orders on this batch = ${NGN(f.revenue)}`,
      meaning:
        "Money actually confirmed received. An order that is placed but unpaid is not counted here.",
    },
    {
      key: "sold",
      label: `Total Sold (${unit})`,
      value: QTY(f.sold, unit),
      formula: "Quantity across every confirmed-paid order.",
      workings: `${QTY(f.sold, unit)} of ${QTY(f.tankQtyLitres, unit)}`,
      meaning:
        "Driven by payment, not by loading — so it agrees with the finance report by construction.",
    },
    {
      key: "remaining",
      label: `Balance (${unit})`,
      value: QTY(f.remaining, unit),
      // The surplus is named only when there is one, so a batch without it
      // reads exactly as it always has.
      formula: f.evacuationSurplusLitres > 0
        ? "Tank Quantity + Evacuation Surplus − Total Sold"
        : "Tank Quantity − Total Sold",
      workings: f.evacuationSurplusLitres > 0
        ? `${QTY(f.tankQtyLitres, unit)} + ${QTY(f.evacuationSurplusLitres, unit)} − ${QTY(f.sold, unit)} = ${QTY(f.remaining, unit)}`
        : `${QTY(f.tankQtyLitres, unit)} − ${QTY(f.sold, unit)} = ${QTY(f.remaining, unit)}`,
      meaning:
        f.remaining < 0
          ? `OVERSOLD. Paid orders on this batch come to ${QTY(f.sold, unit)} against ${f.evacuationSurplusLitres > 0 ? "a tank plus surplus" : "a tank"} of ${QTY(f.stockQtyLitres, unit)} — ${QTY(Math.abs(f.remaining), unit)} more than it ever held. Either the stock was drawn from another batch at the same depot, or orders belonging elsewhere were booked here. This is not leftover stock.`
          : f.awaitingPayment > 0
            ? `NOT all of this is available. ${QTY(f.awaitingPayment, unit)} of it sits on ${f.awaitingPaymentOrders} order(s) that have not cleared payment — placed, possibly already loaded, but not counted as sold until the money lands. Genuinely unsold: ${QTY(f.trulyUnsold, unit)}.`
            : "What is left to sell. Every order on this batch has cleared payment, so none of this is already spoken for.",
    },
    ...(f.awaitingPayment > 0
      ? [
          {
            key: "awaitingPayment",
            label: `Awaiting payment (${unit})`,
            value: QTY(f.awaitingPayment, unit),
            formula: "Quantity on orders against this batch whose payment is not confirmed.",
            workings: `${f.awaitingPaymentOrders} unpaid order(s) = ${QTY(f.awaitingPayment, unit)}`,
            meaning:
              "This is the usual answer to 'the balance looks too high — where is that stock?'. It is spoken for but unpaid, so it counts as neither sold nor free. Cancelled and expired orders are not included.",
          },
          {
            key: "trulyUnsold",
            label: `Genuinely unsold (${unit})`,
            value: QTY(f.trulyUnsold, unit),
            formula: "Balance − Awaiting payment",
            workings: `${QTY(f.remaining, unit)} − ${QTY(f.awaitingPayment, unit)} = ${QTY(f.trulyUnsold, unit)}`,
            meaning:
              "Stock with no order against it at all — the figure to quote when someone asks what is actually available to sell.",
          },
        ]
      : []),
    {
      key: "sellThrough",
      label: "Percentage Sold",
      value: PCT(f.sellThrough == null ? null : f.sellThrough * 100),
      formula: "Total Sold ÷ Tank Quantity",
      workings: `${QTY(f.sold, unit)} ÷ ${QTY(f.tankQtyLitres, unit)} = ${PCT(f.sellThrough == null ? null : f.sellThrough * 100)}`,
      meaning:
        "How far through the batch you are. This is what tells you whether the profit figure below means anything yet.",
    },
    {
      key: "profitLoss",
      label: "Balance (Profit / Loss)",
      value: NGN(f.profitLoss),
      formula: f.creditBalance > 0 ? "Revenue − Grand Total Cost" : "Revenue − Total Cost",
      workings: `${NGN(f.revenue)} − ${NGN(f.grandTotalCost)} = ${NGN(f.profitLoss)}`,
      meaning: f.profitIsMeaningful
        ? "This batch is essentially fully sold, so this figure is the real result."
        : `READ WITH CARE. Only ${PCT(f.sellThrough == null ? null : f.sellThrough * 100)} of this batch is sold, but the WHOLE cargo cost is charged against that partial revenue — so a perfectly healthy batch shows a large paper loss mid-flight. Use Margin on Sold instead until the batch is finished.`,
    },
    ...(f.costOfSold == null
      ? []
      : [
          {
            key: "costOfSold",
            label: "Cost of the Portion Sold",
            value: NGN(f.costOfSold),
            formula: "Grand Total Cost × Percentage Sold",
            workings: `${NGN(f.grandTotalCost)} × ${PCT(f.sellThrough == null ? null : f.sellThrough * 100)} = ${NGN(f.costOfSold)}`,
            meaning:
              "What the part you have actually sold cost you. This is the honest comparison against revenue on a batch still in flight.",
          },
          {
            key: "marginOnSold",
            label: "Margin on Sold",
            value: PCT(f.marginOnSold),
            formula: "(Revenue − Cost of the Portion Sold) ÷ Revenue",
            workings: `(${NGN(f.revenue)} − ${NGN(f.costOfSold)}) ÷ ${NGN(f.revenue)} = ${PCT(f.marginOnSold)}`,
            meaning:
              "The margin you are actually making as you sell. Unlike the profit figure above, this is meaningful at any point in the batch.",
          },
        ]),
    ...(f.deficitCost == null
      ? []
      : [
          {
            key: "deficitCost",
            label: "Cost of the Deficit",
            value: NGN(f.deficitCost),
            formula: "Shortfall × Unit Price",
            workings: `${QTY(Math.abs(f.surplusDeficitLitres), unit)} × ${NGN(f.pricePerLitre)} = ${NGN(f.deficitCost)}`,
            meaning:
              "Money spent on product that never arrived. It is already inside the loss above — this names it so it can be read rather than worked out.",
          },
        ]),
  ];
}

module.exports = { computeFinancials, explainFinancials, REVENUE_STATUSES, money, BILLED_ON_OWN_QUANTITY };
