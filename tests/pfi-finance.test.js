const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { computeFinancials, explainFinancials } = require("../lib/pfiFinance");

/**
 * Pure arithmetic — no database, no app, no token. Every figure on a PFI is
 * derived from its inputs by computeFinancials and nothing is stored, so these
 * tests are the whole contract.
 */

/** A coastal batch: BL 1,000,000 L at ₦300, tank short by 5,000 L. */
const coastal = (over = {}) => ({
  pfiType: "coastal",
  productUnit: "Litres",
  startingQtyLitres: 995_000,
  blQtyLitres: 1_000_000,
  unitPrice: "300",
  creditBalance: "0",
  ...over,
});

describe("landing cost per litre — Total Cost ÷ BL Quantity, always", () => {
  test("divides the SAME Total Cost every screen prints beside it", () => {
    const f = computeFinancials(coastal(), { expenses: 20_000_000 });

    // ₦300 × 1,000,000 = ₦300,000,000 cargo, + ₦20,000,000 expenses.
    assert.equal(f.pfiValue, 300_000_000);
    assert.equal(f.grandTotalCost, 320_000_000);
    assert.equal(f.landingCostPerLitre, 320);
    // The property that matters: the two figures on the page reconcile.
    assert.equal(f.landingCostPerLitre, f.grandTotalCost / f.costQtyLitres);
  });

  test("a credit note moves BOTH, so they still reconcile", () => {
    // "Total cost" means after the credit note everywhere it is displayed, and
    // the landing cost divides that same figure. Anything else leaves two
    // numbers on one card that cannot be checked against each other.
    const f = computeFinancials(coastal({ creditBalance: "10000000" }), { expenses: 20_000_000 });

    assert.equal(f.totalCost, 320_000_000, "the gross figure is still available");
    assert.equal(f.grandTotalCost, 310_000_000, "and this is what is shown as Total Cost");
    assert.equal(f.landingCostPerLitre, 310);
    assert.equal(f.landingCostPerLitre, f.grandTotalCost / f.costQtyLitres);
  });

  test("with no credit the gross and the displayed total are the same number", () => {
    const f = computeFinancials(coastal(), { expenses: 20_000_000 });
    assert.equal(f.totalCost, f.grandTotalCost);
  });

  test("it moves the moment any input moves — nothing is stored", () => {
    const before = computeFinancials(coastal(), { expenses: 20_000_000 });
    // One more expense lands. Total cost rises, so landing cost must rise.
    const after = computeFinancials(coastal(), { expenses: 25_000_000 });

    assert.equal(before.landingCostPerLitre, 320);
    assert.equal(after.landingCostPerLitre, 325);

    // And correcting the unit price moves it too.
    const repriced = computeFinancials(coastal({ unitPrice: "310" }), { expenses: 20_000_000 });
    assert.equal(repriced.landingCostPerLitre, 330);
  });

  test("pending expenses are OUTSIDE it until they are actually paid", () => {
    const f = computeFinancials(coastal(), { expenses: 20_000_000, pendingExpenses: 9_000_000 });
    assert.equal(f.landingCostPerLitre, 320, "an unpaid expense has not been spent");
    assert.equal(f.pendingExpenses, 9_000_000, "but it is reported so nobody is surprised later");
  });

  test("the tank figure is higher when product went missing on discharge", () => {
    const f = computeFinancials(coastal(), { expenses: 20_000_000 });
    // Billed for 1,000,000 L, only 995,000 L landed — the same money bought
    // less product, so the per-litre cost of what you can actually sell is up.
    assert.equal(f.surplusDeficitLitres, -5_000);
    assert.ok(f.landingCostPerLitreTank > f.landingCostPerLitre);
    assert.equal(f.landingCostPerLitreTank, 321.61);
    assert.equal(f.deficitCost, 1_500_000, "5,000 L at ₦300 that never arrived");
  });

  test("a gantry batch is costed on the quantity bought, not a BL it never had", () => {
    const f = computeFinancials(
      { pfiType: "gantry", productUnit: "Litres", startingQtyLitres: 500_000, unitPrice: "300", creditBalance: "0" },
      { expenses: 10_000_000 }
    );
    assert.equal(f.isGantry, true);
    assert.equal(f.blQtyLitres, null, "there are no shipping papers");
    assert.equal(f.costQtyLitres, 500_000);
    assert.equal(f.landingCostPerLitre, 320);
    assert.equal(f.surplusDeficitLitres, null, "no second figure to differ from");
  });

  test("an uncosted batch reads null, never ₦0", () => {
    // A batch nobody has priced yet is not a batch worth nothing, and a false
    // ₦0 landing cost would say it costs nothing to sell.
    const f = computeFinancials(coastal({ unitPrice: "0" }), { expenses: 20_000_000 });
    assert.equal(f.pfiValue, null);
    assert.equal(f.totalCost, null);
    assert.equal(f.landingCostPerLitre, null);

    const noBl = computeFinancials(coastal({ blQtyLitres: null }), { expenses: 20_000_000 });
    assert.equal(noBl.landingCostPerLitre, null, "no BL means no basis to divide by");
  });
});

describe("where the 'unsold' stock actually is", () => {
  test("the tank reconciles into sold + awaiting payment + truly unsold", () => {
    // The shape behind "there's 700k litres unsold and I don't know how":
    // the stock is spoken for, but the orders holding it have not paid, and
    // `sold` counts confirmed payment only.
    const f = computeFinancials(coastal({ startingQtyLitres: 5_000_000, blQtyLitres: 5_000_000 }), {
      expenses: 10_000_000,
      soldQty: 4_300_000,
      unpaidQty: 700_000,
      unpaidOrderCount: 3,
    });

    assert.equal(f.sold, 4_300_000);
    assert.equal(f.remaining, 700_000, "the balance that looks like free stock");
    assert.equal(f.awaitingPayment, 700_000, "but all of it is on unpaid orders");
    assert.equal(f.trulyUnsold, 0, "so nothing is actually available");

    // The three parts must add back up to the tank, or the story is wrong.
    assert.equal(f.sold + f.awaitingPayment + f.trulyUnsold, f.tankQtyLitres);
  });

  test("a batch with no unpaid orders reports its balance as genuinely free", () => {
    const f = computeFinancials(coastal({ startingQtyLitres: 1_000_000, blQtyLitres: 1_000_000 }), {
      expenses: 0,
      soldQty: 600_000,
    });
    assert.equal(f.awaitingPayment, 0);
    assert.equal(f.trulyUnsold, 400_000, "all of the balance is available");
  });

  test("the balance line says where the stock went, in words", () => {
    const pfi = coastal({ startingQtyLitres: 5_000_000, blQtyLitres: 5_000_000 });
    const f = computeFinancials(pfi, { expenses: 0, soldQty: 4_300_000, unpaidQty: 700_000, unpaidOrderCount: 3 });
    const balance = explainFinancials(pfi, f).find((e) => e.key === "remaining");

    assert.match(balance.meaning, /NOT all of this is available/);
    assert.match(balance.meaning, /700,000 Litres/);
    assert.match(balance.meaning, /3 order\(s\)/);
  });

  test("over-selling shows as a negative balance rather than being hidden", () => {
    // More paid than the tank held — a real signal, not something to clamp to
    // zero and leave someone to discover from a stock count.
    const f = computeFinancials(coastal({ startingQtyLitres: 1_000_000, blQtyLitres: 1_000_000 }), {
      expenses: 0,
      soldQty: 1_100_000,
    });
    assert.equal(f.remaining, -100_000);
    assert.equal(f.sellThrough, 1, "sell-through is still capped at 100% for the bar");
  });

  test("an oversold batch is NAMED as oversold, not left as a bare negative", () => {
    // This is PFI 25B on the live book: 23,931,000 L of paid orders against a
    // 23,176,609 L tank. Read as "-754,391 L left" it looks like leftover
    // stock — the exact opposite of what it means — which is how it came to
    // be reported as "700k litres unsold".
    const pfi = coastal({ startingQtyLitres: 23_176_609, blQtyLitres: 23_271_455 });
    const f = computeFinancials(pfi, { expenses: 0, soldQty: 23_931_000 });
    const balance = explainFinancials(pfi, f).find((e) => e.key === "remaining");

    assert.equal(f.remaining, -754_391);
    assert.match(balance.meaning, /^OVERSOLD/);
    assert.match(balance.meaning, /754,391 Litres more than it ever held/);
    assert.match(balance.meaning, /not leftover stock/);
  });
});

describe("explaining the figures", () => {
  test("the workings show the actual sum, not the formula in the abstract", () => {
    const pfi = coastal();
    const f = computeFinancials(pfi, { expenses: 20_000_000 });
    const explain = explainFinancials(pfi, f);

    const landing = explain.find((e) => e.key === "landingCostPerLitre");
    assert.ok(landing);
    assert.equal(landing.formula, "Total Cost ÷ BL Quantity");
    // The number on the page, checkable by eye without a calculator.
    assert.match(landing.workings, /₦320,000,000\.00 ÷ 1,000,000 Litres = ₦320\.00/);
  });

  test("the explanation agrees with the arithmetic it describes", () => {
    // The whole reason these live in the same file: a formula that drifted
    // from the sum would be worse than no formula at all.
    const pfi = coastal({ creditBalance: "10000000" });
    const f = computeFinancials(pfi, { expenses: 20_000_000 });
    const explain = explainFinancials(pfi, f);

    const byKey = Object.fromEntries(explain.map((e) => [e.key, e]));
    // On a batch with a credit note the gross figure is shown first, named for
    // what it is, and "Total Cost" is the after-credit number the landing cost
    // divides — so the two can be checked against each other on the page.
    assert.equal(byKey.grossCost.value, "₦320,000,000.00");
    assert.equal(byKey.creditBalance.value, "₦10,000,000.00");
    assert.equal(byKey.totalCost.value, "₦310,000,000.00");
    assert.equal(byKey.landingCostPerLitre.value, "₦310.00");

    // The workings must show that same division, not a different one.
    assert.match(byKey.landingCostPerLitre.workings, /₦310,000,000\.00 ÷ 1,000,000 Litres = ₦310\.00/);
  });

  test("with no credit note there is no gross line to confuse anyone", () => {
    const pfi = coastal();
    const f = computeFinancials(pfi, { expenses: 20_000_000 });
    const keys = explainFinancials(pfi, f).map((e) => e.key);

    assert.ok(!keys.includes("grossCost"), "nothing was reduced, so nothing to show before it");
    assert.ok(!keys.includes("creditBalance"));
    assert.ok(keys.includes("totalCost"));
  });

  test("a part-sold batch is told, in words, not to trust its profit figure", () => {
    const pfi = coastal();
    // A third sold: the full cargo cost charged against a third of the revenue
    // makes a healthy batch look catastrophic.
    const f = computeFinancials(pfi, { expenses: 20_000_000, revenue: 110_000_000, soldQty: 331_667 });
    const explain = explainFinancials(pfi, f);

    assert.equal(f.profitIsMeaningful, false);
    const profit = explain.find((e) => e.key === "profitLoss");
    assert.match(profit.meaning, /^READ WITH CARE/);
    assert.match(profit.meaning, /Margin on Sold/);

    // And the honest alternative is offered right beneath it.
    assert.ok(explain.find((e) => e.key === "marginOnSold"));
  });

  test("a finished batch is not hedged — the profit figure is the real one", () => {
    const pfi = coastal();
    const f = computeFinancials(pfi, { expenses: 20_000_000, revenue: 400_000_000, soldQty: 995_000 });
    const explain = explainFinancials(pfi, f);

    assert.equal(f.profitIsMeaningful, true);
    const profit = explain.find((e) => e.key === "profitLoss");
    assert.doesNotMatch(profit.meaning, /READ WITH CARE/);
  });

  test("sections that do not apply are left out rather than dashed", () => {
    const gantryPfi = {
      pfiType: "gantry", productUnit: "Litres", startingQtyLitres: 500_000,
      unitPrice: "300", creditBalance: "0",
    };
    const f = computeFinancials(gantryPfi, { expenses: 10_000_000 });
    const keys = explainFinancials(gantryPfi, f).map((e) => e.key);

    // A gantry batch has no discharge, so a surplus/deficit line would be
    // answering a question nobody asked.
    assert.ok(!keys.includes("surplusDeficit"));
    assert.ok(!keys.includes("landingCostPerLitreTank"));
    assert.ok(!keys.includes("creditBalance"), "no credit on this batch");
    assert.ok(keys.includes("landingCostPerLitre"));
  });
});

describe("a batch with no shipping papers is billed on what it holds", () => {
  /**
   * Gantry, delivery and trucking are all bought on land — at a loading
   * gantry, or onto trucks at a depot — so none of them has a BL figure to be
   * costed against. Trucking was left on the coastal path when it was added,
   * which left every batch of trucks reporting no cost at all: a real price
   * and a real quantity, and "—" where its value should be.
   */
  for (const pfiType of ["gantry", "delivery", "trucking"]) {
    test(`${pfiType} costs against its own quantity`, () => {
      const f = computeFinancials(
        { pfiType, productUnit: "Litres", startingQtyLitres: 195_000, unitPrice: "1280", creditBalance: "0" },
        { expenses: 7_325_000 },
      );

      assert.equal(f.isGantry, true);
      // No papers, so nothing to differ from what arrived.
      assert.equal(f.blQtyLitres, null);
      assert.equal(f.surplusDeficitLitres, null);
      assert.equal(f.costQtyLitres, 195_000);
      // ₦1,280 × 195,000 = ₦249,600,000, plus the trip expenses booked to it.
      assert.equal(f.pfiValue, 249_600_000);
      assert.equal(f.grandTotalCost, 256_925_000);
      // Rounded to kobo, like every money figure here.
      assert.equal(f.landingCostPerLitre, 1317.56);
    });
  }

  test("coastal still needs its BL, and says so by reading null", () => {
    const f = computeFinancials(
      { pfiType: "coastal", productUnit: "Litres", startingQtyLitres: 195_000, unitPrice: "1280", creditBalance: "0" },
      { expenses: 0 },
    );
    assert.equal(f.isGantry, false);
    assert.equal(f.pfiValue, null);
    assert.equal(f.landingCostPerLitre, null);
  });
});
