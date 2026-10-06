const { sql } = require("drizzle-orm");
const { isStationType } = require("./customerTypes");

/**
 * Which record a delivery_sales row belongs to — migration 0070.
 *
 * From PFI-47B on, a load sent to a filling station or LPG plant is a sale
 * like any other on the sales ledger: the truck assigned to the station, a
 * rate, payments added the normal way. The station's daily pump sales,
 * expenses and deposits are a separate record, on the station page only.
 * Before that batch the station's own entries were the ledger's figures for
 * the load.
 *
 * ── Which loads ───────────────────────────────────────────────────────────
 *
 * By batch, as the owner set it: PFI-47B and every PFI after it (47C, 48, …)
 * read the new way — including what was already recorded on them. Every
 * earlier batch is left as it was:
 *
 *   batch before 47B   'legacy'   read exactly as it always was, by the
 *                                 ledger and the station page alike
 *   PFI-47B onward     a station's row with money on it is the station's own
 *                      entry; anything else is the ledger's
 *
 * A row's batch is its allocation code, or, where it carries none, the code
 * on its load (same truck, same load day). A row written from now on says
 * which record it is: 'trucking' from the sales ledger, 'station' from a
 * station or plant page. A station entry on an older batch goes to the
 * station page only, as the owner chose.
 *
 * The same reading is done in SQL (readBookSql) so the list endpoint can hand
 * every screen and report the answer, and in JS (readBookOf) for a single row.
 * Change both together.
 */

/** The first batch read the new way. */
const FIRST_BATCH = { code: "PFI-47B", serial: 47, suffix: "B" };

const BOOKS = ["trucking", "station"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A batch code's serial and letter — "PFI-47B" → 47, "B". Null for anything that is not a PFI code. */
const batchOrder = (code) => {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw.startsWith("PFI")) return null;
  const m = raw.match(/(\d+)\s*([A-Z]*)/);
  return m ? { serial: Number(m[1]), suffix: m[2] || "" } : null;
};

/** PFI-47B, or a batch after it. A row with no batch is an old one. */
const isNewBatch = (code) => {
  const o = batchOrder(code);
  if (!o) return false;
  return o.serial > FIRST_BATCH.serial || (o.serial === FIRST_BATCH.serial && o.suffix >= FIRST_BATCH.suffix);
};

/** Money or a sale line on the row — what a station's own entry carries. */
const carriesStationTrade = (row) =>
  num(row?.salesValue ?? row?.sales_value) !== 0
  || num(row?.paymentAmount ?? row?.payment_amount) !== 0
  || num(row?.expensesAmount ?? row?.expenses_amount) !== 0
  || (row?.buyerClass ?? row?.buyer_class) != null
  || !String(row?.truckNumber ?? row?.truck_number ?? "").trim();

/**
 * 'trucking' | 'station' | 'legacy' for one row, given its customer's type —
 * and its load's batch code, for a row that carries none of its own.
 */
const readBookOf = (row, customerType, loadCode = "") => {
  if (BOOKS.includes(row?.book)) return row.book;
  if (!isStationType(customerType)) return "trucking";
  const code = String(row?.allocationCode ?? row?.allocation_code ?? "").trim() || loadCode;
  if (!isNewBatch(code)) return "legacy";
  return carriesStationTrade(row) ? "station" : "trucking";
};

/**
 * The book a new row is written into, when the screen did not name one: a
 * station's row carrying money is its own entry, anything else the ledger's.
 * The screens name it — the sales ledger 'trucking', a station page 'station'.
 */
const bookForWrite = (row, customerType) => {
  if (BOOKS.includes(row?.book)) return row.book;
  return isStationType(customerType) && carriesStationTrade(row) ? "station" : "trucking";
};

/**
 * The batch code a row is read under: its own, else its load's — the same
 * truck on the same load day, as cycleStanding and the code backfill match.
 */
const batchCodeSql = (s) => sql`coalesce(
  nullif(btrim(${s.allocationCode}), ''),
  (SELECT di.allocation_code FROM delivery_inventory di
    WHERE regexp_replace(upper(coalesce(di.truck_number, '')), '\\s', '', 'g')
        = regexp_replace(upper(coalesce(${s.truckNumber}, '')), '\\s', '', 'g')
      AND left(coalesce(di.date_allocated, ''), 10) = left(coalesce(${s.dateLoaded}, ''), 10)
      AND coalesce(btrim(di.allocation_code), '') <> ''
    ORDER BY di.id LIMIT 1),
  '')`;

/** isNewBatch in SQL, over a code expression. */
const isNewBatchSql = (code) => sql`(
  upper(btrim(${code})) LIKE 'PFI%'
  AND (
    coalesce(substring(${code} from '[0-9]+'), '0')::numeric > ${FIRST_BATCH.serial}
    OR (coalesce(substring(${code} from '[0-9]+'), '0')::numeric = ${FIRST_BATCH.serial}
        AND upper(coalesce(substring(${code} from '[0-9]+\\s*([A-Za-z]*)'), '')) >= ${FIRST_BATCH.suffix})
  )
)`;

/**
 * readBookOf in SQL, for a delivery_sales row joined to its customer.
 *
 * @param {object} s  the deliverySales table (or its columns)
 * @param {*} customerType  the customer_type column of the joined customer
 */
const readBookSql = (s, customerType) => sql`CASE
  WHEN ${s.book} IS NOT NULL THEN ${s.book}
  WHEN coalesce(${customerType}::text, '') NOT IN ('filling_station', 'lpg_plant') THEN 'trucking'
  WHEN NOT ${isNewBatchSql(batchCodeSql(s))} THEN 'legacy'
  WHEN coalesce(${s.salesValue}, 0) <> 0
    OR coalesce(${s.paymentAmount}, 0) <> 0
    OR coalesce(${s.expensesAmount}, 0) <> 0
    OR ${s.buyerClass} IS NOT NULL
    OR coalesce(btrim(${s.truckNumber}), '') = '' THEN 'station'
  ELSE 'trucking'
END`;

module.exports = {
  FIRST_BATCH, BOOKS, isNewBatch, carriesStationTrade, readBookOf, bookForWrite, readBookSql,
};
