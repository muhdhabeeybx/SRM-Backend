/**
 * A station's stock and money, restock by restock, the way its dashboard page
 * reads them.
 *
 * A port of the parts of soromanfe's `lib/station-account.ts` a report needs —
 * `loadingsForStation`, `buildStationAccount`, `buildRestock` and
 * `stationShareOf` — plus the "active PFIs" rule from `useRestockClosure`. The
 * Sales & Operations Report used to add a station up its own way, from
 * allocation rows matched on the customer, and printed "N/A" for stock the
 * station page could state plainly, because a truck split between two
 * stations is allocated against only one of them. Reading the station the
 * page's way is what makes the two agree.
 *
 * Trip costing (landing cost, debit, profit) is left out: the report does not
 * print it, and it is stripped from anybody who may not see costs anyway.
 */

const { buildLoadSplit, normalizePlate } = require("./deliveryBatches");
const { lagosToday, localDateStr } = require("./zonedDay");

const toNum = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const normalizeCycleDate = (value) => {
  if (!value) return "";
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw.split("T")[0] || raw : localDateStr(d);
};

const cycleKeyOf = (truck, date) => `${normalizePlate(truck)}||${normalizeCycleDate(date)}`;
const normCode = (v) => String(v || "").trim().toUpperCase();

/**
 * The station's own trade, as against what the truck sale charged it
 * (lib/deliveryBook.js, migration 0070). A row from before the books were
 * told apart reads as the station's, which is what every such row was.
 */
const ownTrade = (row) => row.book !== "trucking";
/** The truck sale's rows for a station: its share of the load, its charge, its settlement. */
const truckSale = (row) => row.book !== "station";

/** A row with a sales value is a pump sale; assignment and deposit rows are not. */
const isPumpSale = (row) => ownTrade(row) && toNum(row.salesValue) > 0;

/** The day a pump sale or deposit happened: its payment date, else the load's. */
const dayOf = (row) => String(row.dateOfPayment || row.dateLoaded || "").slice(0, 10);

/** Litres this station received off one truck — never less than it has sold. */
const stationShareOf = (loading, payments) => {
  // The share is the truck sale's to say: the row the station was put on the
  // load with, and what it was charged for. Its own days only floor it.
  const share = buildLoadSplit(loading, payments.filter(truckSale), new Map()).shares[0]?.quantity ?? 0;
  const base = share > 0 ? share : toNum(loading.quantityAllocated);
  const sold = payments.filter(isPumpSale).reduce((a, p) => a + toNum(p.quantity), 0);
  return Math.max(base, sold);
};

/** Loads delivered to a station: booked against it, or on a cycle it has rows on. */
const loadingsForStation = (loadings, stationSales, stationId) => {
  const cycles = new Set(stationSales.map((s) => cycleKeyOf(s.truckNumber, s.dateLoaded)));
  return loadings.filter(
    (l) => String(l.customerId ?? "") === stationId || cycles.has(cycleKeyOf(l.truckNumber, l.dateAllocated))
  );
};

const buildRestock = (loading, rows, dayStr) => {
  const quantity = loading
    ? stationShareOf(loading, rows)
    : rows.reduce((mx, s) => Math.max(mx, toNum(s.quantity)), 0);
  // What the station did with it. A settlement from the station account is
  // the truck sale's payment, never a deposit of the station's.
  const payments = rows.filter(ownTrade);
  const pump = payments.filter(isPumpSale);
  const today = pump.filter((s) => dayOf(s) === dayStr);
  const quantitySold = pump.reduce((a, s) => a + toNum(s.quantity), 0);
  const soldToday = today.reduce((a, s) => a + toNum(s.quantity), 0);
  return {
    pfiId: loading?.pfiId ?? null,
    pfiNumber: loading?.pfiNumber || "",
    allocationCode: normCode(loading?.allocationCode || rows.map((s) => s.allocationCode).find(Boolean)),
    quantity,
    quantitySold,
    soldToday,
    stockLeft: Math.max(0, quantity - quantitySold),
    salesValue: pump.reduce((a, s) => a + toNum(s.salesValue), 0),
    salesValueToday: today.reduce((a, s) => a + toNum(s.salesValue), 0),
    deposits: payments.reduce((a, s) => a + toNum(s.paymentAmount), 0),
    depositsToday: payments.filter((s) => dayOf(s) === dayStr).reduce((a, s) => a + toNum(s.paymentAmount), 0),
    expenses: payments.reduce((a, s) => a + toNum(s.expensesAmount), 0),
  };
};

/** Every restock a station has had — from its loads, and from sale rows with no load behind them. */
const buildStationRestocks = (loadings, sales, dayStr) => {
  const byCycle = new Map();
  for (const s of sales) {
    const key = cycleKeyOf(s.truckNumber, s.dateLoaded);
    if (!byCycle.has(key)) byCycle.set(key, []);
    byCycle.get(key).push(s);
  }
  const claimed = new Set();
  const restocks = [];
  for (const loading of loadings) {
    const key = cycleKeyOf(loading.truckNumber, loading.dateAllocated);
    const payments = (byCycle.get(key) || []).filter((s) => !claimed.has(String(s.id)));
    payments.forEach((s) => claimed.add(String(s.id)));
    restocks.push(buildRestock(loading, payments, dayStr));
  }
  const orphans = new Map();
  for (const s of sales) {
    if (claimed.has(String(s.id))) continue;
    const key = cycleKeyOf(s.truckNumber, s.dateLoaded);
    if (!orphans.has(key)) orphans.set(key, []);
    orphans.get(key).push(s);
  }
  for (const payments of orphans.values()) restocks.push(buildRestock(null, payments, dayStr));
  return restocks;
};

/**
 * Closed, the way the station pages decide it: the desk closed the batch on
 * Delivery Inventory, or the PFI behind it is finished.
 */
const restockClosure = ({ completedCodes, finishedPfis }) => {
  const closedCodes = new Set([...completedCodes].map(normCode));
  const finishedIds = new Set();
  const finishedNames = new Set();
  for (const p of finishedPfis) {
    finishedIds.add(Number(p.id));
    if (p.pfiNumber) finishedNames.add(normCode(p.pfiNumber));
    if (p.allocationCode) finishedNames.add(normCode(p.allocationCode));
  }
  return (r) =>
    (r.allocationCode && closedCodes.has(normCode(r.allocationCode))) ||
    (r.pfiId != null && finishedIds.has(Number(r.pfiId))) ||
    (r.pfiNumber && finishedNames.has(normCode(r.pfiNumber))) ||
    (r.allocationCode && finishedNames.has(normCode(r.allocationCode)));
};

/**
 * Every station's restocks, grouped by the PFI they came off.
 *
 * @returns {Array<{ stationId, name, customerType, pfis: Array<object> }>}
 *   `pfis` holds one line per batch — the restocks off it added together.
 */
const stationPositions = ({ entries, sales, customers, dayStr, isClosed }) => {
  const stationIds = new Set(
    customers.filter((c) => c.customerType === "filling_station" || c.customerType === "lpg_plant").map((c) => String(c.id))
  );
  const byId = new Map(customers.map((c) => [String(c.id), c]));
  const stationLoadings = entries.filter((l) => stationIds.has(String(l.customerId ?? "")));
  const salesByStation = new Map();
  for (const s of sales) {
    const id = String(s.customerId ?? "");
    if (!stationIds.has(id)) continue;
    if (!salesByStation.has(id)) salesByStation.set(id, []);
    salesByStation.get(id).push(s);
  }

  const out = [];
  for (const id of stationIds) {
    const own = salesByStation.get(id) || [];
    const loadings = loadingsForStation(stationLoadings, own, id);
    const restocks = buildStationRestocks(loadings, own, dayStr);
    const lines = new Map();
    for (const r of restocks) {
      if (isClosed(r)) continue;
      // Tied to no batch at all — a legacy row — is no active PFI's stock.
      const code = r.allocationCode || normCode(r.pfiNumber);
      if (!code) continue;
      if (!lines.has(code)) {
        lines.set(code, {
          code, pfiId: r.pfiId,
          restocks: 0, quantity: 0, quantitySold: 0, soldToday: 0, stockLeft: 0,
          salesValue: 0, salesValueToday: 0, deposits: 0, depositsToday: 0, expenses: 0,
        });
      }
      const l = lines.get(code);
      l.pfiId = l.pfiId ?? r.pfiId;
      l.restocks += 1;
      for (const k of ["quantity", "quantitySold", "soldToday", "stockLeft", "salesValue", "salesValueToday", "deposits", "depositsToday", "expenses"]) {
        l[k] += r[k];
      }
    }
    if (!lines.size) continue;
    const c = byId.get(id);
    out.push({ stationId: id, name: c?.name || "", customerType: c?.customerType, pfis: [...lines.values()] });
  }
  return out;
};

module.exports = { stationPositions, restockClosure, buildStationRestocks, loadingsForStation, stationShareOf };
