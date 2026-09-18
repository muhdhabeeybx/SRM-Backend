const { client, db } = require("../db");
const { cfoReportEntries } = require("../db/schema");
const { and, eq, gte, lte, inArray } = require("drizzle-orm");

/**
 * The raw material for the CFO report: every figure, bucketed by PFI and by
 * calendar day, and nothing assembled.
 *
 * Assembly — running totals, the trading window, applying overrides — is in
 * services/cfoReport.service.js. This file only answers what the database
 * holds, which keeps the arithmetic in one place that can be read and tested
 * without a connection.
 *
 * ── Everything here is bucketed by LOCAL calendar day ──────────────────────
 *
 * `(ts AT TIME ZONE $tz)::date`, never `DATE(ts)`. The server runs in UTC and
 * the business runs in Lagos, so an order placed at 00:40 on the 16th is a
 * 15th order to Postgres and a 16th order to everybody in the building. The
 * timezone is passed in rather than hardcoded so it is the same one the rest
 * of the reporting stack uses — see REPORT_TZ in dailyCombinedReport.service.
 */

/**
 * A sale is an order whose payment is confirmed. Nothing else.
 *
 * The same rule, on the same column, that the PFI page uses for its Total
 * Sold (pfiExpense.repository's `sold` query) and that the finance report
 * uses for its Total Quantity. Sharing it by construction is what makes the
 * CFO report's cumulative column reconcile against the PFI page to the
 * litre instead of approximately.
 */
const SALE = client`o.payment_status = 'Paid'`;

/**
 * The day a sale counts towards: the day the ORDER WAS PLACED.
 *
 * Not the day its payment was confirmed, for two reasons and both of them
 * matter.
 *
 * The first is consistency. The finance report and the sales summary both
 * date by orders.created_at, deliberately and with the reasoning written out
 * in order.repository's findFinanceReport — an order placed on 24 August and
 * confirmed on 1 September must not appear in August's sales and September's
 * finance. A third report with a third answer would be worse than either.
 *
 * The second is coverage. 801 of the 7,570 confirmed orders on the book have
 * no payment_confirmed_at at all. Dating by that column does not move those
 * orders to a different day, it removes them from the report entirely, and a
 * cumulative total that silently omits one order in ten cannot be reconciled
 * against anything. created_at is NOT NULL and always has been.
 *
 * The cost is small and worth stating: where an order is placed on one day
 * and confirmed on another, this report counts it on the first. That is 174
 * of 6,769 orders — 2.6% — and they are almost all next-morning confirmations.
 */
const SALE_DAY = (tz) => client`(o.created_at AT TIME ZONE ${tz})::date`;

/**
 * The duplicate payment rows migration 0021 left behind, by id.
 *
 * Where surplus had been moved between orders, the backfill gave the
 * RECEIVING order both the `transfer_in` AND a `legacy` placeholder for the
 * identical amount — the same money counted twice. It makes an order settled
 * in full by a transfer read as overpaid by its entire value.
 *
 * Three conditions, and the last two are not optional: the amount matches a
 * transfer_in on the same order, the order reads overpaid, AND removing this
 * one row lands it on exactly its own value. Amount-matching alone catches
 * square orders that merely happen to hold a legacy 45,000 beside a statement
 * 45,000, and would delete real money from the report.
 *
 * ── Why this is excluded here and not fixed at source ──────────────────────
 *
 * The finance report has been audited against these figures and must not
 * move, so the rows stay in the table exactly as they are. A new report is
 * free to read past them, which is the documented way to correct one of these
 * — in a new block, with the excluded amount stated so the two documents
 * reconcile line by line. The service returns the total it dropped, and the
 * page prints it.
 */
const DUPLICATE_LEGACY_IDS = client`
  SELECT op.id
    FROM order_payments op
    JOIN orders o ON o.id = op.order_id
   WHERE op.source = 'legacy'
     AND EXISTS (
       SELECT 1 FROM order_payments t
        WHERE t.order_id = op.order_id AND t.source = 'transfer_in' AND t.amount = op.amount
     )
     AND (SELECT COALESCE(SUM(a.amount), 0) FROM order_payments a WHERE a.order_id = op.order_id)
         > o.total_amount::numeric
     AND (SELECT COALESCE(SUM(a.amount), 0) FROM order_payments a WHERE a.order_id = op.order_id) - op.amount
         = o.total_amount::numeric
`;

/**
 * The day a payment becomes countable on this report.
 *
 * The LATER of the day the money reached the bank and the day the order it
 * settles was placed — because the report puts bank inflow next to sales
 * value and asks the reader to subtract one from the other. Both sides have
 * to be talking about the same orders, or the difference is not a surplus,
 * it is a timing artefact.
 *
 * This is not hypothetical: 691 payments totalling ₦42.65bn are dated BEFORE
 * the order they pay for — customers paying in advance, and statement lines
 * that were back-dated to their value date. Bucketing those on the bank's
 * date alone puts ₦42.65bn of inflow on days where the matching sale has not
 * been booked yet, and every one of those days reads as a fat surplus that
 * closes itself the following week.
 *
 * `COALESCE(txn_date, created_at)`: every `statement` row carries the bank's
 * own value date, which is the one a reconciliation is done against. A legacy
 * row has none — 7,371 of 7,378 are null — so it falls back to when the row
 * was written, which the 0021 backfill preserved from the original wallet
 * ledger rather than stamping with the migration date. Both are real dates.
 */
const PAYMENT_DAY = (tz) => client`
  GREATEST(
    (COALESCE(op.txn_date, op.created_at) AT TIME ZONE ${tz})::date,
    (o.created_at AT TIME ZONE ${tz})::date
  )
`;

/**
 * Restrict to a set of PFIs.
 *
 * `null` means no restriction. An ARRAY means exactly these — and an EMPTY
 * array means none, which is the case that matters: a user scoped to a depot
 * that holds no PFIs must get an empty report, not the whole book. Treating
 * an empty list as "no filter" is the same falsy-versus-absent confusion that
 * null overrides guard against elsewhere in this feature, and here it would
 * hand a scoped user every PFI in the company.
 */
const pfiFilter = (pfiIds) => {
  if (!Array.isArray(pfiIds)) return client``;
  if (!pfiIds.length) return client`AND false`;
  return client`AND o.pfi_id = ANY(${pfiIds})`;
};

/**
 * Sales per PFI per day, over a window.
 *
 * `upTo` with no `from` gives the opening position — everything that happened
 * strictly before the window, in one row per PFI — which is what the
 * service seeds its running totals with. Without it, opening a report on the
 * 15th would show a PFI three months into its life as though it had sold
 * nothing.
 */
const salesByDay = async ({ tz, from, to, pfiIds }) => {
  const day = SALE_DAY(tz);
  const rows = await client`
    SELECT o.pfi_id                       AS pfi_id,
           ${from ? day : client`NULL::date`} AS day,
           SUM(o.quantity)::numeric       AS qty,
           SUM(o.total_amount)::numeric   AS value,
           COUNT(*)::int                  AS orders
      FROM orders o
     WHERE o.pfi_id IS NOT NULL
       AND ${SALE}
       ${from ? client`AND ${day} >= ${from}::date` : client``}
       AND ${day} <= ${to}::date
       ${pfiFilter(pfiIds)}
     GROUP BY 1, 2
  `;
  return rows;
};

/**
 * Money received per PFI per day, over a window. Same `from`/`to` contract
 * as salesByDay.
 *
 * Summed over ALL payment rows, transfer legs included and signed, so a PFI
 * that gave surplus away nets down to what it kept rather than being reported
 * as holding money that has gone. This is `received` in the finance report's
 * language, not `amountPaidIn` — a stock-and-money report is about what the
 * PFI has, and the outgoing leg of a transfer is money it does not have.
 */
const inflowByDay = async ({ tz, from, to, pfiIds }) => {
  const day = PAYMENT_DAY(tz);
  const rows = await client`
    SELECT o.pfi_id                       AS pfi_id,
           ${from ? day : client`NULL::date`} AS day,
           SUM(op.amount)::numeric        AS amount,
           /*
            * The same total, split by what kind of money it is — so the report
            * can say not just HOW MUCH of the inflow a bank statement stands
            * behind, but what the rest of it actually is.
            *
            * "72% bank-backed" on its own is a number that raises a question
            * and answers none of it. The missing 28% is either wallet-era
            * money with no statement line ever recorded against it, or surplus
            * moved here from another order — two completely different
            * conversations, and the desk needs to know which before it can act.
            */
           COALESCE(SUM(op.amount) FILTER (WHERE op.source = 'statement'), 0)::numeric    AS statement_amount,
           COALESCE(SUM(op.amount) FILTER (WHERE op.source = 'legacy'), 0)::numeric       AS legacy_amount,
           COALESCE(SUM(op.amount) FILTER (WHERE op.source = 'transfer_in'), 0)::numeric  AS transfer_in_amount,
           COALESCE(SUM(op.amount) FILTER (WHERE op.source = 'transfer_out'), 0)::numeric AS transfer_out_amount
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.pfi_id IS NOT NULL
       AND ${SALE}
       AND op.id NOT IN (${DUPLICATE_LEGACY_IDS})
       ${from ? client`AND ${day} >= ${from}::date` : client``}
       AND ${day} <= ${to}::date
       ${pfiFilter(pfiIds)}
     GROUP BY 1, 2
  `;
  return rows;
};

/**
 * What the 0021 duplicates would have added, per PFI, up to a date.
 *
 * Reported rather than quietly dropped: the CFO report and the audited
 * finance report disagree by exactly this much on exactly these PFIs, and
 * a document that differs from another without saying so is the thing this
 * figure exists to prevent.
 */
const duplicatesExcluded = async ({ tz, to, pfiIds }) => {
  const day = PAYMENT_DAY(tz);
  return client`
    SELECT o.pfi_id AS pfi_id, SUM(op.amount)::numeric AS amount, COUNT(*)::int AS rows
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.pfi_id IS NOT NULL
       AND ${SALE}
       AND op.id IN (${DUPLICATE_LEGACY_IDS})
       AND ${day} <= ${to}::date
       ${pfiFilter(pfiIds)}
     GROUP BY 1
  `;
};

/**
 * Money sitting on orders this report counts on NEITHER side.
 *
 * A part-paid order is not a sale by the rule above, so its litres and its
 * value are absent from the report — and its money has to be absent too, or
 * the surplus column would show cash against sales that were never booked.
 * Excluding both sides is right; excluding them silently is not. The page
 * prints this under the table.
 */
const partPaidHeld = async ({ tz, to, pfiIds }) => {
  const day = PAYMENT_DAY(tz);
  return client`
    SELECT o.pfi_id AS pfi_id,
           SUM(op.amount)::numeric AS amount,
           COUNT(DISTINCT o.id)::int AS orders
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.pfi_id IS NOT NULL
       AND o.payment_status = 'Part Paid'
       AND op.id NOT IN (${DUPLICATE_LEGACY_IDS})
       AND ${day} <= ${to}::date
       ${pfiFilter(pfiIds)}
     GROUP BY 1
  `;
};

/**
 * The first and last day each PFI traded.
 *
 * This is what decides whether a PFI belongs on a given day's sheet, and it
 * is derived from the orders rather than from pfis.pfi_date or
 * pfis.closure_date. Those two columns look like the answer and are not:
 * pfi_date is set on 20 of 47 PFIs and 450 orders predate their own
 * PFI's date, closure_date is set on 7. A rule built on either would drop
 * most of the book. The orders are always there.
 */
const tradingSpan = async ({ tz, pfiIds }) => {
  const day = SALE_DAY(tz);
  return client`
    SELECT o.pfi_id AS pfi_id, MIN(${day}) AS first_day, MAX(${day}) AS last_day
      FROM orders o
     WHERE o.pfi_id IS NOT NULL AND ${SALE} ${pfiFilter(pfiIds)}
     GROUP BY 1
  `;
};

/**
 * The PFIs themselves, with the depot they trade out of.
 *
 * `location_name` is a denormalised copy on the PFI and is empty on some
 * rows, so the depot's own name is joined and preferred — the Location column
 * on this report is the one a regional CFO reads first and a blank there is
 * not acceptable. An LPG PFI answers to a station instead of a depot, and
 * that name is joined for the same reason.
 */
const listPfis = async ({ pfiIds }) => {
  return client`
    SELECT p.id, p.pfi_number, p.status, p.pfi_type,
           COALESCE(NULLIF(d.name, ''), NULLIF(ls.name, ''), NULLIF(p.location_name, ''), '') AS location_name,
           p.location_id, p.lpg_station_id,
           COALESCE(NULLIF(pr.name, ''), NULLIF(p.product_name, ''), '') AS product_name,
           COALESCE(NULLIF(p.product_unit, ''), 'Litres') AS product_unit,
           p.starting_qty_litres::numeric AS starting_qty,
           p.bl_qty_litres::numeric       AS bl_qty,
           p.closure_date
      FROM pfis p
      LEFT JOIN depots d       ON d.id  = p.location_id
      LEFT JOIN lpg_stations ls ON ls.id = p.lpg_station_id
      LEFT JOIN products pr    ON pr.id = p.product_id
     ${!Array.isArray(pfiIds) ? client`` : pfiIds.length ? client`WHERE p.id = ANY(${pfiIds})` : client`WHERE false`}
     ORDER BY p.pfi_number
  `;
};

/**
 * Which PFIs a scoped user may see.
 *
 * Returns null for "no restriction" — including for a scoped user with no
 * assignments at all, which is the same call scopeFilter.js makes and for the
 * same reason: narrowing to nothing renders as a page that loads and is
 * empty, with nothing to say why, and that is indistinguishable from a broken
 * query.
 */
const visiblePfiIds = async (user) => {
  if (!user || user.canViewAllLocations) return null;
  const { depotIds = [], lpgStationIds = [], pfiIds = [] } = user.scope || {};
  if (!depotIds.length && !lpgStationIds.length && !pfiIds.length) return null;

  const rows = await client`
    SELECT p.id FROM pfis p
     WHERE ${depotIds.length ? client`p.location_id = ANY(${depotIds})` : client`false`}
        OR ${lpgStationIds.length ? client`p.lpg_station_id = ANY(${lpgStationIds})` : client`false`}
        OR ${pfiIds.length ? client`p.id = ANY(${pfiIds})` : client`false`}
  `;
  return rows.map((r) => Number(r.id));
};

// ── The overrides ───────────────────────────────────────────────────────────

/** Every saved correction in a window, for the days and PFIs being shown. */
const findEntries = async ({ from, to, pfiIds }) => {
  // Same contract as pfiFilter above: null is no restriction, an empty array
  // is none. Callers only reach here with a non-empty list, but the two must
  // not mean the same thing in one file and different things in another.
  if (Array.isArray(pfiIds) && !pfiIds.length) return [];
  const conditions = [gte(cfoReportEntries.reportDate, from), lte(cfoReportEntries.reportDate, to)];
  if (Array.isArray(pfiIds)) conditions.push(inArray(cfoReportEntries.pfiId, pfiIds));
  return db.select().from(cfoReportEntries).where(and(...conditions));
};

/**
 * Save a correction, creating the row or updating it in place.
 *
 * An upsert on (report_date, pfi_id) rather than a read-then-write: two people
 * on the same cell would otherwise both read "no row" and both insert, and the
 * unique index would turn the second one's save into a 500.
 *
 * `values` arrives already whitelisted by the schema, and a key present with
 * value null is a deliberate "clear this override" — so the update set is
 * built from the keys that are PRESENT, never from the ones that are truthy.
 */
const upsertEntry = async ({ reportDate, pfiId, values, staffId }) => {
  const insert = { reportDate, pfiId, updatedBy: staffId ?? null, ...values };
  const update = { ...values, updatedBy: staffId ?? null, updatedAt: new Date() };

  const [row] = await db
    .insert(cfoReportEntries)
    .values(insert)
    .onConflictDoUpdate({
      target: [cfoReportEntries.reportDate, cfoReportEntries.pfiId],
      set: update,
    })
    .returning();
  return row;
};

/** Drop a correction entirely, putting the row back to what the system says. */
const deleteEntry = async ({ reportDate, pfiId }) => {
  const [row] = await db
    .delete(cfoReportEntries)
    .where(and(eq(cfoReportEntries.reportDate, reportDate), eq(cfoReportEntries.pfiId, pfiId)))
    .returning();
  return row || null;
};

/** The staff names behind the corrections, for the "last edited by" column. */
const editorsFor = async (staffIds) => {
  const ids = [...new Set((staffIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const rows = await client`
    SELECT id, first_name, surname FROM staff WHERE id = ANY(${ids})
  `;
  return new Map(rows.map((r) => [Number(r.id), `${r.first_name || ""} ${r.surname || ""}`.trim()]));
};

module.exports = {
  salesByDay,
  inflowByDay,
  duplicatesExcluded,
  partPaidHeld,
  tradingSpan,
  listPfis,
  visiblePfiIds,
  findEntries,
  upsertEntry,
  deleteEntry,
  editorsFor,
  // Exported for the tests, which assert the duplicate rule catches exactly
  // the 0021 rows and not the square orders that merely look like them.
  DUPLICATE_LEGACY_IDS,
};
