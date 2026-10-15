const { db, client } = require("../../db");
const { listChart } = require("../../lib/accounting/chart");
const { landedCosts } = require("../../lib/accounting/landedCost");
const { computeFinancials } = require("../../lib/pfiFinance");
const { lagosToday } = require("../../lib/zonedDay");
const reports = require("./reports.service");

/**
 * The Report — the first Accounts page (the owner's ask, 15 Oct 2026): for the
 * whole business, one PFI or one place (a depot, filling station or LPG
 * plant), over any period, the questions people ask, in their words:
 *
 *   profit    did we make money? — sales, what they cost, expenses, and the
 *             profit or loss; for the whole business, PFI by PFI and part by
 *             part
 *   banks     money in and out of each bank: what it held at the start,
 *             what came in, what went out, what it held at the end
 *   flows     where the money came from and where it went — customers,
 *             stations, cargo suppliers, expenses, loans — with money moved
 *             between our own accounts set apart
 *   position  at the period's end, what we own, what we owe, and what the
 *             business is worth: the balance sheet in plain words
 *   cargo     for one PFI: litres bought and at what cost, sold, left
 *   place     for one place: what its customers still owe and what it has
 *             still to bank
 *
 * Everything is read off the books (journal_lines), so it agrees with the
 * Profit, Balance Sheet and Banks pages, figure for figure.
 *
 * ── Money in and out, record by record ────────────────────────────────────
 *
 * The books move a bank line as its story is learned: booked against
 * Suspense when it comes in, taken back when it is matched to a payment, and
 * booked again by the payment. Added up line by line, that one naira would
 * read as two in and one out. So bank movements are netted per record (the
 * entries one desk record booked, take-backs and changes included — they
 * carry the record's own day), and only what a record left in the bank
 * counts: in when it added, out when it took away.
 */

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const minDay = (a, b) => (a < b ? a : b);

/** One record's entries: a desk record by its source, a hand-written journal with its reversal. */
const RECORD = client`COALESCE(e.source_type, 'entry')`;
const RECORD_ID = client`COALESCE(e.source_id, COALESCE(e.reverses_entry_id, e.id)::text)`;

const dimsSql = (dims = {}) => {
  let frag = client``;
  if (dims.pfiIds?.length) frag = client`${frag} AND l.pfi_id = ANY(${dims.pfiIds.map(Number)}::int[])`;
  if (dims.locations?.length) frag = client`${frag} AND (l.location_type || ':' || l.location_id) = ANY(${dims.locations}::text[])`;
  return frag;
};
const narrowed = (dims) => !!(dims.pfiIds?.length || dims.locations?.length);
const inPeriod = (from, to) => client`
  (${from}::date IS NULL OR e.entry_date >= ${from}::date) AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)`;

/**
 * What the other side of money in or out was, by the account it was booked
 * against: [label when money came in, label when it went out].
 */
const FLOW = {
  customer_receivables: ["Depot customers paid", "Refunds to depot customers"],
  trucking_receivables: ["Trucking customers paid", "Refunds to trucking customers"],
  station_takings: ["Filling stations banked", "Paid back to filling stations"],
  plant_takings: ["LPG plants banked", "Paid back to LPG plants"],
  supplier_payables: ["Money back from cargo suppliers", "Paid for cargo"],
  vendor_payables: ["Money back from vendors", "Expenses paid"],
  transfers_clearing: ["Moved in from our other accounts", "Moved out to our other accounts"],
  bank_charges: ["Bank charges refunded", "Bank charges"],
  suspense: ["Not yet explained", "Not yet explained"],
  loans: ["Loans received", "Loans repaid"],
  loan_interest: ["Interest refunded", "Interest on loans"],
  fixed_assets: ["Assets sold", "Assets bought"],
  asset_disposals: ["Assets sold", "Assets bought"],
  vat_payable: ["Tax refunded by FIRS", "Tax paid to FIRS"],
  wht_payable: ["Tax refunded by FIRS", "Tax paid to FIRS"],
  input_vat: ["Tax refunded by FIRS", "Tax paid to FIRS"],
  commission_float: ["Commission money returned", "Commission money given out"],
  commissions_payable: ["Commission returned", "Commission paid to customers"],
  opening_balance_equity: ["What the banks held when the books started", "What the banks owed when the books started"],
  share_capital: ["Capital put in", "Capital taken out"],
};
const INTERNAL = new Set(["transfers_clearing"]);

/** Each bank: at the start, in, out, at the end. */
async function bankMovements({ from, to, dims, bankIds }) {
  const moves = await client`
    SELECT l.account_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ANY(${bankIds}::int[]) AND ${inPeriod(from, to)} ${dimsSql(dims)}
     GROUP BY l.account_id, ${RECORD}, ${RECORD_ID}
    HAVING SUM(l.debit - l.credit) <> 0`;
  const balances = narrowed(dims) ? [] : await client`
    SELECT l.account_id,
           SUM(CASE WHEN ${from}::date IS NOT NULL AND e.entry_date < ${from}::date THEN l.debit - l.credit ELSE 0 END) AS at_start,
           SUM(CASE WHEN ${to}::date IS NULL OR e.entry_date <= ${to}::date THEN l.debit - l.credit ELSE 0 END) AS at_end
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ANY(${bankIds}::int[])
     GROUP BY l.account_id`;
  const out = new Map();
  const of = (id) => {
    if (!out.has(id)) out.set(id, { atStart: 0, moneyIn: 0, moneyOut: 0, atEnd: 0 });
    return out.get(id);
  };
  for (const m of moves) {
    const b = of(Number(m.account_id));
    const n = Number(m.net);
    if (n > 0) b.moneyIn += n;
    else b.moneyOut -= n;
  }
  for (const r of balances) {
    const b = of(Number(r.account_id));
    b.atStart = money(r.at_start);
    b.atEnd = money(r.at_end);
  }
  for (const b of out.values()) {
    b.moneyIn = money(b.moneyIn);
    b.moneyOut = money(b.moneyOut);
  }
  return out;
}

/**
 * Where money in came from and where money out went. A record's bank
 * movement is shared among the lines on its other side that move the same
 * way — a repayment's principal and its interest, each its own part — so a
 * hire purchase's deposit reads as an asset bought, not as the asset's whole
 * cost against a loan nobody paid in.
 */
async function flows({ from, to, dims, chart }) {
  const byId = new Map(chart.map((a) => [a.id, a]));
  const isBank = (id) => byId.get(id)?.bankAccountId != null;
  const bankIds = chart.filter((a) => a.bankAccountId != null).map((a) => a.id);
  const rows = await client`
    WITH touched AS (
      SELECT DISTINCT ${RECORD} AS st, ${RECORD_ID} AS sid
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ANY(${bankIds}::int[]) AND ${inPeriod(from, to)} ${dimsSql(dims)}
    )
    SELECT t.st, t.sid, l.account_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      JOIN touched t ON t.st = ${RECORD} AND t.sid = ${RECORD_ID}
     WHERE ${inPeriod(from, to)} ${dimsSql(dims)}
     GROUP BY t.st, t.sid, l.account_id`;
  const records = new Map();
  for (const r of rows) {
    const k = `${r.st}|${r.sid}`;
    if (!records.has(k)) records.set(k, []);
    records.get(k).push({ account: Number(r.account_id), net: Number(r.net) });
  }

  const sums = new Map();
  const add = (key, label, direction, amount, internal) => {
    const k = `${direction}|${label}`;
    const had = sums.get(k) || { key, label, direction, amount: 0, internal };
    had.amount += amount;
    sums.set(k, had);
  };
  for (const lines of records.values()) {
    const bank = lines.filter((l) => isBank(l.account)).reduce((t, l) => t + l.net, 0);
    if (Math.abs(bank) < 0.005) continue;
    const direction = bank > 0 ? "in" : "out";
    // The other side, as money: a credit there is money in here.
    const sameWay = lines
      .filter((l) => !isBank(l.account))
      .map((l) => ({ ...l, cash: -l.net }))
      .filter((l) => (bank > 0 ? l.cash > 0 : l.cash < 0));
    const spread = sameWay.reduce((t, l) => t + l.cash, 0);
    if (!sameWay.length || Math.abs(spread) < 0.005) {
      add("other", "Other", direction, Math.abs(bank), false);
      continue;
    }
    for (const l of sameWay) {
      const a = byId.get(l.account);
      const key = a?.systemKey || `account:${l.account}`;
      const label = FLOW[key]?.[direction === "in" ? 0 : 1] || a?.name || "Other";
      add(key, label, direction, Math.abs(bank * (l.cash / spread)), INTERNAL.has(key));
    }
  }
  const list = (direction) => [...sums.values()]
    .filter((s) => s.direction === direction && s.amount >= 0.005)
    .map((s) => ({ key: s.key, label: s.label, amount: money(s.amount), internal: s.internal }))
    .sort((x, y) => Number(x.internal) - Number(y.internal) || y.amount - x.amount);
  const moneyIn = list("in");
  const moneyOut = list("out");
  const total = (xs, internal) => money(xs.filter((x) => x.internal === internal).reduce((t, x) => t + x.amount, 0));
  return {
    in: moneyIn,
    out: moneyOut,
    totalIn: total(moneyIn, false),
    totalOut: total(moneyOut, false),
    movedIn: total(moneyIn, true),
    movedOut: total(moneyOut, true),
  };
}

/** The profit and loss's figures, in the report's words. */
const profitOf = (f) => ({
  sales: f.sales.total,
  costOfSales: f.costOfSales.total,
  grossProfit: f.grossProfit,
  otherIncome: f.otherIncome.total,
  expenses: f.expenses.total,
  netProfit: f.netProfit,
});

/**
 * The balance sheet at a day, in plain buckets: what we own, what we owe. A
 * bank account below nought is an overdraft — owed, not owned.
 */
function position(bs) {
  const own = new Map();
  const owe = new Map();
  // Where each figure is worked through: a page, and what to open it on.
  const put = (m, key, label, amount, link) => {
    const [to, query] = link.split("?");
    const search = query ? Object.fromEntries(new URLSearchParams(query)) : undefined;
    const had = m.get(key) || { key, label, amount: 0, to, search };
    had.amount += amount;
    m.set(key, had);
  };
  for (const l of bs.assets.lines) {
    if (l.heading === "Bank accounts") {
      if (l.amount >= 0) put(own, "cash", "Cash in the banks", l.amount, "/accounts/bank-reconciliation");
      else put(owe, "overdrafts", "Bank overdrafts", -l.amount, "/accounts/bank-reconciliation");
    } else if (l.heading === "Paid ahead") put(own, "paid_ahead", "Paid ahead to vendors and suppliers", l.amount, "/accounts/ageing?side=payables");
    else if (l.key === "stock") put(own, "stock", "Product in the tanks, at cost", l.amount, "/accounts/balance-sheet");
    else if (l.key === "customer_receivables" || l.key === "trucking_receivables") put(own, "receivables", "Customers owe us", l.amount, "/accounts/ageing");
    else if (l.key === "station_takings" || l.key === "plant_takings") put(own, "takings", "Stations and plants still to bank", l.amount, "/accounts/ageing");
    else if (l.key === "fixed_assets" || l.key === "accumulated_depreciation") put(own, "fixed_assets", "Trucks, equipment and property, after wear", l.amount, "/accounts/fixed-assets");
    else if (l.key === "commission_float") put(own, "commission_float", "Commission money with staff", l.amount, "/commissions");
    else if (l.key === "input_vat") put(own, "input_vat", "VAT we can claim back", l.amount, "/expenses/tax-report");
    else if (l.key === "suspense" || l.key === "transfers_clearing") put(own, "to_match", "Money still to match", l.amount, "/accounts/bank-reconciliation");
    else put(own, "other", "Other things we own", l.amount, "/accounts/balance-sheet");
  }
  for (const l of bs.liabilities.lines) {
    if (l.heading === "Paid ahead") put(owe, "held", "Customers' money we hold", l.amount, "/accounts/ageing");
    else if (l.key === "supplier_payables") put(owe, "suppliers", "Cargo suppliers", l.amount, "/accounts/ageing?side=payables");
    else if (l.key === "vendor_payables") put(owe, "vendors", "Vendors", l.amount, "/accounts/ageing?side=payables");
    else if (l.key === "vat_payable" || l.key === "wht_payable") put(owe, "firs", "FIRS (VAT and WHT)", l.amount, "/expenses/tax-report");
    else if (l.key === "loans") put(owe, "loans", "Loans", l.amount, "/accounts/loans");
    else if (l.key === "commissions_payable") put(owe, "commission", "Commission owed to customers", l.amount, "/commissions");
    else put(owe, "other", "Other things we owe", l.amount, "/accounts/balance-sheet");
  }
  const tidy = (m) => [...m.values()].map((x) => ({ ...x, amount: money(x.amount) })).filter((x) => Math.abs(x.amount) >= 0.005);
  const ownList = tidy(own);
  const oweList = tidy(owe);
  const totalOwn = money(ownList.reduce((t, x) => t + x.amount, 0));
  const totalOwe = money(oweList.reduce((t, x) => t + x.amount, 0));
  return { own: ownList, owe: oweList, totalOwn, totalOwe, worth: money(totalOwn - totalOwe), difference: bs.difference };
}

/** One PFI's cargo: what it bought, sold and has left, from the PFI file's own figures. */
async function cargo(pfiId, { at }) {
  const { pfiRepo, pfiExpenseRepo } = require("../../repositories");
  const pfi = await pfiRepo.findById(pfiId);
  if (!pfi) return null;
  const [aggs, costs] = await Promise.all([pfiExpenseRepo.aggregatesFor([pfi.id]), landedCosts(db)]);
  const f = computeFinancials(pfi, aggs.get(Number(pfi.id)) || {});
  const c = costs.get(Number(pfi.id));
  let parent = null;
  if (c?.isBatch && c.stockPfiId !== Number(pfi.id)) {
    const [p] = await client`SELECT id, pfi_number FROM pfis WHERE id = ${c.stockPfiId}`;
    parent = p ? { id: Number(p.id), pfiNumber: p.pfi_number } : null;
  }
  // Who still owes on its sales, and who has paid ahead, party by party.
  const parties = await client`
    SELECT l.party_type, l.party_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.pfi_id = ${pfiId} AND e.entry_date <= ${at}::date
       AND l.account_id IN (SELECT id FROM expense_categories WHERE system_key IN ('customer_receivables', 'trucking_receivables'))
     GROUP BY 1, 2`;
  const owed = money(parties.filter((p) => Number(p.net) > 0).reduce((t, p) => t + Number(p.net), 0));
  const paidAhead = money(-parties.filter((p) => Number(p.net) < 0).reduce((t, p) => t + Number(p.net), 0));
  const perLitre = c?.perLitre ?? null;
  const left = f.remaining ?? null;
  return {
    pfiId: Number(pfi.id),
    pfiNumber: pfi.pfiNumber,
    product: pfi.productName || null,
    type: pfi.pfiType || null,
    status: pfi.status || null,
    /** A trucking batch's litres are its cargo's: its stock is that cargo's. */
    cargoOf: parent,
    litresInTank: f.stockQtyLitres ?? f.tankQtyLitres ?? null,
    billedLitres: f.costQtyLitres ?? null,
    unitPrice: f.pricePerLitre ?? null,
    boughtFor: c?.isBatch ? null : (f.pfiValue ?? null),
    costsAdded: c ? money(c.extras) : null,
    costPerLitre: perLitre == null ? null : Math.round(perLitre * 100) / 100,
    litresSold: f.sold ?? null,
    salesValue: f.salesValue ?? null,
    litresTruckedOut: f.truckedOut ?? 0,
    litresLeft: left,
    leftAtCost: left != null && perLitre != null ? money(left * perLitre) : null,
    customersOwe: owed,
    customersPaidAhead: paidAhead,
  };
}

/**
 * One place's money still open at a day: what customers owe on its sales and
 * have paid ahead, and — a filling station or LPG plant — the takings it has
 * still to bank, party by party, as the books tag them to it.
 */
async function placeOpen(place, { at }) {
  const [named] = await reports.locationNames([place]);
  const rows = await client`
    SELECT c.system_key, l.party_type, l.party_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN expense_categories c ON c.id = l.account_id
     WHERE (l.location_type || ':' || l.location_id) = ${place} AND e.entry_date <= ${at}::date
       AND c.system_key IN ('customer_receivables', 'trucking_receivables', 'station_takings', 'plant_takings')
     GROUP BY 1, 2, 3`;
  const sumOf = (keys, sign) => money(rows
    .filter((r) => keys.includes(r.system_key) && Math.sign(Number(r.net)) === sign)
    .reduce((t, r) => t + Math.abs(Number(r.net)), 0));
  const receivables = ["customer_receivables", "trucking_receivables"];
  const takings = ["station_takings", "plant_takings"];
  return {
    key: place,
    type: place.split(":")[0],
    id: Number(place.split(":")[1]),
    label: named?.label || place,
    customersOwe: sumOf(receivables, 1),
    customersPaidAhead: sumOf(receivables, -1),
    stillToBank: sumOf(takings, 1),
    bankedAhead: sumOf(takings, -1),
  };
}

/**
 * @param {{ from?: string|null, to?: string|null, pfiId?: number|null, place?: string|null }} p
 *        place as 'station:12', 'depot:3', 'plant:40'
 */
async function report({ from = null, to = null, pfiId = null, place = null } = {}) {
  const today = lagosToday();
  const at = to ? minDay(to, today) : today;
  const dims = pfiId ? { pfiIds: [Number(pfiId)] } : place ? { locations: [place] } : {};
  const whole = !narrowed(dims);
  const chart = await listChart();
  const bankAccounts = chart.filter((a) => a.bankAccountId != null);
  const bankIds = bankAccounts.map((a) => a.id);

  const [status, pl, plByUnit, plByPlace, moves, flow, openingEntry, withDebits] = await Promise.all([
    reports.status(),
    reports.profitAndLoss({ from, to, dims, by: whole ? "pfi" : null }),
    whole ? reports.profitAndLoss({ from, to, by: "unit" }) : null,
    whole ? reports.profitAndLoss({ from, to, by: "location" }) : null,
    bankMovements({ from, to, dims, bankIds }),
    flows({ from, to, dims, chart }),
    require("./opening.service").current(),
    // Banks whose withdrawals have ever been uploaded: for the rest, money
    // out is not on file at all, which is not the same as nought.
    client`SELECT DISTINCT bank_account_id FROM bank_statement_debits`,
  ]);
  const outOnFile = new Set(withDebits.map((r) => Number(r.bank_account_id)));

  const banks = bankAccounts
    .map((a) => {
      const m = moves.get(a.id) || { atStart: 0, moneyIn: 0, moneyOut: 0, atEnd: 0 };
      return { accountId: a.id, bankAccountId: a.bankAccountId, name: a.name, ...m, moneyOutOnFile: outOnFile.has(a.bankAccountId) };
    })
    .filter((b) => b.atStart || b.moneyIn || b.moneyOut || b.atEnd)
    .sort((x, y) => (y.moneyIn + y.moneyOut) - (x.moneyIn + x.moneyOut) || x.name.localeCompare(y.name));
  const sum = (k) => money(banks.reduce((t, b) => t + b[k], 0));

  const segment = (sg, none = "Not tied to a PFI") => ({ key: sg.key, label: sg.key ? sg.label : none, ...profitOf(sg.figures) });
  const out = {
    period: { from, to },
    at,
    pfiId: pfiId ? Number(pfiId) : null,
    place: place || null,
    lastPosted: status.lastPosted,
    /** Until it is, what was held and owed before the books started is missing from what we own and owe. */
    openingPosted: !!openingEntry,
    booksStart: status.booksStart,
    entries: status.entries,
    profit: profitOf(pl.current),
    byPfi: pl.segments ? pl.segments.map((sg) => segment(sg)) : [],
    byUnit: plByUnit?.segments ? plByUnit.segments.map((sg) => ({ ...segment(sg), label: sg.label })) : [],
    byPlace: plByPlace?.segments ? plByPlace.segments.map((sg) => segment(sg, "Not at one place (head office, trucking)")) : [],
    banks,
    bankTotals: { atStart: sum("atStart"), moneyIn: sum("moneyIn"), moneyOut: sum("moneyOut"), atEnd: sum("atEnd") },
    flows: flow,
  };
  if (pfiId) {
    out.cargo = await cargo(Number(pfiId), { at });
  } else if (place) {
    out.placeOpen = await placeOpen(place, { at });
  } else {
    out.position = position(await reports.balanceSheet({ at }));
  }
  return out;
}

module.exports = { report, position, FLOW };
