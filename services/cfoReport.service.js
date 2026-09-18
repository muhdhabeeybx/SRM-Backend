const { cfoReportRepo } = require("../repositories");
const { REPORT_TZ } = require("./dailyCombinedReport.service");

/**
 * The CFO report: what each PFI sold, what it has left, and whether the
 * money agrees — one sheet per day.
 *
 * ── The question it answers ────────────────────────────────────────────────
 *
 * The finance report answers "which bank line paid for which order". The PFI
 * page answers "how is this cargo doing overall". Neither answers the one the
 * CFO asks at the end of a day, across every depot at once: for each PFI we
 * are trading, what went out today, what is left in the tank, what it has
 * come to in naira, and is that money in the bank.
 *
 * So the unit is the PFI-day. Each row is one PFI on one date, each block is
 * one date, and the blocks run in order down the page.
 *
 * ── Where every column comes from ──────────────────────────────────────────
 *
 *   Initial qty      pfis.starting_qty_litres — the MEASURED tank figure, not
 *                    the BL. You sell what landed, not what the papers said,
 *                    so the stock balance has to run off the tank or it will
 *                    never agree with a dip. (The BL is what the cargo is
 *                    COSTED on; that is the PFI page's job, not this one's.)
 *
 *   Cumulative       Litres on every confirmed order placed against the PFI
 *   sales volume     on or before this date. "Confirmed" means
 *                    payment_status = 'Paid' — the same rule the PFI page and
 *                    the finance report use, so the three reconcile by
 *                    construction. See SALE in the repository.
 *
 *   Sales volume     The same, restricted to orders placed on this date.
 *   for the day
 *
 *   Stock balance    Initial qty − cumulative sales volume. Derived, always.
 *
 *   Sales value      Invoiced value of the same orders the cumulative volume
 *   to date          counts. Same cohort, so litres and naira can never tell
 *                    different stories.
 *
 *   Bank inflow      Money received against those orders, on or before this
 *   confirmed        date, netted for surplus transferred between orders. See
 *                    PAYMENT_DAY in the repository for which day a payment
 *                    counts on, and why it is not simply the bank's date.
 *
 *   Surplus /        Bank inflow − sales value. Derived, always. Positive is
 *   deficit          money held beyond what was invoiced; negative is money
 *                    still owed on sales already booked.
 *
 *   Remarks          Typed. Never computed.
 *
 * ── Two figures are derived and cannot be typed over ───────────────────────
 *
 * Stock balance and surplus/deficit are recomputed from whatever the other
 * cells hold, override or not. A sheet on which the numbers in a row do not
 * add up to the number at the end of it is worse than one carrying a figure
 * somebody disagrees with — it is the one defect an audit document cannot
 * survive. Correct an input; the answer follows.
 *
 * ── It reads today's book, cut off at the date ─────────────────────────────
 *
 * A row for 15 September counts orders placed on or before the 15th, using
 * their status as it stands NOW. An order placed on the 15th and confirmed on
 * the 17th is therefore a 15 September sale on a report run today, and was
 * not one on a report run on the 16th. That is deliberate — the alternative
 * needs payment_confirmed_at, which 801 confirmed orders do not have — but it
 * means the computed figures for a past day can still move. Anything typed
 * into the sheet does not: an override is stored against its date and is the
 * report's memory of what was signed off.
 */

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * "Liters" and "Litres" are the same unit spelled two ways — 7 PFIs use
 * the first, 37 the second. Totalling them separately would print two litre
 * columns that each hold half the answer.
 */
const normaliseUnit = (unit) => {
  const u = String(unit || "").trim();
  if (/^lit(re|er)s?$/i.test(u)) return "Litres";
  return u || "Litres";
};

/** "2026-09-17" from whatever the driver handed back for a `date` column. */
const dayKey = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
};

/**
 * Every calendar day in a closed range, oldest first.
 *
 * Built by stepping UTC dates over a date-only string, which has no timezone
 * in it to get wrong — the zone was already applied in SQL when the rows were
 * bucketed, and applying it a second time here is how a report ends up one
 * day out at one end.
 */
const daysBetween = (from, to) => {
  const out = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // A malformed range must not spin forever. 400 days is longer than any
    // report anyone wants and short enough to fail obviously.
    if (out.length > 400) break;
  }
  return out;
};

/** An empty bucket, so no accumulator ever has to check for undefined. */
const emptyBucket = () => ({ qty: 0, value: 0, orders: 0, inflow: 0, statementInflow: 0 });

/**
 * Should this PFI appear on this day's sheet?
 *
 * The honest reading of "the active PFIs for that day", built from the orders
 * rather than from pfis.pfi_date or pfis.closure_date — see tradingSpan in the
 * repository for why those two columns cannot carry it.
 *
 *   * A PFI that sold ANYTHING on the day is always listed. Whatever else
 *     is true of it, it traded.
 *   * Before its first confirmed sale it is not listed. There is nothing to
 *     report and a row of zeroes against a cargo that had not arrived reads
 *     as a PFI that failed to sell.
 *   * A PFI still open — active, or not yet started — stays listed after
 *     its last sale. Stock sitting in a tank with nothing moving is precisely
 *     what a CFO wants to see.
 *   * A finished PFI drops off after its last trading day, or after its
 *     closure date where one is recorded and is later.
 */
const isListed = ({ day, pfi, span, dayQty, includeAll }) => {
  const first = span?.firstDay;
  if (!first) return false;
  if (day < first) return false;
  if (includeAll) return true;
  if (dayQty !== 0) return true;
  if (pfi.status === "active" || pfi.status === "not_started") return true;
  const closes = pfi.closureDay && pfi.closureDay > span.lastDay ? pfi.closureDay : span.lastDay;
  return day <= closes;
};

/**
 * Fold a row into a totals accumulator.
 *
 * Money totals are plain sums — naira is naira. Quantities are kept per unit,
 * because the book holds litres and kilogrammes side by side (3 LPG PFIs
 * against 44 fuel ones) and adding 160,000 kg to 26,992,931 L produces a
 * number that is not a quantity of anything.
 */
const addToTotals = (totals, row) => {
  totals.rows += 1;
  totals.salesValue = round2(totals.salesValue + row.salesValue);
  totals.bankInflow = round2(totals.bankInflow + row.bankInflow);
  totals.surplusDeficit = round2(totals.surplusDeficit + row.surplusDeficit);
  totals.orders += row.orders;
  totals.dayOrders += row.dayOrders;

  const unit = row.productUnit;
  const q = totals.byUnit[unit] || (totals.byUnit[unit] = {
    unit, initialQty: 0, cumulativeVolume: 0, dayVolume: 0, stockBalance: 0,
  });
  q.initialQty = round2(q.initialQty + row.initialQty);
  q.cumulativeVolume = round2(q.cumulativeVolume + row.cumulativeVolume);
  q.dayVolume = round2(q.dayVolume + row.dayVolume);
  q.stockBalance = round2(q.stockBalance + row.stockBalance);
  return totals;
};

const emptyTotals = () => ({
  rows: 0, salesValue: 0, bankInflow: 0, surplusDeficit: 0,
  orders: 0, dayOrders: 0, byUnit: {},
});

/**
 * One row: the computed figures, the overrides, and the effective values the
 * sheet actually prints.
 *
 * All three are returned, never just the last. The screen marks an overridden
 * cell and shows what the system said underneath it, which is the difference
 * between a correction and a figure nobody can account for — the same reason
 * reportActuals.service shows its numbers beside what is typed rather than
 * over it.
 */
const buildRow = ({ pfi, day, running, dayBucket, entry, editorName }) => {
  const computed = {
    initialQty: round2(pfi.startingQty),
    cumulativeVolume: round2(running.qty),
    dayVolume: round2(dayBucket.qty),
    salesValue: round2(running.value),
    bankInflow: round2(running.inflow),
    /** Of that inflow, how much a bank statement line stands behind. */
    statementInflow: round2(running.statementInflow),
  };
  computed.stockBalance = round2(computed.initialQty - computed.cumulativeVolume);
  computed.surplusDeficit = round2(computed.bankInflow - computed.salesValue);

  // `!= null`, so an override of 0 is honoured and a missing one is not.
  const pick = (field) => (entry && entry[field] != null ? round2(Number(entry[field])) : computed[field]);

  const initialQty = pick("initialQty");
  const cumulativeVolume = pick("cumulativeVolume");
  const dayVolume = pick("dayVolume");
  const salesValue = pick("salesValue");
  const bankInflow = pick("bankInflow");

  const edited = ["initialQty", "cumulativeVolume", "dayVolume", "salesValue", "bankInflow"]
    .filter((f) => entry && entry[f] != null);

  return {
    pfiId: pfi.id,
    pfiNumber: pfi.pfiNumber,
    locationName: pfi.locationName,
    productName: pfi.productName,
    productUnit: pfi.productUnit,
    status: pfi.status,
    pfiType: pfi.pfiType,
    date: day,

    initialQty,
    cumulativeVolume,
    dayVolume,
    salesValue,
    bankInflow,
    // Derived from the EFFECTIVE values above, so the printed row adds up
    // whether or not anybody has corrected it. See the header.
    stockBalance: round2(initialQty - cumulativeVolume),
    surplusDeficit: round2(bankInflow - salesValue),

    orders: running.orders,
    dayOrders: dayBucket.orders,

    computed,
    edited,
    remarks: entry?.remarks || "",
    updatedBy: entry?.updatedBy ?? null,
    updatedByName: editorName || null,
    updatedAt: entry?.updatedAt || null,
  };
};

/**
 * The whole report.
 *
 * Four grouped queries plus the overrides, not one query per day: a month of
 * twelve PFIs is 360 rows, and issuing a query each would be 360 round
 * trips for figures that are a running total of the same two aggregates.
 * Opening balances come back as their own rows (`day` null) so a report
 * starting mid-life shows the PFI where it actually stands.
 */
const build = async ({
  dateFrom,
  dateTo,
  depotId = null,
  pfiId = null,
  includeAll = false,
  scopeUser = null,
  tz = REPORT_TZ,
} = {}) => {
  const from = String(dateFrom).slice(0, 10);
  const to = String(dateTo).slice(0, 10);
  const days = daysBetween(from, to);

  // Scope first: everything downstream is filtered by PFI id, so a scoped
  // user's report is narrowed in SQL rather than trimmed afterwards.
  const scoped = await cfoReportRepo.visiblePfiIds(scopeUser);
  let pfiIds = scoped;
  if (pfiId) {
    const only = Number(pfiId);
    pfiIds = scoped && !scoped.includes(only) ? [] : [only];
  }

  const allPfis = (await cfoReportRepo.listPfis({ pfiIds })).map((b) => ({
    id: Number(b.id),
    pfiNumber: b.pfi_number,
    status: b.status,
    pfiType: b.pfi_type,
    locationName: b.location_name || "—",
    locationId: b.location_id == null ? null : Number(b.location_id),
    lpgStationId: b.lpg_station_id == null ? null : Number(b.lpg_station_id),
    productName: b.product_name || "—",
    productUnit: normaliseUnit(b.product_unit),
    startingQty: num(b.starting_qty),
    blQty: b.bl_qty == null ? null : num(b.bl_qty),
    closureDay: dayKey(b.closure_date),
  }));

  // The depot filter is applied here rather than in SQL because a PFI
  // belongs to a depot OR an LPG station, and "the location this PFI trades
  // out of" is already resolved above. Filtering twice, in two languages,
  // is how the list and its totals come to disagree.
  const pfis = depotId
    ? allPfis.filter((b) => b.locationId === Number(depotId))
    : allPfis;
  const ids = pfis.map((b) => b.id);
  if (!ids.length) {
    return {
      days: days.map((date) => ({ date, rows: [], totals: emptyTotals() })),
      totals: emptyTotals(),
      meta: emptyMeta({ from, to, tz }),
    };
  }

  const [opening, inWindow, openInflow, inflowWindow, spans, entries, dupRows, partPaidRows] =
    await Promise.all([
      // Everything before the window, one row per PFI — the opening position.
      cfoReportRepo.salesByDay({ tz, from: null, to: previousDay(from), pfiIds: ids }),
      cfoReportRepo.salesByDay({ tz, from, to, pfiIds: ids }),
      cfoReportRepo.inflowByDay({ tz, from: null, to: previousDay(from), pfiIds: ids }),
      cfoReportRepo.inflowByDay({ tz, from, to, pfiIds: ids }),
      cfoReportRepo.tradingSpan({ tz, pfiIds: ids }),
      cfoReportRepo.findEntries({ from, to, pfiIds: ids }),
      cfoReportRepo.duplicatesExcluded({ tz, to, pfiIds: ids }),
      cfoReportRepo.partPaidHeld({ tz, to, pfiIds: ids }),
    ]);

  // ── index everything by PFI, then by day ──
  const openingBy = new Map();
  for (const r of opening) {
    openingBy.set(Number(r.pfi_id), {
      qty: num(r.qty), value: num(r.value), orders: Number(r.orders) || 0,
      inflow: 0, statementInflow: 0,
    });
  }
  for (const r of openInflow) {
    const b = openingBy.get(Number(r.pfi_id)) || emptyBucket();
    b.inflow = num(r.amount);
    b.statementInflow = num(r.statement_amount);
    openingBy.set(Number(r.pfi_id), b);
  }

  /** `${pfiId}|${day}` → bucket. Both aggregates land in the same map. */
  const byDay = new Map();
  const bucketFor = (id, day) => {
    const key = `${id}|${day}`;
    let b = byDay.get(key);
    if (!b) byDay.set(key, (b = emptyBucket()));
    return b;
  };
  for (const r of inWindow) {
    const b = bucketFor(Number(r.pfi_id), dayKey(r.day));
    b.qty = num(r.qty); b.value = num(r.value); b.orders = Number(r.orders) || 0;
  }
  for (const r of inflowWindow) {
    const b = bucketFor(Number(r.pfi_id), dayKey(r.day));
    b.inflow = num(r.amount);
    b.statementInflow = num(r.statement_amount);
  }

  const spanBy = new Map(
    spans.map((s) => [Number(s.pfi_id), { firstDay: dayKey(s.first_day), lastDay: dayKey(s.last_day) }])
  );
  const entryBy = new Map(entries.map((e) => [`${e.pfiId}|${dayKey(e.reportDate)}`, e]));
  const editors = await cfoReportRepo.editorsFor(entries.map((e) => e.updatedBy));

  // ── walk the days forward, carrying the running totals ──
  const running = new Map(
    pfis.map((b) => [b.id, { ...emptyBucket(), ...(openingBy.get(b.id) || {}) }])
  );

  const grand = emptyTotals();
  const out = [];

  for (const day of days) {
    const totals = emptyTotals();
    const rows = [];

    for (const pfi of pfis) {
      const bucket = byDay.get(`${pfi.id}|${day}`) || emptyBucket();
      const run = running.get(pfi.id);

      // Accumulate BEFORE deciding whether to list: a PFI hidden on a day
      // it did not trade must still carry that day's money forward, or the
      // next row it appears on is short.
      run.qty = round2(run.qty + bucket.qty);
      run.value = round2(run.value + bucket.value);
      run.orders += bucket.orders;
      run.inflow = round2(run.inflow + bucket.inflow);
      run.statementInflow = round2(run.statementInflow + bucket.statementInflow);

      const entry = entryBy.get(`${pfi.id}|${day}`);
      const listed =
        !!entry ||
        isListed({ day, pfi, span: spanBy.get(pfi.id), dayQty: bucket.qty, includeAll });
      if (!listed) continue;

      const row = buildRow({
        pfi, day, running: run, dayBucket: bucket, entry,
        editorName: entry?.updatedBy ? editors.get(Number(entry.updatedBy)) : null,
      });
      rows.push(row);
      addToTotals(totals, row);
    }

    // Biggest sellers first within a day — the rows a CFO reads first.
    rows.sort((a, b) => b.dayVolume - a.dayVolume || a.pfiNumber.localeCompare(b.pfiNumber));
    out.push({ date: day, rows, totals });
  }

  /**
   * The grand total is the LAST day's position, not the sum of every day's.
   *
   * Cumulative columns are already cumulative: adding thirty days of
   * "cumulative sales volume" together counts the same litres thirty times.
   * The one column that genuinely sums across days is the day's own volume,
   * and that is carried separately as `periodVolume`.
   */
  const lastDay = out[out.length - 1];
  if (lastDay) for (const row of lastDay.rows) addToTotals(grand, row);
  grand.periodByUnit = {};
  grand.periodValue = 0;
  for (const d of out) {
    for (const row of d.rows) {
      const u = grand.periodByUnit[row.productUnit] || (grand.periodByUnit[row.productUnit] = 0);
      grand.periodByUnit[row.productUnit] = round2(u + row.dayVolume);
    }
  }

  return {
    days: out,
    totals: grand,
    meta: {
      ...emptyMeta({ from, to, tz }),
      pfis: pfis.map((b) => ({
        id: b.id, pfiNumber: b.pfiNumber, locationName: b.locationName, status: b.status,
      })),
      duplicatesExcluded: round2(dupRows.reduce((s, r) => s + num(r.amount), 0)),
      duplicateRows: dupRows.reduce((s, r) => s + (Number(r.rows) || 0), 0),
      partPaidHeld: round2(partPaidRows.reduce((s, r) => s + num(r.amount), 0)),
      partPaidOrders: partPaidRows.reduce((s, r) => s + (Number(r.orders) || 0), 0),
    },
  };
};

/** The day before a date-only string, in the same timezone-free arithmetic. */
const previousDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const emptyMeta = ({ from, to, tz }) => ({
  dateFrom: from,
  dateTo: to,
  timezone: tz,
  pfis: [],
  /** See DUPLICATE_LEGACY_IDS — money this report drops and the audited one keeps. */
  duplicatesExcluded: 0,
  duplicateRows: 0,
  /** Money on part-paid orders, counted on neither side of this report. */
  partPaidHeld: 0,
  partPaidOrders: 0,
});

module.exports = {
  build,
  // Exported for the tests: the rules worth pinning down are the ones with
  // no database in them.
  daysBetween,
  previousDay,
  isListed,
  normaliseUnit,
  buildRow,
  addToTotals,
  emptyTotals,
};
