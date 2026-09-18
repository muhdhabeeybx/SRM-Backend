require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  daysBetween,
  previousDay,
  isListed,
  normaliseUnit,
  buildRow,
  addToTotals,
  emptyTotals,
} = require("../services/cfoReport.service");
const { cfoReportRepo } = require("../repositories");
const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * The CFO report's rules, pinned.
 *
 * Almost all of this needs no database, and that is deliberate: the figures on
 * this sheet are checked by eye against a bank statement, so the arithmetic
 * that produces them has to be assertable without a fixture to go wrong. The
 * two things a database IS needed for — the override round trip and the
 * migration-0021 duplicate rule — are kept at the bottom and skip themselves
 * if the schema is not there.
 */

describe("CFO report — the day range", () => {
  test("a closed range includes both ends", () => {
    assert.deepEqual(daysBetween("2026-09-15", "2026-09-18"), [
      "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
    ]);
  });

  test("a single day is one day, not none", () => {
    assert.deepEqual(daysBetween("2026-09-17", "2026-09-17"), ["2026-09-17"]);
  });

  test("it steps across a month boundary", () => {
    assert.deepEqual(daysBetween("2026-08-30", "2026-09-02"), [
      "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02",
    ]);
  });

  test("it steps across a leap day", () => {
    assert.deepEqual(daysBetween("2024-02-28", "2024-03-01"), [
      "2024-02-28", "2024-02-29", "2024-03-01",
    ]);
  });

  test("a reversed range yields nothing rather than looping", () => {
    assert.deepEqual(daysBetween("2026-09-18", "2026-09-15"), []);
  });

  test("the opening balance is taken from the day BEFORE the window", () => {
    // Off by one here means the first day of every report double-counts or
    // omits a whole day's trading, and the error never shows up again.
    assert.equal(previousDay("2026-09-15"), "2026-09-14");
    assert.equal(previousDay("2026-09-01"), "2026-08-31");
    assert.equal(previousDay("2024-03-01"), "2024-02-29");
  });
});

describe("CFO report — which PFIs appear on a day", () => {
  const span = { firstDay: "2026-08-01", lastDay: "2026-09-10" };
  const active = { status: "active", closureDay: null };
  const finished = { status: "finished", closureDay: null };

  test("a PFI that traded is listed however else it reads", () => {
    assert.equal(
      isListed({ day: "2026-09-20", pfi: finished, span, dayQty: 5000 }),
      true
    );
  });

  test("a PFI is not listed before its first confirmed sale", () => {
    assert.equal(isListed({ day: "2026-07-31", pfi: active, span, dayQty: 0 }), false);
  });

  test("a PFI with no confirmed sale at all is never listed", () => {
    assert.equal(
      isListed({ day: "2026-09-01", pfi: active, span: { firstDay: null, lastDay: null }, dayQty: 0 }),
      false
    );
  });

  test("an open PFI stays listed on a quiet day after its last sale", () => {
    // Stock sitting in a tank with nothing moving is the thing a CFO most
    // wants to see, so silence must not remove the row.
    assert.equal(isListed({ day: "2026-09-20", pfi: active, span, dayQty: 0 }), true);
  });

  test("a finished PFI drops off after its last trading day", () => {
    assert.equal(isListed({ day: "2026-09-10", pfi: finished, span, dayQty: 0 }), true);
    assert.equal(isListed({ day: "2026-09-11", pfi: finished, span, dayQty: 0 }), false);
  });

  test("a finished PFI closed later stays until its closure date", () => {
    const closedLate = { status: "finished", closureDay: "2026-09-15" };
    assert.equal(isListed({ day: "2026-09-14", pfi: closedLate, span, dayQty: 0 }), true);
    assert.equal(isListed({ day: "2026-09-16", pfi: closedLate, span, dayQty: 0 }), false);
  });

  test("includeAll lists a started PFI whatever its state", () => {
    assert.equal(
      isListed({ day: "2026-09-20", pfi: finished, span, dayQty: 0, includeAll: true }),
      true
    );
    // Still not before it existed — "all" is all the PFIs, not all of time.
    assert.equal(
      isListed({ day: "2026-07-01", pfi: finished, span, dayQty: 0, includeAll: true }),
      false
    );
  });
});

describe("CFO report — units", () => {
  test("the two spellings of litres are one unit", () => {
    assert.equal(normaliseUnit("Litres"), "Litres");
    assert.equal(normaliseUnit("Liters"), "Litres");
    assert.equal(normaliseUnit("liter"), "Litres");
    assert.equal(normaliseUnit(""), "Litres");
  });

  test("kilogrammes stay their own unit", () => {
    assert.equal(normaliseUnit("kg"), "kg");
  });

  test("quantities in different units are never added together", () => {
    // 160,000 kg of LPG plus 26,992,931 L of petrol is not a quantity of
    // anything, and a totals row that prints it is a wrong number.
    const totals = emptyTotals();
    addToTotals(totals, row({ productUnit: "Litres", dayVolume: 100, initialQty: 1000, cumulativeVolume: 400, stockBalance: 600, salesValue: 50 }));
    addToTotals(totals, row({ productUnit: "kg", dayVolume: 7, initialQty: 160, cumulativeVolume: 60, stockBalance: 100, salesValue: 25 }));

    assert.deepEqual(Object.keys(totals.byUnit).sort(), ["Litres", "kg"]);
    assert.equal(totals.byUnit.Litres.dayVolume, 100);
    assert.equal(totals.byUnit.kg.dayVolume, 7);
    // Money is money, whatever the product is measured in.
    assert.equal(totals.salesValue, 75);
  });
});

/** A row shaped enough for addToTotals, with sensible defaults. */
function row(over = {}) {
  return {
    productUnit: "Litres", initialQty: 0, cumulativeVolume: 0, dayVolume: 0,
    stockBalance: 0, salesValue: 0, bankInflow: 0, surplusDeficit: 0,
    orders: 0, dayOrders: 0, ...over,
  };
}

describe("CFO report — a row, computed and corrected", () => {
  const pfi = {
    id: 7, pfiNumber: "PFI/01/26/TEST", locationName: "Warri", productName: "Petrol",
    productUnit: "Litres", status: "active", pfiType: "coastal", startingQty: 1000000,
  };
  const running = { qty: 400000, value: 520000000, orders: 12, inflow: 500000000, statementInflow: 450000000 };
  const dayBucket = { qty: 50000, value: 65000000, orders: 2, inflow: 0, statementInflow: 0 };

  test("with no correction, the row is the computed figures", () => {
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry: null });
    assert.equal(r.initialQty, 1000000);
    assert.equal(r.cumulativeVolume, 400000);
    assert.equal(r.dayVolume, 50000);
    assert.equal(r.salesValue, 520000000);
    assert.equal(r.bankInflow, 500000000);
    assert.deepEqual(r.edited, []);
  });

  test("stock balance is initial minus cumulative, always", () => {
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry: null });
    assert.equal(r.stockBalance, 600000);
    assert.equal(r.stockBalance, r.initialQty - r.cumulativeVolume);
  });

  test("surplus/deficit is inflow minus sales value, and negative when owed", () => {
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry: null });
    assert.equal(r.surplusDeficit, -20000000, "20m still owed reads as a deficit");
  });

  test("an override replaces the figure and is declared", () => {
    const entry = { bankInflow: "520000000", remarks: "Transfer matched by hand" };
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry });
    assert.equal(r.bankInflow, 520000000);
    assert.deepEqual(r.edited, ["bankInflow"]);
    assert.equal(r.remarks, "Transfer matched by hand");
  });

  test("the derived figures follow the override, so the row still adds up", () => {
    // The whole reason stock balance and surplus/deficit are not storable.
    const entry = { bankInflow: "520000000", cumulativeVolume: "450000" };
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry });
    assert.equal(r.surplusDeficit, 0, "corrected inflow now settles the sales value exactly");
    assert.equal(r.stockBalance, 550000, "1,000,000 − 450,000");
    assert.equal(r.stockBalance, r.initialQty - r.cumulativeVolume);
    assert.equal(r.surplusDeficit, r.bankInflow - r.salesValue);
  });

  test("an override of zero is honoured, not treated as absent", () => {
    // The defect this pins: `entry.bankInflow || computed` reads 0 as missing
    // and silently prints the system's figure over a deliberate correction.
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry: { bankInflow: "0" } });
    assert.equal(r.bankInflow, 0);
    assert.deepEqual(r.edited, ["bankInflow"]);
    assert.equal(r.surplusDeficit, -520000000);
  });

  test("a null override means the computed figure stands", () => {
    const r = buildRow({
      pfi, day: "2026-09-17", running, dayBucket,
      entry: { bankInflow: null, remarks: "cleared" },
    });
    assert.equal(r.bankInflow, 500000000);
    assert.deepEqual(r.edited, []);
    assert.equal(r.remarks, "cleared", "a remark survives clearing a figure");
  });

  test("what the system said is always kept beside what was typed", () => {
    const r = buildRow({ pfi, day: "2026-09-17", running, dayBucket, entry: { bankInflow: "1" } });
    assert.equal(r.computed.bankInflow, 500000000);
    assert.equal(r.bankInflow, 1);
    assert.equal(r.computed.statementInflow, 450000000, "and how much of it a bank line backs");
  });
});

// ── Everything below needs a database ──────────────────────────────────────

describe("CFO report — the corrections table", () => {
  let pfiId = null;
  let available = false;

  before(async () => {
    const [{ exists }] = await client`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_name = 'cfo_report_entries') AS exists`;
    if (!exists) return;
    const rows = await client`SELECT id FROM pfis ORDER BY id LIMIT 1`;
    if (!rows.length) return;
    pfiId = Number(rows[0].id);
    available = true;
    await client`DELETE FROM cfo_report_entries WHERE report_date = '2026-01-02'`;
  });

  after(async () => {
    if (available) await client`DELETE FROM cfo_report_entries WHERE report_date = '2026-01-02'`;
    await closeDb();
  });

  test("a correction saves and reads back", async (t) => {
    if (!available) return t.skip("no cfo_report_entries table or no PFI to hang one off");
    await cfoReportRepo.upsertEntry({
      reportDate: "2026-01-02", pfiId,
      values: { bankInflow: "1234.56", remarks: "checked against UBA statement" },
      staffId: null,
    });
    const [saved] = await cfoReportRepo.findEntries({ from: "2026-01-02", to: "2026-01-02", pfiIds: [pfiId] });
    assert.equal(Number(saved.bankInflow), 1234.56);
    assert.equal(saved.remarks, "checked against UBA statement");
    assert.equal(saved.initialQty, null, "a field nobody touched stays untouched");
  });

  test("saving again updates in place rather than failing on the unique index", async (t) => {
    if (!available) return t.skip("no cfo_report_entries table");
    await cfoReportRepo.upsertEntry({
      reportDate: "2026-01-02", pfiId, values: { bankInflow: "99.00" }, staffId: null,
    });
    const rows = await cfoReportRepo.findEntries({ from: "2026-01-02", to: "2026-01-02", pfiIds: [pfiId] });
    assert.equal(rows.length, 1, "one row per PFI per day, still");
    assert.equal(Number(rows[0].bankInflow), 99);
    assert.equal(rows[0].remarks, "checked against UBA statement", "an absent key leaves the remark alone");
  });

  test("an explicit null clears one override without touching the rest", async (t) => {
    if (!available) return t.skip("no cfo_report_entries table");
    await cfoReportRepo.upsertEntry({
      reportDate: "2026-01-02", pfiId, values: { bankInflow: null }, staffId: null,
    });
    const [row] = await cfoReportRepo.findEntries({ from: "2026-01-02", to: "2026-01-02", pfiIds: [pfiId] });
    assert.equal(row.bankInflow, null);
    assert.equal(row.remarks, "checked against UBA statement");
  });

  test("deleting puts the row back to what the system says", async (t) => {
    if (!available) return t.skip("no cfo_report_entries table");
    await cfoReportRepo.deleteEntry({ reportDate: "2026-01-02", pfiId });
    const rows = await cfoReportRepo.findEntries({ from: "2026-01-02", to: "2026-01-02", pfiIds: [pfiId] });
    assert.equal(rows.length, 0);
    // Deleting what is already gone is the state the caller asked for.
    assert.equal(await cfoReportRepo.deleteEntry({ reportDate: "2026-01-02", pfiId }), null);
  });

  test("an empty scope means no PFIs, not every PFI", async (t) => {
    if (!available) return t.skip("no database");
    // The defect this pins: treating an empty id list as "no filter" handed a
    // user scoped to a depot with no PFIs the whole company's book.
    const rows = await cfoReportRepo.findEntries({ from: "2026-01-01", to: "2026-12-31", pfiIds: [] });
    assert.deepEqual(rows, []);
  });
});
