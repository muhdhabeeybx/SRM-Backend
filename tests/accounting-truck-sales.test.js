// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { looseRows } = require("../lib/accounting/postingSources/delivery");
const { closeDb } = require("./helpers");

/**
 * A truck is sold once in the books.
 *
 * A Sales Ledger row no load claims is a sale of its own only when its truck,
 * day and customer are not those of a row a load claims — the May Kaduna
 * trucks carried a blank-coded line beside their coded ones, and were sold
 * twice before this.
 */
const row = (id, truckNumber, dateLoaded, customerId, extra = {}) => ({ id, truckNumber, dateLoaded, customerId, ...extra });

test("an unclaimed row of a truck already charged is not sold again", () => {
  const claimed = [row(486, "BWR818XB", "2026-05-19", 3, { allocationCode: "PFI-19B" })];
  const all = [...claimed, row(247, "BWR 818 XB", "2026-05-19T00:00:00.000Z", 3, { allocationCode: "" })];
  assert.deepEqual(looseRows(all, claimed), []);
});

test("a truck no load claims is still a sale", () => {
  const claimed = [row(486, "BWR818XB", "2026-05-19", 3)];
  const other = row(900, "KUJ235XC", "2026-05-19", 3);
  assert.deepEqual(looseRows([...claimed, other], claimed).map((s) => s.id), [900]);
});

test("the same truck on another day, or for another customer, is its own sale", () => {
  const claimed = [row(486, "BWR818XB", "2026-05-19", 3)];
  const nextDay = row(901, "BWR818XB", "2026-05-20", 3);
  const otherCustomer = row(902, "BWR818XB", "2026-05-19", 4);
  assert.deepEqual(looseRows([...claimed, nextDay, otherCustomer], claimed).map((s) => s.id), [901, 902]);
});

after(closeDb);
