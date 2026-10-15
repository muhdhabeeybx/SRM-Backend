const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { wearSchedule, wearTo, valueOn } = require("../lib/accounting/depreciation");

/**
 * Wear and tear (lib/accounting/depreciation): cost less residual, evenly
 * over the months of its life, from the month after it was bought, a month
 * at a time as each one ends.
 */
describe("wear and tear", () => {
  const truck = { boughtOn: "2026-01-15", cost: 60_000_000, residual: 0, lifeMonths: 60 };

  test("starts the month after it was bought, a month's wear on its last day", () => {
    const s = wearSchedule(truck, "2026-03-31");
    assert.deepEqual(s.map((w) => w.month), ["2026-02", "2026-03"]);
    assert.equal(s[0].day, "2026-02-28");
    assert.equal(s[0].amount, 1_000_000);
  });

  test("a month not yet ended is not worn", () => {
    assert.equal(wearSchedule(truck, "2026-03-30").length, 1);
    assert.equal(wearTo(truck, "2026-03-30"), 1_000_000);
    assert.equal(valueOn(truck, "2026-03-30"), 59_000_000);
  });

  test("stops at the end of its life, down to the residual and no further", () => {
    const a = { ...truck, residual: 6_000_000 };
    const s = wearSchedule(a, "2040-01-01");
    assert.equal(s.length, 60);
    assert.equal(wearTo(a, "2040-01-01"), 54_000_000);
    assert.equal(valueOn(a, "2040-01-01"), 6_000_000);
  });

  test("months that do not divide evenly add up to the kobo, the last month taking the rest", () => {
    const a = { boughtOn: "2026-09-01", cost: 1_000_000, lifeMonths: 3 };
    const s = wearSchedule(a, "2027-12-31");
    assert.deepEqual(s.map((w) => w.amount), [333_333.33, 333_333.33, 333_333.34]);
    assert.equal(wearTo(a, "2027-12-31"), 1_000_000);
  });

  test("stops before the month it was sold", () => {
    const s = wearSchedule({ ...truck, disposedOn: "2026-05-10" }, "2030-01-01");
    assert.deepEqual(s.map((w) => w.month), ["2026-02", "2026-03", "2026-04"]);
  });

  test("land, with no life, never wears", () => {
    assert.deepEqual(wearSchedule({ boughtOn: "2020-01-01", cost: 5_000_000, lifeMonths: null }, "2030-01-01"), []);
    assert.equal(valueOn({ boughtOn: "2020-01-01", cost: 5_000_000, lifeMonths: null }, "2030-01-01"), 5_000_000);
  });
});
