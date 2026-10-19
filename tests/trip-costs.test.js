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
