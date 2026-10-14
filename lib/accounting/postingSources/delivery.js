const { sql } = require("drizzle-orm");
const { deliveryInventoryRepo, deliverySaleRepo, deliveryCustomerRepo } = require("../../../repositories");
const { matchSalesByRecord, buildLoadSplit, shareMoney, normalizePlate } = require("../../deliveryBatches");
const { isNewBatch } = require("../../deliveryBook");
const { localDateStr } = require("../../zonedDay");

/**
 * Truck sales, filling stations and LPG plants in the general ledger — read
 * with the very helpers Delivery Inventory and the daily report use
 * (lib/deliveryBatches), so a load is worth here what it is worth there.
 *
 *   truck_sale         a trucking customer's share of a load, at what the
 *                      Sales Ledger values it (shareMoney), on the day it loaded:
 *                        Dr Trucking receivables / Cr Sales – trucking
 *                      and the litres it took, costed by pfis.js (pfi_cogs)
 *   delivery_payment   money a trucking customer paid against a truck:
 *                        Dr the bank (off a statement) or Suspense (typed in)
 *                        Cr Trucking receivables
 *   delivery_transfer  an overpayment moved between trucks — its legs together.
 *   station_sale       a filling station's or LPG plant's own entries
 *   station_deposit    (lib/deliveryBook — not its Sales Ledger rows, which
 *   station_spend      carry no money), each purpose booked on its own:
 *                        a day's pump sales  Dr Station (or plant) takings
 *                                            Cr Sales – stations (or LPG plants)
 *                                            (its litres costed by pfi_cogs)
 *                        a deposit           Dr the bank or Suspense / Cr takings
 *                        spent from takings  Dr Station running costs — POS
 *                                            charges to Bank charges — Cr takings
 *
 * A load sent to our own station is stock moving between our own tanks, not a
 * sale: its Sales Ledger value is not booked. The station's own pump sales
 * are the sale.
 */

const toNum = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const idKey = (v) => (v === null || v === undefined ? "" : String(v));
const isStation = (c) => c?.customerType === "filling_station" || c?.customerType === "lpg_plant";
const POS_CHARGES_NOTE = "POS charges";

/** A row's day, as the station pages and Sales Ledger read it. */
const dayOf = (value) => {
  if (!value) return "";
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : localDateStr(d);
};

/**
 * Every load, every row and every customer, read once per run and shared by
 * the four sources below. Through JSON, so values arrive as the dashboard
 * receives them, as the daily report does.
 */
async function delivery(ctx, db) {
  if (ctx.delivery) return ctx.delivery;
  const everyRow = async (fetchPage, pick) => {
    const out = [];
    for (let page = 1; ; page += 1) {
      const rows = pick(await fetchPage({ page, limit: 1000 })) || [];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };
  const apiShape = (rows) => JSON.parse(JSON.stringify(rows));
  const [entries, sales, customers] = (
    await Promise.all([
      everyRow((q) => deliveryInventoryRepo.findAll(q), (r) => r.loadings),
      everyRow((q) => deliverySaleRepo.findAll(q), (r) => r.sales),
      everyRow((q) => deliveryCustomerRepo.findAll(q), (r) => r.customers),
    ])
  ).map(apiShape);

  const pfis = (await db.execute(sql`SELECT id, allocation_code, location_id FROM pfis`));
  const pfiRows = pfis.rows ?? pfis;
  const depotOfPfi = new Map(pfiRows.filter((p) => p.location_id != null).map((p) => [Number(p.id), Number(p.location_id)]));
  const codeKey = (code) => String(code || "").trim().toUpperCase();
  const pfiOfCode = new Map(pfiRows.filter((p) => p.allocation_code)
    .map((p) => [codeKey(p.allocation_code), Number(p.id)]));
  // A code no PFI carries as its own still names a cargo when the loads sent
  // out under it do — an LPG plant's PFI-33B is the batch of PFI/33 that went
  // to Kano, and the plant's own rows carry that code. Only where every such
  // load names the same PFI.
  const fromLoads = new Map();
  for (const e of entries) {
    const code = codeKey(e.allocationCode);
    if (!code || pfiOfCode.has(code)) continue;
    const pfiId = e.pfiId == null ? null : Number(e.pfiId);
    fromLoads.set(code, fromLoads.has(code) && fromLoads.get(code) !== pfiId ? null : pfiId);
  }
  for (const [code, pfiId] of fromLoads) if (pfiId) pfiOfCode.set(code, pfiId);
  const statementBanks = await db.execute(sql`
    SELECT l.id, l.bank_account_id FROM bank_statement_lines l
     WHERE EXISTS (SELECT 1 FROM delivery_sales s WHERE s.statement_line_id = l.id)`);
  const bankOfLine = new Map((statementBanks.rows ?? statementBanks).map((l) => [Number(l.id), Number(l.bank_account_id)]));

  ctx.delivery = {
    entries: entries.filter((e) => !!(e.truckId || e.truckNumber || e.loadingStatus)),
    sales,
    customers: new Map(customers.map((c) => [idKey(c.id), c])),
    depotOfPfi,
    pfiOfCode,
    bankOfLine,
  };
  return ctx.delivery;
}

/** The PFI a row belongs to, by its batch code. */
const pfiOfRow = (row, d) => d.pfiOfCode.get(String(row.allocationCode || "").trim().toUpperCase()) ?? null;
/** The depot a cargo was loaded at — where a truck sale comes from. */
const depotOf = (pfiId, d) => (pfiId && d.depotOfPfi.has(Number(pfiId)) ? ["depot", d.depotOfPfi.get(Number(pfiId))] : null);

/** Where a payment row's money is: its statement line's bank, else Suspense with the bank it names. */
function moneyIn(row, d) {
  const lineBank = row.statementLineId != null ? d.bankOfLine.get(Number(row.statementLineId)) : null;
  if (lineBank) return { key: `bank:${lineBank}`, bankAccountId: lineBank };
  const typed = row.bankAccountId == null ? null : Number(row.bankAccountId);
  return { key: "suspense", bankAccountId: typed };
}

async function truckSales(db, ctx) {
  if (ctx.truckSales) return ctx.truckSales;
  const d = await delivery(ctx, db);
  const ledgerRows = d.sales.filter((s) => s.readBook !== "station");
  const byLoad = matchSalesByRecord(d.entries, ledgerRows);
  const claimed = new Set([...byLoad.values()].flat().map((s) => idKey(s.id)));
  const records = [];

  for (const entry of d.entries) {
    const rows = byLoad.get(idKey(entry.id)) || [];
    const assignedTo = entry.customerId ? d.customers.get(idKey(entry.customerId)) : null;
    const split = buildLoadSplit(entry, rows, d.customers);
    // Priced the way Delivery Inventory prices it (summariseBatches).
    const deskOnly = isStation(assignedTo) && isNewBatch(entry.allocationCode);
    const fromRows = rows.reduce((mx, s) => Math.max(mx, toNum(s.rate)), 0);
    const rate = deskOnly ? fromRows : fromRows > 0 ? fromRows : toNum(entry.rate);
    // A truck assigned to a customer with nothing yet entered against it is
    // still theirs, at its rate.
    const shares = split.shares.length
      ? split.shares
      : entry.customerId
        ? [{ customerId: idKey(entry.customerId), quantity: split.total, rate: 0, isFillingStation: isStation(assignedTo), payments: [], totalPaid: 0 }]
        : [];
    for (const share of shares) {
      const customer = d.customers.get(idKey(share.customerId));
      if (!share.customerId || isStation(customer)) continue;
      const value = shareMoney(share, rate).expected;
      const date = dayOf(entry.dateAllocated) || dayOf(share.payments[0]?.dateLoaded) || dayOf(entry.createdAt);
      records.push({
        id: `${entry.id}:${share.customerId}`,
        date,
        unit: "trucking",
        pfiId: entry.pfiId ?? null,
        location: depotOf(entry.pfiId, d),
        memo: `Truck ${entry.truckNumber || ""} sold to ${customer?.name || "a customer"}`.replace(/\s+/g, " "),
        lines: [
          { key: "trucking_receivables", debit: value, party: ["delivery_customer", Number(share.customerId)] },
          { key: "sales_trucking", credit: value },
        ],
        sold: entry.pfiId ? [{ pfiId: Number(entry.pfiId), litres: toNum(share.quantity) }] : [],
      });
    }
  }

  // Rows no load claims: grouped by truck, day, customer and destination, as
  // the Sales Ledger groups them, at the largest value they carry.
  const loose = new Map();
  for (const s of ledgerRows) {
    if (claimed.has(idKey(s.id))) continue;
    const customer = d.customers.get(idKey(s.customerId));
    if (!s.customerId || isStation(customer)) continue;
    const key = [normalizePlate(s.truckNumber), dayOf(s.dateLoaded), idKey(s.customerId), String(s.location || "").trim().toLowerCase()].join("::");
    if (!loose.has(key)) loose.set(key, []);
    loose.get(key).push(s);
  }
  for (const [key, rows] of loose) {
    const value = rows.reduce((mx, s) => Math.max(mx, toNum(s.salesValue)), 0);
    const first = rows[0];
    const pfiId = d.pfiOfCode.get(String(first.allocationCode || "").trim().toUpperCase());
    records.push({
      id: `sale:${key}`,
      date: dayOf(first.dateLoaded) || dayOf(first.dateOfPayment) || dayOf(first.createdAt),
      unit: "trucking",
      pfiId: pfiId ?? null,
      location: depotOf(pfiId, d),
      memo: `Truck ${first.truckNumber || ""} sold to ${first.customerName || "a customer"}`.replace(/\s+/g, " "),
      lines: [
        { key: "trucking_receivables", debit: value, party: ["delivery_customer", Number(first.customerId)] },
        { key: "sales_trucking", credit: value },
      ],
      sold: pfiId ? [{ pfiId: Number(pfiId), litres: rows.reduce((mx, s) => Math.max(mx, toNum(s.quantity)), 0) }] : [],
    });
  }
  ctx.truckSales = records;
  return records;
}

async function truckPayments(db, ctx) {
  const d = await delivery(ctx, db);
  return d.sales
    .filter((s) => s.readBook !== "station" && !s.transferGroupId && toNum(s.paymentAmount) !== 0)
    .filter((s) => !isStation(d.customers.get(idKey(s.customerId))))
    .map((s) => {
      const amount = toNum(s.paymentAmount);
      const to = moneyIn(s, d);
      const pfiId = pfiOfRow(s, d);
      return {
        id: String(s.id),
        date: dayOf(s.dateOfPayment) || dayOf(s.createdAt),
        unit: "trucking",
        pfiId,
        location: depotOf(pfiId, d),
        memo: `Payment for truck ${s.truckNumber || ""}${s.payerName ? ` by ${s.payerName}` : ""}`.replace(/\s+/g, " "),
        lines: [
          { key: to.key, debit: amount, bankAccountId: to.bankAccountId },
          { key: "trucking_receivables", credit: amount, party: s.customerId ? ["delivery_customer", Number(s.customerId)] : null },
        ],
      };
    });
}

async function truckTransfers(db, ctx) {
  const d = await delivery(ctx, db);
  const groups = new Map();
  for (const s of d.sales) {
    if (!s.transferGroupId || toNum(s.paymentAmount) === 0) continue;
    if (!groups.has(s.transferGroupId)) groups.set(s.transferGroupId, []);
    groups.get(s.transferGroupId).push(s);
  }
  return [...groups].map(([group, legs]) => ({
    id: String(group),
    date: dayOf(legs[0].dateOfPayment) || dayOf(legs[0].createdAt),
    memo: "Overpayment moved between trucks",
    unit: "trucking",
    // Each leg as it is stored: a negative leg is money taken off that truck.
    lines: legs.map((s) => ({
      key: isStation(d.customers.get(idKey(s.customerId)))
        ? (d.customers.get(idKey(s.customerId)).customerType === "lpg_plant" ? "plant_takings" : "station_takings")
        : "trucking_receivables",
      credit: toNum(s.paymentAmount),
      party: s.customerId ? ["delivery_customer", Number(s.customerId)] : null,
    })).map((l) => (l.credit < 0 ? { ...l, debit: -l.credit, credit: 0 } : l)),
  }));
}

/**
 * A station's or plant's own rows, each purpose its own record — a day's
 * sales, a deposit, money spent from takings — so every entry says one thing
 * and the cash flow can tell money banked from money earned.
 */
async function stationParts(db, ctx) {
  if (ctx.stationParts) return ctx.stationParts;
  const d = await delivery(ctx, db);
  const out = { sale: [], deposit: [], spend: [] };
  for (const s of d.sales) {
    const customer = d.customers.get(idKey(s.customerId));
    if (!isStation(customer) || s.readBook === "trucking" || s.transferGroupId) continue;
    const plant = customer.customerType === "lpg_plant";
    const takings = plant ? "plant_takings" : "station_takings";
    const party = ["delivery_customer", Number(s.customerId)];
    const date = dayOf(s.dateOfPayment) || dayOf(s.dateLoaded) || dayOf(s.createdAt);
    // Whose books these are: the station's or plant's own, under its cargo.
    const about = {
      unit: plant ? "lpg_plants" : "stations",
      location: [plant ? "plant" : "station", Number(s.customerId)],
      pfiId: pfiOfRow(s, d),
    };
    const sold = toNum(s.salesValue);
    if (sold > 0) {
      out.sale.push({
        id: String(s.id), date, ...about, memo: `${customer.name}: sales`,
        lines: [
          { key: takings, debit: sold, party },
          { key: plant ? "sales_plants" : "sales_stations", credit: sold },
        ],
        sold: about.pfiId ? [{ pfiId: Number(about.pfiId), litres: toNum(s.quantity) }] : [],
      });
    }
    const banked = toNum(s.paymentAmount);
    if (banked !== 0) {
      const to = moneyIn(s, d);
      out.deposit.push({
        id: String(s.id), date, ...about, memo: `${customer.name}: deposit`,
        lines: [{ key: to.key, debit: banked, bankAccountId: to.bankAccountId }, { key: takings, credit: banked, party }],
      });
    }
    const spent = toNum(s.expensesAmount);
    if (spent !== 0) {
      const pos = String(s.remarks || "").trim() === POS_CHARGES_NOTE;
      out.spend.push({
        id: String(s.id), date, ...about, memo: `${customer.name}: ${pos ? "POS charges" : "spent from takings"}`,
        lines: [{ key: pos ? "bank_charges" : "station_running_costs", debit: spent }, { key: takings, credit: spent, party }],
      });
    }
  }
  ctx.stationParts = out;
  return out;
}

module.exports = [
  { type: "truck_sale", load: truckSales, sells: true },
  { type: "delivery_payment", load: truckPayments },
  { type: "delivery_transfer", load: truckTransfers },
  { type: "station_sale", load: async (db, ctx) => (await stationParts(db, ctx)).sale, sells: true },
  { type: "station_deposit", load: async (db, ctx) => (await stationParts(db, ctx)).deposit },
  { type: "station_spend", load: async (db, ctx) => (await stationParts(db, ctx)).spend },
];
