/**
 * A delivery batch, summed the way the dashboard sums it.
 *
 * This is a port of soromanfe's `lib/delivery-batches.ts` and the helpers it
 * stands on (`delivery-records.ts`, `load-split.ts`, `sales-ledger-utils.ts`)
 * — the arithmetic behind PFI Tracking and the delivery inventory. It exists so
 * a report can print the SAME figures for a batch as those screens do: the
 * Sales & Operations Report used to count a batch its own way, from sale rows
 * rather than from trucks, and printed 70 trucks sold against 49 allocated for
 * a batch whose card read otherwise.
 *
 * Every rule below is the frontend's, kept in the frontend's words where they
 * explain a number. If one side changes, the other must follow — the parity
 * check is scripts/check-batch-parity.js.
 *
 * Input rows are the API's own shape (camelCase, as the list endpoints return
 * them), so both sides can be fed the same data and compared.
 */

const toNum = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const idKey = (v) => (v === null || v === undefined ? "" : String(v));

/** "BWR 826 XB" and "BWR826XB" are one truck. */
const normalizePlate = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();

/** A date as YYYY-MM-DD, however it was stored. */
const normalizeCycleDate = (value) => {
  if (!value) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw.split("T")[0] || raw : d.toISOString().slice(0, 10);
};

/** A station of either kind: filling station or LPG plant. */
const isStation = (c) => c?.customerType === "filling_station" || c?.customerType === "lpg_plant";

const lookupCustomer = (customers, id) => {
  const key = idKey(id);
  return key ? customers.get(key) || null : null;
};

/**
 * The sales belonging to one truck allocation: same truck and load date; with
 * no date on the allocation, same truck narrowed to the allocation code.
 */
const salesForLoading = (sales, loading) => {
  const plate = normalizePlate(loading.truckNumber);
  if (!plate) return [];
  const onTruck = sales.filter((s) => normalizePlate(s.truckNumber) === plate);
  if (!onTruck.length) return [];
  const loadDate = normalizeCycleDate(loading.dateAllocated);
  if (loadDate) return onTruck.filter((s) => normalizeCycleDate(s.dateLoaded) === loadDate);
  const code = String(loading.allocationCode || "").trim().toUpperCase();
  if (!code) return onTruck;
  const sameCode = onTruck.filter((s) => String(s.allocationCode || "").trim().toUpperCase() === code);
  return sameCode.length ? sameCode : onTruck;
};

/** Each allocation's sales, claimed once; dated allocations claim first. */
const matchSalesByRecord = (entries, allSales) => {
  const map = new Map();
  const claimed = new Set();
  const ordered = [...entries.filter((e) => !!e.dateAllocated), ...entries.filter((e) => !e.dateAllocated)];
  for (const entry of ordered) {
    const matched = salesForLoading(allSales, entry).filter((s) => !claimed.has(idKey(s.id)));
    matched.forEach((s) => claimed.add(idKey(s.id)));
    map.set(idKey(entry.id), matched);
  }
  return map;
};

/** Where a row's rate and value disagree about its volume, the money wins. */
const quantityOf = (sale) => {
  const quantity = toNum(sale.quantity);
  const rate = toNum(sale.rate);
  const salesValue = toNum(sale.salesValue);
  if (rate > 0 && salesValue > 0) {
    const implied = salesValue / rate;
    if (Math.abs(implied - quantity) > 1) return implied;
  }
  return quantity;
};

/** One load, divided between its customers; a share is the largest quantity, never the sum. */
const buildLoadSplit = (loading, sales, customers) => {
  const byCustomer = new Map();
  for (const sale of sales) {
    const cid = idKey(sale.customerId);
    const customer = lookupCustomer(customers, cid);
    const existing = byCustomer.get(cid);
    if (existing) {
      existing.quantity = Math.max(existing.quantity, quantityOf(sale));
      existing.rate = Math.max(existing.rate, toNum(sale.rate));
      existing.payments.push(sale);
      existing.totalPaid += toNum(sale.paymentAmount);
    } else {
      byCustomer.set(cid, {
        customerId: cid,
        quantity: quantityOf(sale),
        rate: toNum(sale.rate),
        isFillingStation: isStation(customer),
        payments: [sale],
        totalPaid: toNum(sale.paymentAmount),
      });
    }
  }
  const shares = [...byCustomer.values()];
  const allocated = toNum(loading?.quantityAllocated);
  const assigned = shares.reduce((a, s) => a + s.quantity, 0);
  return { shares, allocated, assigned, total: Math.max(allocated, assigned) };
};

/**
 * One share's money. A customer's rows REPEAT the load (take the largest
 * billed value); a station's rows ACCUMULATE pump sales (sum them).
 */
const shareMoney = (share, fallbackRate = 0) => {
  const billed = share.isFillingStation
    ? share.payments.reduce((a, s) => a + toNum(s.salesValue), 0)
    : share.payments.reduce((mx, s) => Math.max(mx, toNum(s.salesValue)), 0);
  const rate = share.rate > 0 ? share.rate : fallbackRate;
  const expected = billed > 0 ? billed : rate > 0 ? rate * share.quantity : 0;
  return { expected, paid: share.totalPaid, balance: expected - share.totalPaid };
};

const loadMoney = (split, fallbackRate = 0) => {
  if (!split.shares.length) {
    const expected = fallbackRate > 0 ? fallbackRate * split.total : 0;
    return { expected, paid: 0, balance: expected };
  }
  return split.shares.reduce(
    (acc, share) => {
      const m = shareMoney(share, fallbackRate);
      return { expected: acc.expected + m.expected, paid: acc.paid + m.paid, balance: acc.balance + m.balance };
    },
    { expected: 0, paid: 0, balance: 0 }
  );
};

const hasMoneyOn = (sale) => toNum(sale.rate) > 0 || Math.abs(toNum(sale.paymentAmount)) > 0;

/**
 * Sold, unsold or other. Money on a load, or a station on it, makes it sold
 * whatever the hand-set column says.
 */
const statusOf = (entry, sales, toStation) => {
  if (toStation || sales.some(hasMoneyOn)) return "offloaded";
  const raw = String(entry?.loadingStatus || "").toLowerCase();
  if (raw === "loaded" || raw === "offloaded" || raw === "empty") return raw;
  return "unknown";
};

const resolveRate = (entry, sales) => {
  const fromSales = sales.reduce((mx, s) => Math.max(mx, toNum(s.rate)), 0);
  return fromSales > 0 ? fromSales : toNum(entry.rate);
};

/**
 * Every batch, summed.
 *
 * @param {object} p
 * @param {object[]} p.entries   delivery_inventory rows, API shape
 * @param {object[]} p.sales     delivery_sales rows, API shape
 * @param {object[]} p.customers delivery_customers rows ({ id, customerType })
 * @returns {Map<string, object>} batch summary by upper-cased allocation code
 */
const summariseBatches = ({ entries, sales, customers }) => {
  const customerMap = new Map(customers.map((c) => [idKey(c.id), c]));
  // Allocation stubs — no truck, no status — are not loads.
  const truckEntries = entries.filter((e) => !!(e.truckId || e.truckNumber || e.loadingStatus));
  const salesByRecord = matchSalesByRecord(truckEntries, sales);

  const batches = new Map();
  for (const entry of truckEntries) {
    const matched = salesByRecord.get(idKey(entry.id)) || [];
    const customer = entry.customerId ? lookupCustomer(customerMap, entry.customerId) : null;
    const toStation =
      isStation(customer) || matched.some((s) => isStation(lookupCustomer(customerMap, s.customerId)));
    const status = statusOf(entry, matched, toStation);
    const split = buildLoadSplit(entry, matched, customerMap);
    const money = loadMoney(split, resolveRate(entry, matched));
    const qty = split.total;

    const code = String(entry.allocationCode || "").trim().toUpperCase();
    if (!batches.has(code)) {
      batches.set(code, {
        code,
        trucks: 0, volume: 0,
        soldTrucks: 0, soldQty: 0,
        unsoldTrucks: 0, unsoldQty: 0,
        otherTrucks: 0, otherQty: 0,
        salesValue: 0, paid: 0, unpaid: 0, overpaid: 0,
      });
    }
    const b = batches.get(code);
    b.trucks += 1;
    b.volume += qty;
    if (status === "offloaded") { b.soldTrucks += 1; b.soldQty += qty; }
    else if (status === "loaded") { b.unsoldTrucks += 1; b.unsoldQty += qty; }
    else { b.otherTrucks += 1; b.otherQty += qty; }
    b.salesValue += money.expected;
    b.paid += money.paid;
    // Owed is summed over the loads that owe, never netted against overpayments.
    if (money.balance > 0) b.unpaid += money.balance;
    else b.overpaid += -money.balance;
  }
  return batches;
};

module.exports = {
  summariseBatches,
  // Exported for the parity check and tests.
  salesForLoading, matchSalesByRecord, buildLoadSplit, shareMoney, loadMoney, statusOf, normalizePlate,
};
