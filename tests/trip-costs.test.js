const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { tripCosts } = require("../lib/tripCosts");

/**
 * Pure arithmetic — no database. A truck's trip figures follow from four
 * inputs, and feeding paid through Expenses (0091) is kept but not added.
 */

/** 50,000 L sold at ₦1,400; 1,150 L of AGO at ₦1,700; ₦50,000 feeding; product ₦1,300. */
const truck = (over = {}) => ({
  quantityAllocated: 50_000,
  rate: "1400",
  agoLitres: "1150",
  agoPrice: "1700",
  feedingAllowance: "50000",
  productPrice: "1300",
  feedingInExpenses: false,
  ...over,
});

describe("tripCosts", () => {
  test("feeding is added to the trip when it was not paid through Expenses", () => {
    const c = tripCosts(truck());
    assert.equal(c.agoValue, 1_955_000);
    assert.equal(c.totalExpenses, 2_005_000);
    assert.equal(c.costPerLitre, 40.1);
    assert.equal(c.landingCost, 1340.1);
    assert.equal(c.margin, 59.9);
    assert.equal(c.feedingInExpenses, false);
  });

  test("feeding paid through Expenses is still what the trip cost; it only moves to paid", () => {
    const c = tripCosts(truck({ feedingInExpenses: true }));
    assert.equal(c.feedingAllowance, 50_000);
    assert.equal(c.feedingInExpenses, true);
    assert.equal(c.totalExpenses, 2_005_000);
    assert.equal(c.costPerLitre, 40.1);
    assert.equal(c.landingCost, 1340.1);
    assert.equal(c.margin, 59.9);
    assert.equal(c.paidInExpenses, 50_000);
    assert.equal(c.stillToPay, 0);
  });

  test("reads the database column name as well", () => {
    const c = tripCosts(truck({ feedingInExpenses: undefined, feeding_in_expenses: true }));
    assert.equal(c.paidInExpenses, 50_000);
  });

  test("feeding only, paid through Expenses, still costs the truck its feeding", () => {
    const c = tripCosts(truck({ agoLitres: null, agoPrice: null, feedingInExpenses: true }));
    assert.equal(c.totalExpenses, 50_000);
    assert.equal(c.costPerLitre, 1);
    assert.equal(c.costed, true);
  });

  test("a rate of ₦0 is a truck not sold yet: no margin, not a loss of the whole landing cost", () => {
    const c = tripCosts(truck({ rate: "0.00" }));
    assert.equal(c.landingCost, 1340.1);
    assert.equal(c.margin, null);
    assert.equal(c.marginValue, null);
    assert.deepEqual(c.missing, ["selling rate"]);
  });

  test("own trucks' diesel is out of our stock: neither paid nor still to pay", () => {
    const c = tripCosts(truck());
    assert.equal(c.paidInExpenses, 0);
    assert.equal(c.stillToPay, 50_000);
  });

  test("the mark alone, with no feeding entered, changes nothing", () => {
    const c = tripCosts(truck({ feedingAllowance: null, feedingInExpenses: true }));
    assert.equal(c.totalExpenses, 1_955_000);
    const blank = tripCosts({ quantityAllocated: 50_000, feedingInExpenses: true });
    assert.equal(blank.totalExpenses, null);
    assert.equal(blank.costed, false);
  });
});

/**
 * A third-party truck (0094): its owner charges haulage and buys AGO from us
 * out of it. ₦3,000,000 haulage, 1,150 L of AGO at ₦1,700 = ₦1,955,000, so
 * the owner is paid ₦1,045,000 and the trip's carriage is the ₦3,000,000.
 */
describe("tripCosts on a third-party truck", () => {
  const hired = (over = {}) => truck({ truckThirdParty: true, haulageAmount: "3000000", feedingAllowance: null, ...over });

  test("the owner is paid haulage less the AGO they bought", () => {
    const c = tripCosts(hired());
    assert.equal(c.thirdParty, true);
    assert.equal(c.haulageAmount, 3_000_000);
    assert.equal(c.agoValue, 1_955_000);
    assert.equal(c.haulageBalance, 1_045_000);
  });

  test("the carriage is the whole haulage — the AGO is neither added nor taken off", () => {
    const c = tripCosts(hired());
    assert.equal(c.totalExpenses, 3_000_000);
    assert.equal(c.costPerLitre, 60);
    assert.equal(c.landingCost, 1360);
    assert.equal(c.margin, 40);
  });

  test("no AGO given: the owner gets the whole haulage", () => {
    const c = tripCosts(hired({ agoLitres: null, agoPrice: null }));
    assert.equal(c.haulageBalance, 3_000_000);
    assert.equal(c.totalExpenses, 3_000_000);
  });

  test("AGO given at no price yet: what the owner is owed is unknown, not the whole haulage", () => {
    const c = tripCosts(hired({ agoPrice: null }));
    assert.equal(c.haulageBalance, null);
    assert.equal(c.totalExpenses, 3_000_000);
  });

  test("a hired truck with no haulage yet is uncosted carriage, not diesel we burnt", () => {
    const c = tripCosts(hired({ haulageAmount: null }));
    assert.equal(c.thirdParty, true);
    assert.equal(c.haulageBalance, null);
    assert.equal(c.totalExpenses, null);
    assert.equal(c.costPerLitre, null);
  });

  test("feeding we paid is still added on top of the haulage", () => {
    const c = tripCosts(hired({ feedingAllowance: "50000" }));
    assert.equal(c.totalExpenses, 3_050_000);
  });

  test("paying the owner never makes the truck cheaper: JMT276XA on PFI-38B", () => {
    const c = tripCosts({
      quantityAllocated: 50_000, haulageRate: "65", agoLitres: "575", agoPrice: "1900",
      productPrice: "1350", rate: "0", truckThirdParty: true,
      loadingCost: "81500", loadingRequest: { status: "paid" },
      ownerPayments: { paid: 1_125_000, requested: 0 },
    });
    assert.equal(c.haulageAmount, 3_250_000);
    assert.equal(c.totalExpenses, 3_331_500);
    assert.equal(c.costPerLitre, 66.63);
    assert.equal(c.landingCost, 1416.63);
    assert.equal(c.paidInExpenses, 1_206_500);
    assert.equal(c.ownerOwed, 1_032_500);
    assert.equal(c.stillToPay, 1_032_500);
    assert.equal(c.haulageAdded, 2_125_000, "a batch adds only what the PFI's expenses do not hold");
  });

  test("our own truck is costed exactly as before", () => {
    const c = tripCosts(truck());
    assert.equal(c.thirdParty, false);
    assert.equal(c.haulageAmount, null);
    assert.equal(c.haulageBalance, null);
    assert.equal(c.totalExpenses, 2_005_000);
  });
});
