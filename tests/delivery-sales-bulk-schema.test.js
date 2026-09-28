const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createDeliverySalesBulk } = require("../schemas/deliverySale.schema");

/**
 * The bulk route takes a station's day or an imported spreadsheet as one
 * transaction. These pin what each row may and may not carry — asserted on
 * the parsed output, because a stripped field still parses successfully.
 */
describe("bulk delivery sales schema", () => {
  const day = [
    { truckNumber: "KUJ234XC", customerId: 12, quantity: 2500, rate: 1370, salesValue: 3425000, dateOfPayment: "2026-09-21" },
    { truckNumber: "KUJ234XC", customerId: 12, paymentAmount: 3400000, depositChannel: "pos", bankAccountId: 3 },
    { truckNumber: "KUJ234XC", customerId: 12, expensesAmount: 45000, remarks: "Generator diesel" },
  ];

  test("a station's day — a sale, a remittance, an expense — parses whole", () => {
    const r = createDeliverySalesBulk.safeParse({ sales: day });
    assert.equal(r.success, true);
    assert.equal(r.data.sales.length, 3);
    assert.equal(r.data.sales[1].depositChannel, "pos");
    assert.equal(r.data.sales[2].expensesAmount, "45000.00");
  });

  test("statement lines cannot ride in on a bulk row", () => {
    // Claiming them has its own guarded path; a bulk insert must not mark
    // bank credits spent.
    const r = createDeliverySalesBulk.safeParse({ sales: [{ ...day[1], lineIds: [9] }] });
    assert.equal(r.success, true);
    assert.equal("lineIds" in r.data.sales[0], false);
  });

  test("nor can a forged deposit status", () => {
    const r = createDeliverySalesBulk.safeParse({ sales: [{ ...day[1], depositStatus: "paid" }] });
    assert.equal(r.success, true);
    assert.equal("depositStatus" in r.data.sales[0], false);
  });

  test("a pump volume can carry decimals, as the meter reads it", () => {
    const r = createDeliverySalesBulk.safeParse({ sales: [{ ...day[0], quantity: "12345.67" }] });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.equal(r.data.sales[0].quantity, 12345.67);
    assert.equal(createDeliverySalesBulk.safeParse({ sales: [{ ...day[0], quantity: 2500.5 }] }).success, true);
  });

  test("but not more than three decimal places, and never zero or less", () => {
    assert.equal(createDeliverySalesBulk.safeParse({ sales: [{ ...day[0], quantity: 1.2345 }] }).success, false);
    assert.equal(createDeliverySalesBulk.safeParse({ sales: [{ ...day[0], quantity: 0 }] }).success, false);
    assert.equal(createDeliverySalesBulk.safeParse({ sales: [{ ...day[0], quantity: -5.5 }] }).success, false);
  });

  test("every row still needs its truck", () => {
    const r = createDeliverySalesBulk.safeParse({ sales: [day[0], { customerId: 12, paymentAmount: 1 }] });
    assert.equal(r.success, false);
    assert.equal(r.error.issues[0].path.join("."), "sales.1.truckNumber");
  });

  test("an empty upload is refused rather than answered with success", () => {
    assert.equal(createDeliverySalesBulk.safeParse({ sales: [] }).success, false);
  });
});
