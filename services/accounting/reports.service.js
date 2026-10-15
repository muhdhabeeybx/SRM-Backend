const { client } = require("../../db");
const { listChart } = require("../../lib/accounting/chart");

/**
 * Reading the general ledger: account balances, one account's lines, the
 * journal. Every figure is a sum of journal_lines — nothing here is stored
 * twice, so the trial balance, an account's ledger and the chart's balance
 * column cannot disagree with each other.
 *
 * Amounts are signed debit-positive internally; each account is shown on its
 * normal side (lib/glAccounts normalSideOf), so a bank reads positive when it
 * holds money and a sales account positive when it has sold.
 */

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Narrowing any report to part of the business (the owner's ask, 14 Oct
 * 2026): which PFIs, which units — depot, trucking, stations, LPG plants,
 * fleet, head office — and which places. Each is a list; empty means all.
 * Applied to the journal lines (alias `l`), so a trial balance, a ledger and a
 * profit and loss narrowed the same way agree with each other.
 *
 * @typedef {{ pfiIds?: number[], units?: string[], locations?: string[] }} Dims
 *          locations as 'station:12', 'depot:3', 'plant:40'
 */
const dimsSql = (dims = {}) => {
  let frag = client``;
  if (dims.pfiIds?.length) frag = client`${frag} AND l.pfi_id = ANY(${dims.pfiIds.map(Number)}::int[])`;
  if (dims.units?.length) frag = client`${frag} AND l.unit = ANY(${dims.units}::text[])`;
  if (dims.locations?.length) frag = client`${frag} AND (l.location_type || ':' || l.location_id) = ANY(${dims.locations}::text[])`;
  return frag;
};

/** Accounts kept party by party — customers, trucking customers, stations, vendors. */
const PARTY_ACCOUNTS = [
  "customer_receivables", "trucking_receivables", "station_takings", "plant_takings",
  "vendor_payables", "supplier_payables", "commissions_payable",
];

/** Labels for the units, as the desks say them. */
const UNITS = [
  { key: "depot", label: "Depot sales" },
  { key: "trucking", label: "Trucking" },
  { key: "stations", label: "Filling stations" },
  { key: "lpg_plants", label: "LPG plants" },
  { key: "fleet", label: "Fleet" },
  { key: "head_office", label: "Head office" },
];

/**
 * Where a journal line came from, as something a screen can open: an order,
 * an expense, a PFI, a station or plant, a trucking customer, a bank. Looked
 * up per kind of source in one query each, however many lines.
 *
 * @returns Map(`${sourceType}|${sourceId}` → { kind, id })
 */
async function linksFor(items) {
  const out = new Map();
  const ids = (type) => [...new Set(items.filter((i) => i.sourceType === type).map((i) => i.sourceId))];
  const put = (type, sourceId, kind, id) => {
    if (id != null) out.set(`${type}|${sourceId}`, { kind, id: Number(id) });
  };
  for (const id of ids("order_sale")) put("order_sale", id, "order", id);
  const lookups = [
    ["order_payment", client`SELECT id, order_id AS ref FROM order_payments WHERE id = ANY(${ids("order_payment").map(Number)}::int[])`, "order"],
    ["order_transfer", client`SELECT id, from_order_id AS ref FROM order_payment_transfers WHERE id = ANY(${ids("order_transfer").map(Number)}::int[])`, "order"],
    ["surplus_delivery", client`SELECT id, order_id AS ref FROM order_surplus_deliveries WHERE id = ANY(${ids("surplus_delivery").map(Number)}::int[])`, "order"],
    ["bank_line", client`SELECT id, bank_account_id AS ref FROM bank_statement_lines WHERE id = ANY(${ids("bank_line").map(Number)}::int[])`, "bank"],
    ["bank_debit", client`SELECT id, bank_account_id AS ref FROM bank_statement_debits WHERE id = ANY(${ids("bank_debit").map(Number)}::int[])`, "bank"],
    ["pfi_surplus", client`SELECT id, pfi_id AS ref FROM pfi_evacuation_surpluses WHERE id = ANY(${ids("pfi_surplus").map(Number)}::int[])`, "pfi"],
    ["pfi_loss", client`SELECT id, pfi_id AS ref FROM pfi_operational_losses WHERE id = ANY(${ids("pfi_loss").map(Number)}::int[])`, "pfi"],
    ["commission_earned", client`SELECT id, order_id AS ref FROM commissions WHERE id = ANY(${ids("commission_earned").map(Number)}::int[])`, "order"],
    ["commission_paid", client`SELECT id, order_id AS ref FROM commissions WHERE id = ANY(${ids("commission_paid").map(Number)}::int[])`, "order"],
  ];
  for (const [type, query, kind] of lookups) {
    if (!ids(type).length) continue;
    for (const r of await query) put(type, String(r.id), kind, r.ref);
  }
  for (const type of ["expense_bill", "expense_paid"]) for (const id of ids(type)) put(type, id, "expense", id);
  for (const id of ids("pfi_purchase")) put("pfi_purchase", id, "pfi", id);
  for (const id of ids("pfi_cogs")) put("pfi_cogs", id, "pfi", String(id).split("|")[0]);
  // Truck sales are keyed by load and customer, or by truck, day and customer.
  for (const id of ids("truck_sale")) {
    const parts = String(id).startsWith("sale:") ? String(id).slice(5).split("::") : String(id).split(":");
    put("truck_sale", id, "delivery_customer", String(id).startsWith("sale:") ? parts[2] : parts[1]);
  }
  // A delivery_sales row: a trucking customer's payment, or a station's or plant's own entry.
  const rowTypes = ["delivery_payment", "station_sale", "station_deposit", "station_spend"];
  const rowIds = [...new Set(rowTypes.flatMap((t) => ids(t)))].map(Number).filter(Number.isFinite);
  if (rowIds.length) {
    const rows = await client`
      SELECT s.id, s.customer_id, dc.customer_type FROM delivery_sales s
        LEFT JOIN delivery_customers dc ON dc.id = s.customer_id
       WHERE s.id = ANY(${rowIds}::int[])`;
    const byRow = new Map(rows.map((r) => [String(r.id), r]));
    for (const type of rowTypes) {
      for (const id of ids(type)) {
        const r = byRow.get(String(id));
        if (!r) continue;
        const kind = r.customer_type === "lpg_plant" ? "plant" : r.customer_type === "filling_station" ? "station" : "delivery_customer";
        put(type, id, kind, r.customer_id);
      }
    }
  }
  return out;
}

/**
 * Every account's movement over a period, and its balance either side.
 *
 * @param {{from?: string, to?: string}} p  Lagos days; open ends mean all time.
 */
async function trialBalance({ from = null, to = null, dims = {} } = {}) {
  const rows = await client`
    SELECT l.account_id,
           COALESCE(SUM(l.debit - l.credit) FILTER (WHERE ${from}::date IS NOT NULL AND e.entry_date < ${from}::date), 0) AS opening,
           COALESCE(SUM(l.debit) FILTER (WHERE (${from}::date IS NULL OR e.entry_date >= ${from}::date)), 0) AS debit,
           COALESCE(SUM(l.credit) FILTER (WHERE (${from}::date IS NULL OR e.entry_date >= ${from}::date)), 0) AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
     WHERE (${to}::date IS NULL OR e.entry_date <= ${to}::date) ${dimsSql(dims)}
     GROUP BY l.account_id`;
  const byAccount = new Map(rows.map((r) => [Number(r.account_id), r]));
  const chart = await listChart();

  const accounts = chart.map((a) => {
    const r = byAccount.get(a.id);
    const opening = money(r?.opening);
    const debit = money(r?.debit);
    const credit = money(r?.credit);
    const closing = money(opening + debit - credit);
    return { ...a, opening, debit, credit, closing };
  });
  // Accounts with no lines and no balance are left to the chart.
  const moving = accounts.filter((a) => a.opening || a.debit || a.credit);
  const totals = moving.reduce(
    (t, a) => ({
      debit: money(t.debit + a.debit),
      credit: money(t.credit + a.credit),
      closingDebit: money(t.closingDebit + Math.max(a.closing, 0)),
      closingCredit: money(t.closingCredit + Math.max(-a.closing, 0)),
    }),
    { debit: 0, credit: 0, closingDebit: 0, closingCredit: 0 },
  );
  return { period: { from, to }, accounts: moving, totals };
}

/** Every account's balance at the end of a day — the chart's balance column. */
async function balancesAt(day = null) {
  const rows = await client`
    SELECT l.account_id, SUM(l.debit - l.credit) AS balance
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE (${day}::date IS NULL OR e.entry_date <= ${day}::date)
     GROUP BY l.account_id`;
  return new Map(rows.map((r) => [Number(r.account_id), money(r.balance)]));
}

/**
 * One account's lines over a period, oldest first, with the balance running
 * from everything before the period — never restarted at it.
 */
async function accountLedger(accountId, { from = null, to = null, partyType = null, partyId = null, dims = {} } = {}) {
  const id = Number(accountId);
  const party = partyType && partyId != null
    ? client`AND l.party_type = ${partyType} AND l.party_id = ${Number(partyId)} ${dimsSql(dims)}`
    : client`${dimsSql(dims)}`;
  const [bf] = await client`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ${id} AND ${from}::date IS NOT NULL AND e.entry_date < ${from}::date ${party}`;
  const lines = await client`
    SELECT l.id, e.id AS entry_id, e.entry_date::text AS day, e.kind, e.source_type, e.source_id, e.memo,
           e.is_late, e.original_date::text AS original_date,
           l.debit::numeric AS debit, l.credit::numeric AS credit,
           l.party_type, l.party_id, l.pfi_id, l.bank_account_id,
           COALESCE(c.name, dc.name, v.name) AS party_name
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      LEFT JOIN customers c ON l.party_type = 'customer' AND c.id = l.party_id
      LEFT JOIN delivery_customers dc ON l.party_type = 'delivery_customer' AND dc.id = l.party_id
      LEFT JOIN vendors v ON l.party_type = 'vendor' AND v.id = l.party_id
     WHERE l.account_id = ${id}
       AND (${from}::date IS NULL OR e.entry_date >= ${from}::date)
       AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)
       ${party}
     ORDER BY e.entry_date, e.id, l.id`;
  let running = Math.round(Number(bf.b) * 100);
  const broughtForward = running / 100;
  const links = await linksFor(lines.map((l) => ({ sourceType: l.source_type, sourceId: l.source_id })));
  const out = lines.map((l) => {
    running += Math.round(Number(l.debit) * 100) - Math.round(Number(l.credit) * 100);
    return {
      id: Number(l.id),
      entryId: Number(l.entry_id),
      day: l.day,
      kind: l.kind,
      sourceType: l.source_type,
      sourceId: l.source_id,
      memo: l.memo,
      isLate: l.is_late,
      originalDate: l.original_date,
      debit: money(l.debit),
      credit: money(l.credit),
      partyType: l.party_type,
      partyId: l.party_id == null ? null : Number(l.party_id),
      partyName: l.party_name || null,
      pfiId: l.pfi_id == null ? null : Number(l.pfi_id),
      bankAccountId: l.bank_account_id == null ? null : Number(l.bank_account_id),
      link: links.get(`${l.source_type}|${l.source_id}`) || null,
      balance: running / 100,
    };
  });
  return { accountId: id, period: { from, to }, broughtForward, lines: out, closing: running / 100 };
}

/** Journal entries over a period, newest first, each with its lines. */
async function journals({ from = null, to = null, kind = null, source = null, late = false, limit = 200, offset = 0, dims = {} } = {}) {
  const entries = await client`
    SELECT e.id, e.entry_date::text AS day, e.kind, e.source_type, e.source_id, e.memo,
           e.is_late, e.original_date::text AS original_date, e.created_at, e.created_by,
           COALESCE(SUM(l.debit), 0) AS amount, COUNT(*) OVER () AS total,
           EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed
      FROM journal_entries e
      JOIN journal_lines l ON l.entry_id = e.id
     WHERE (${from}::date IS NULL OR e.entry_date >= ${from}::date)
       AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)
       AND (${kind}::text IS NULL OR e.kind = ${kind})
       AND (${source}::text IS NULL OR e.source_type = ${source})
       AND (NOT ${late} OR e.is_late)
       AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id ${dimsSql(dims)})
     GROUP BY e.id
     ORDER BY e.entry_date DESC, e.id DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  const ids = entries.map((e) => Number(e.id));
  const lines = ids.length
    ? await client`
        SELECT l.entry_id, l.account_id, c.gl_code, c.name AS account_name,
               l.debit::numeric AS debit, l.credit::numeric AS credit, l.party_type, l.party_id
          FROM journal_lines l JOIN expense_categories c ON c.id = l.account_id
         WHERE l.entry_id = ANY(${ids}::int[])
         ORDER BY l.entry_id, l.debit DESC, l.id`
    : [];
  const byEntry = new Map();
  for (const l of lines) {
    if (!byEntry.has(Number(l.entry_id))) byEntry.set(Number(l.entry_id), []);
    byEntry.get(Number(l.entry_id)).push({
      accountId: Number(l.account_id), code: l.gl_code || "", account: l.account_name,
      debit: money(l.debit), credit: money(l.credit), partyType: l.party_type, partyId: l.party_id == null ? null : Number(l.party_id),
    });
  }
  const links = await linksFor(entries.map((e) => ({ sourceType: e.source_type, sourceId: e.source_id })));
  return {
    total: Number(entries[0]?.total || 0),
    entries: entries.map((e) => ({
      id: Number(e.id), day: e.day, kind: e.kind, sourceType: e.source_type, sourceId: e.source_id, memo: e.memo,
      isLate: e.is_late, originalDate: e.original_date, amount: money(e.amount), createdAt: e.created_at,
      reversed: e.reversed,
      link: links.get(`${e.source_type}|${e.source_id}`) || null,
      lines: byEntry.get(Number(e.id)) || [],
    })),
  };
}

/** When the books were last brought up to date, and from what day they run. */
async function status() {
  const [s] = await client`
    SELECT (SELECT MAX(updated_at) FROM ledger_postings) AS last_posted,
           (SELECT COUNT(*)::int FROM journal_entries) AS entries,
           (SELECT value FROM accounting_settings WHERE key = 'books_start') AS books_start`;
  return { lastPosted: s.last_posted, entries: s.entries, booksStart: s.books_start };
}


// ── The financial statements ──────────────────────────────────────────────

/** Each account's movement over a period, debit-positive. */
async function movements({ from = null, to = null, dims = {} } = {}) {
  const rows = await client`
    SELECT l.account_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE (${from}::date IS NULL OR e.entry_date >= ${from}::date)
       AND (${to}::date IS NULL OR e.entry_date <= ${to}::date) ${dimsSql(dims)}
     GROUP BY l.account_id`;
  return new Map(rows.map((r) => [Number(r.account_id), money(r.net)]));
}

/** The segment a line falls in, for a profit and loss split into columns. */
const SEGMENT = {
  unit: client`COALESCE(l.unit, '')`,
  pfi: client`COALESCE(l.pfi_id::text, '')`,
  location: client`COALESCE(l.location_type || ':' || l.location_id, '')`,
  product: client`COALESCE((SELECT NULLIF(btrim(p.product_name), '') FROM pfis p WHERE p.id = l.pfi_id), '')`,
};

/** Each account's movement over a period, per segment: Map(segment → Map(account → net)). */
async function movementsBy(by, { from = null, to = null, dims = {} } = {}) {
  const rows = await client`
    SELECT ${SEGMENT[by]} AS segment, l.account_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE (${from}::date IS NULL OR e.entry_date >= ${from}::date)
       AND (${to}::date IS NULL OR e.entry_date <= ${to}::date) ${dimsSql(dims)}
     GROUP BY 1, 2`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.segment)) out.set(r.segment, new Map());
    out.get(r.segment).set(Number(r.account_id), money(r.net));
  }
  return out;
}

/** Accounts of some types, with a figure each, under their headings. Empty ones left out. */
function section(chart, figureOf, { types, groups = null, headingIs = null, headingIsNot = null }) {
  const lines = chart
    .filter((a) => types.includes(a.type))
    .filter((a) => !groups || groups.includes(a.group))
    .filter((a) => !headingIs || a.heading === headingIs)
    .filter((a) => !headingIsNot || a.heading !== headingIsNot)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, key: a.systemKey, heading: a.heading || a.groupLabel, amount: figureOf(a) }))
    .filter((l) => Math.abs(l.amount) >= 0.005);
  return { lines, total: money(lines.reduce((t, l) => t + l.amount, 0)) };
}

/**
 * Profit and loss for a period, and for the year to date beside it.
 *
 *   Sales                 income accounts under "Sales"
 *   Cost of sales         product sold, stock losses, cargo costs (5xxx)
 *   Gross profit
 *   Other income          the rest of income — stock gains, other income
 *   Expenses              overheads (6xxx)
 *   Net profit
 *
 * Income reads positive when earned, costs positive when spent.
 */
async function profitAndLoss({ from = null, to = null, dims = {}, by = null } = {}) {
  const chart = await listChart();
  const year = `${(to || from || new Date().toISOString().slice(0, 10)).slice(0, 4)}-01-01`;
  const figures = (m) => {
    const credit = (a) => money(-(m.get(a.id) || 0));
    const debit = (a) => money(m.get(a.id) || 0);
    const sales = section(chart, credit, { types: ["income"], headingIs: "Sales" });
    const costOfSales = section(chart, debit, { types: ["cost_of_sales"] });
    const otherIncome = section(chart, credit, { types: ["income"], headingIsNot: "Sales" });
    const expenses = section(chart, debit, { types: ["expense"] });
    const grossProfit = money(sales.total - costOfSales.total);
    return { sales, costOfSales, grossProfit, otherIncome, expenses, netProfit: money(grossProfit + otherIncome.total - expenses.total) };
  };
  const result = {
    period: { from, to },
    yearToDate: { from: year, to },
    current: figures(await movements({ from, to, dims })),
    year: figures(await movements({ from: year, to, dims })),
  };
  if (by && SEGMENT[by]) {
    // The same profit and loss, one column per unit, PFI or place.
    const split = await movementsBy(by, { from, to, dims });
    const labels = await segmentLabels(by, [...split.keys()]);
    result.segments = [...split]
      .map(([key, m]) => ({ key, label: labels.get(key) || "Not tagged", figures: figures(m) }))
      .filter((sgm) => sgm.figures.sales.total || sgm.figures.costOfSales.total || sgm.figures.otherIncome.total || sgm.figures.expenses.total)
      .sort((x, y) => y.figures.sales.total - x.figures.sales.total || x.label.localeCompare(y.label));
  }
  return result;
}

/** What each segment is called on screen. */
async function segmentLabels(by, keys) {
  const out = new Map();
  if (by === "unit") for (const u of UNITS) out.set(u.key, u.label);
  if (by === "pfi") {
    const ids = keys.filter(Boolean).map(Number);
    if (ids.length) for (const p of await client`SELECT id, pfi_number FROM pfis WHERE id = ANY(${ids}::int[])`) out.set(String(p.id), p.pfi_number);
  }
  if (by === "location") for (const l of await locationNames(keys.filter(Boolean))) out.set(l.key, l.label);
  if (by === "product") for (const k of keys.filter(Boolean)) out.set(k, k);
  return out;
}

/** 'station:12' → the station's name, 'depot:3' → the depot's. */
async function locationNames(keys) {
  const ids = (type) => keys.filter((k) => k.startsWith(`${type}:`)).map((k) => Number(k.split(":")[1]));
  const out = [];
  const depots = ids("depot");
  if (depots.length) for (const d of await client`SELECT id, name FROM depots WHERE id = ANY(${depots}::int[])`) out.push({ key: `depot:${d.id}`, type: "depot", label: d.name });
  const people = [...ids("station"), ...ids("plant")];
  if (people.length) {
    for (const c of await client`SELECT id, name, customer_type FROM delivery_customers WHERE id = ANY(${people}::int[])`) {
      const type = c.customer_type === "lpg_plant" ? "plant" : "station";
      out.push({ key: `${type}:${c.id}`, type, label: c.name });
    }
  }
  return out;
}

/** What the reports can be narrowed by: the units, and every PFI and place the books carry. */
async function dimensions() {
  const pfis = await client`
    SELECT p.id, p.pfi_number, p.status::text AS status FROM pfis p
     WHERE EXISTS (SELECT 1 FROM journal_lines l WHERE l.pfi_id = p.id)
     ORDER BY p.id DESC`;
  const places = await client`SELECT DISTINCT location_type || ':' || location_id AS key FROM journal_lines WHERE location_type IS NOT NULL`;
  const locations = (await locationNames(places.map((r) => r.key))).sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
  return {
    units: UNITS,
    pfis: pfis.map((p) => ({ id: Number(p.id), label: p.pfi_number, status: p.status })),
    locations,
  };
}

/**
 * The balance sheet at the end of a day. Profit not yet closed into retained
 * earnings is shown in equity as "Profit to date", so assets always equal
 * liabilities plus equity.
 */
async function balanceSheet({ at = null, dims = {} } = {}) {
  const chart = await listChart();
  const m = await movements({ to: at, dims });

  // Accounts kept party by party. A customer who has paid ahead is not a
  // smaller receivable — it is money of theirs we hold — and a vendor paid in
  // advance is not a smaller payable but something owed to us. So these are
  // added up party by party and each side printed where it belongs.
  const byParty = await client`
    SELECT l.account_id, SUM(l.debit - l.credit) AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE (${at}::date IS NULL OR e.entry_date <= ${at}::date) ${dimsSql(dims)}
       AND l.account_id IN (SELECT id FROM expense_categories WHERE system_key = ANY(${PARTY_ACCOUNTS}))
     GROUP BY l.account_id, l.party_type, l.party_id`;
  const split = new Map();
  for (const r of byParty) {
    const id = Number(r.account_id);
    const x = split.get(id) || { dr: 0, cr: 0 };
    const n = money(r.net);
    if (n > 0) x.dr = money(x.dr + n);
    else x.cr = money(x.cr - n);
    split.set(id, x);
  }
  const debitOf = (a) => (split.has(a.id) ? split.get(a.id).dr : money(m.get(a.id) || 0));
  const creditOf = (a) => (split.has(a.id) ? split.get(a.id).cr : money(-(m.get(a.id) || 0)));

  const assets = section(chart, debitOf, { types: ["asset"] });
  const liabilities = section(chart, creditOf, { types: ["liability"] });
  // The other side of each party account, where it has one.
  const aheadLine = (key, label, side) => {
    const a = chart.find((x) => x.systemKey === key);
    const v = a && split.get(a.id) ? split.get(a.id)[side] : 0;
    return v >= 0.005 ? { id: a.id, code: a.code, name: label, heading: "Paid ahead", amount: v } : null;
  };
  const heldForCustomers = [
    aheadLine("customer_receivables", "Paid ahead by depot customers", "cr"),
    aheadLine("trucking_receivables", "Paid ahead by trucking customers", "cr"),
    aheadLine("station_takings", "Banked ahead by filling stations", "cr"),
    aheadLine("plant_takings", "Banked ahead by LPG plants", "cr"),
  ].filter(Boolean);
  const paidAheadToVendors = [
    aheadLine("vendor_payables", "Paid ahead to vendors", "dr"),
    aheadLine("supplier_payables", "Paid ahead to cargo suppliers", "dr"),
    aheadLine("commissions_payable", "Commission paid ahead", "dr"),
  ].filter(Boolean);
  assets.lines.push(...paidAheadToVendors);
  assets.total = money(assets.total + paidAheadToVendors.reduce((t, l) => t + l.amount, 0));
  liabilities.lines.push(...heldForCustomers);
  liabilities.total = money(liabilities.total + heldForCustomers.reduce((t, l) => t + l.amount, 0));

  const equity = section(chart, (a) => money(-(m.get(a.id) || 0)), { types: ["equity"] });
  const profit = money(
    chart.filter((a) => a.type === "income").reduce((t, a) => t + money(-(m.get(a.id) || 0)), 0)
    - chart.filter((a) => a.type === "cost_of_sales" || a.type === "expense").reduce((t, a) => t + money(m.get(a.id) || 0), 0),
  );
  const equityTotal = money(equity.total + profit);
  return {
    at,
    assets,
    liabilities,
    equity: { ...equity, profitToDate: profit, total: equityTotal },
    totalLiabilitiesAndEquity: money(liabilities.total + equityTotal),
    difference: money(assets.total - liabilities.total - equityTotal),
  };
}

/**
 * Cash flow, the direct way: every naira into or out of a bank account over
 * the period, by what was on the other side of the entry.
 *
 *   operating   customers, stations, vendors, money not yet matched — the
 *               default
 *   investing   trucks, equipment and the like (cash_flow_class)
 *   financing   loans and capital
 *
 * Money moved between two of our own banks is in no class: it is not a flow.
 * Opening cash plus the three totals is closing cash, always.
 */
async function cashFlow({ from = null, to = null, dims = {} } = {}) {
  const chart = await listChart();
  const byId = new Map(chart.map((a) => [a.id, a]));
  const isBank = (id) => byId.get(id)?.bankAccountId != null;
  const banks = chart.filter((a) => a.bankAccountId != null).map((a) => a.id);

  /** Cash in every bank before a day; with no day, all of it. */
  const cashBefore = async (day) => {
    const [r] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0) AS c
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ANY(${banks}::int[]) AND (${day}::date IS NULL OR e.entry_date < ${day}::date) ${dimsSql(dims)}`;
    return money(r.c);
  };

  // Every line of every entry in the period that touched a bank.
  const lines = await client`
    SELECT l.entry_id, l.account_id, (l.debit - l.credit)::numeric AS net
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE (${from}::date IS NULL OR e.entry_date >= ${from}::date)
       AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)
       AND l.entry_id IN (SELECT l.entry_id FROM journal_lines l WHERE l.account_id = ANY(${banks}::int[]) ${dimsSql(dims)})`;
  const byEntry = new Map();
  for (const l of lines) {
    if (!byEntry.has(Number(l.entry_id))) byEntry.set(Number(l.entry_id), []);
    byEntry.get(Number(l.entry_id)).push({ account: Number(l.account_id), net: Number(l.net) });
  }

  // The other side of each entry carries its bank movement: money in is the
  // credit on the other side, money out the debit.
  const flows = new Map();
  let internal = 0;
  for (const ls of byEntry.values()) {
    const others = ls.filter((l) => !isBank(l.account));
    if (!others.length) {
      internal += ls.filter((l) => l.net > 0).reduce((t, l) => t + l.net, 0);
      continue;
    }
    for (const o of others) {
      const a = byId.get(o.account);
      const cls = a?.cashFlowClass || "operating";
      const key = `${cls}|${o.account}`;
      flows.set(key, (flows.get(key) || 0) - o.net);
    }
  }
  const classes = ["operating", "investing", "financing"].map((cls) => {
    const rows = [...flows]
      .filter(([k]) => k.startsWith(`${cls}|`))
      .map(([k, v]) => {
        const a = byId.get(Number(k.split("|")[1]));
        return { id: a?.id, code: a?.code || "", name: a?.name || "", key: a?.systemKey || null, amount: money(v) };
      })
      .filter((r) => Math.abs(r.amount) >= 0.005)
      .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
    return {
      class: cls,
      lines: rows,
      inflow: money(rows.filter((r) => r.amount > 0).reduce((t, r) => t + r.amount, 0)),
      outflow: money(rows.filter((r) => r.amount < 0).reduce((t, r) => t - r.amount, 0)),
      net: money(rows.reduce((t, r) => t + r.amount, 0)),
    };
  });
  const opening = from ? await cashBefore(from) : 0;
  const closing = await cashBefore(to ? nextDay(to) : null);
  const netChange = money(classes.reduce((t, c) => t + c.net, 0));
  return {
    period: { from, to },
    openingCash: opening,
    classes,
    movedBetweenOwnBanks: money(internal),
    netChange,
    closingCash: closing,
    /** Opening + net change − closing: nought, always. */
    difference: money(opening + netChange - closing),
  };
}

const nextDay = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

module.exports = { linksFor, trialBalance, balancesAt, accountLedger, journals, status, profitAndLoss, balanceSheet, cashFlow, dimensions, locationNames, UNITS };
