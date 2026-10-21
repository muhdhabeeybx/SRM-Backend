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

  test("feeding paid through Expenses stays on the row but is not added again", () => {
    const c = tripCosts(truck({ feedingInExpenses: true }));
    assert.equal(c.feedingAllowance, 50_000);
    assert.equal(c.feedingInExpenses, true);
    assert.equal(c.totalExpenses, 1_955_000);
    assert.equal(c.costPerLitre, 39.1);
    assert.equal(c.landingCost, 1339.1);
    assert.equal(c.margin, 60.9);
  });

  test("reads the database column name as well", () => {
    const c = tripCosts(truck({ feedingInExpenses: undefined, feeding_in_expenses: true }));
    assert.equal(c.totalExpenses, 1_955_000);
  });

  test("feeding only, paid through Expenses, is a known zero, not uncosted", () => {
    const c = tripCosts(truck({ agoLitres: null, agoPrice: null, feedingInExpenses: true }));
    assert.equal(c.totalExpenses, 0);
    assert.equal(c.costPerLitre, 0);
    assert.equal(c.costed, true);
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

  test("our own truck is costed exactly as before", () => {
    const c = tripCosts(truck());
    assert.equal(c.thirdParty, false);
    assert.equal(c.haulageAmount, null);
    assert.equal(c.haulageBalance, null);
    assert.equal(c.totalExpenses, 2_005_000);
  });
});
