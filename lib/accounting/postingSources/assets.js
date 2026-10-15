const { sql } = require("drizzle-orm");
const { wearSchedule, wearTo } = require("../depreciation");
const { lagosToday } = require("../../zonedDay");

/**
 * Fixed assets in the general ledger (0088): trucks, generators, tanks,
 * buildings, land and equipment, from the Fixed Assets register.
 *
 *   asset_bought  on the day it was bought, at what it cost:
 *                   Dr Trucks & equipment
 *                   Cr the bank it was paid from — its withdrawal once the
 *                      statement's line is matched to it (0088,
 *                      services/accounting/bankMatching), Suspense under
 *                      that bank until then
 *                   or, on hire purchase, Cr Loans (the loan) for what it
 *                      financed and the bank for the deposit
 *                   or, owned before the books started, Cr Opening balance
 *                      equity
 *                 An asset first entered as an expense books nothing here:
 *                 the expense's own bill books it to Trucks & equipment
 *                 instead of its cost account (expenses.js), so it is
 *                 counted once.
 *   asset_wear    each month of its life, on the month's last day
 *                 (lib/accounting/depreciation):
 *                   Dr Depreciation & Amortisation / Cr Accumulated depreciation
 *                 A month before the books started is the opening's — it is
 *                 Opening balance equity's, never a cost of the months the
 *                 books keep.
 *   asset_sold    sold, scrapped or lost, on that day:
 *                   Dr Accumulated depreciation  its wear
 *                   Dr the bank                  what it fetched
 *                   Cr Trucks & equipment        what it cost
 *                   and the difference to Gain or loss on assets sold
 */

const rowsOf = (r) => r.rows ?? r;
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

/**
 * What an expense put in the books, in naira: what the vendor is owed, plus
 * the WHT, plus the VAT where it is kept back — exactly as expenses.js books
 * its bill. An asset first entered as an expense costs this, live, so editing
 * the expense moves the asset with it.
 */
const EXPENSE_BOOKED_SQL = (e) => sql.raw(`(
  SELECT x.owed + ROUND(COALESCE(${e}.wht_deduction, 0) * x.rate, 2)
         + CASE WHEN ${e}.vat_withheld THEN ROUND(COALESCE(${e}.vat_amount, 0) * x.rate, 2) ELSE 0 END
    FROM (SELECT CASE WHEN COALESCE(${e}.currency, 'NGN') = 'NGN' THEN 1 ELSE ${e}.exchange_rate END AS rate,
                 COALESCE(${e}.amount_ngn, CASE WHEN COALESCE(${e}.currency, 'NGN') = 'NGN' THEN ${e}.amount END) AS owed) x
)`);

/** The part of the business an asset serves, where nobody said: trucks are the fleet's. */
const unitOf = (a) => a.unit || (a.kind === "truck" || a.kind === "vehicle" ? "fleet" : "head_office");

/**
 * Every asset in the register, as the books read it. An asset entered as an
 * expense costs what that expense booked, and stands only while the expense
 * does.
 */
async function assetsInBooks(db, ctx = {}) {
  if (ctx.assets) return ctx.assets;
  const rows = rowsOf(await db.execute(sql`
    SELECT a.id, a.name, a.kind, a.paid_how, a.bank_account_id, a.expense_id, a.loan_id, a.unit,
           a.location_type, a.location_id, a.life_months, a.residual::numeric AS residual,
           a.financed::numeric AS financed, a.disposed_for::numeric AS disposed_for, a.disposed_bank_account_id,
           to_char(a.bought_on, 'YYYY-MM-DD') AS bought_on, to_char(a.disposed_on, 'YYYY-MM-DD') AS disposed_on,
           CASE WHEN a.paid_how = 'expense'
                THEN (SELECT ${EXPENSE_BOOKED_SQL("e")} FROM pfi_expenses e
                       WHERE e.id = a.expense_id AND e.deleted_at IS NULL AND e.status IN ('admin_approved', 'paid'))
                ELSE a.cost END::numeric AS cost
      FROM fixed_assets a
     WHERE a.deleted_at IS NULL
  `));
  ctx.assets = rows
    .filter((a) => num(a.cost) > 0)
    .map((a) => ({
      id: Number(a.id),
      name: a.name,
      kind: a.kind,
      paidHow: a.paid_how,
      bankAccountId: a.bank_account_id == null ? null : Number(a.bank_account_id),
      loanId: a.loan_id == null ? null : Number(a.loan_id),
      boughtOn: a.bought_on,
      cost: num(a.cost),
      residual: Math.min(num(a.residual), num(a.cost)),
      lifeMonths: a.life_months == null ? null : Number(a.life_months),
      financed: a.financed == null ? null : Math.min(num(a.financed), num(a.cost)),
      disposedOn: a.disposed_on || null,
      disposedFor: num(a.disposed_for),
      disposedBankAccountId: a.disposed_bank_account_id == null ? null : Number(a.disposed_bank_account_id),
      unit: unitOf(a),
      location: a.location_type ? [a.location_type, Number(a.location_id)] : null,
    }));
  return ctx.assets;
}

async function booksStart(db, ctx) {
  if (!ctx.booksStart) {
    const [r] = rowsOf(await db.execute(sql`SELECT value FROM accounting_settings WHERE key = 'books_start'`));
    ctx.booksStart = r?.value || "2026-09-01";
  }
  return ctx.booksStart;
}

/** Register lines matched on a statement (0088): ref_id → the bank and day the money moved. */
async function matched(db, kind) {
  const table = kind === "asset_sale" || kind === "loan" ? "bank_statement_lines" : "bank_statement_debits";
  const direction = table === "bank_statement_lines" ? "credit" : "debit";
  const rows = rowsOf(await db.execute(sql`
    SELECT k.ref_id, x.bank_account_id, to_char(x.txn_date, 'YYYY-MM-DD') AS day
      FROM bank_line_classifications k JOIN ${sql.raw(table)} x ON x.id = k.line_id
     WHERE k.direction = ${direction} AND k.kind = ${kind}`));
  return new Map(rows.map((r) => [Number(r.ref_id), { bank: Number(r.bank_account_id), day: r.day }]));
}

/** Money through a bank: the bank once its line is matched, Suspense under that bank until then. */
const throughBank = (out, bank, side, amount) =>
  out
    ? { key: `bank:${out.bank}`, [side]: amount, bankAccountId: out.bank }
    : { key: "suspense", [side]: amount, bankAccountId: bank };

async function bought(db, ctx) {
  const [assets, paidOut] = await Promise.all([assetsInBooks(db, ctx), matched(db, "asset")]);
  return assets
    .filter((a) => a.paidHow !== "expense")
    .map((a) => {
      const out = paidOut.get(a.id);
      const lines = [{ key: "fixed_assets", debit: a.cost }];
      if (a.paidHow === "owned") {
        lines.push({ key: "opening_balance_equity", credit: a.cost });
      } else if (a.paidHow === "loan") {
        const financed = a.financed ?? a.cost;
        lines.push({ key: "loans", credit: financed, party: a.loanId ? ["loan", a.loanId] : null });
        if (a.cost - financed > 0) lines.push(throughBank(out, a.bankAccountId, "credit", a.cost - financed));
      } else {
        lines.push(throughBank(out, a.bankAccountId, "credit", a.cost));
      }
      return {
        id: String(a.id),
        date: out ? out.day : a.boughtOn,
        memo: `Asset bought: ${a.name}`,
        unit: a.unit,
        location: a.location,
        lines,
      };
    });
}

async function wear(db, ctx) {
  const [assets, start] = await Promise.all([assetsInBooks(db, ctx), booksStart(db, ctx)]);
  // A month is worn once it has ended. (ctx.today: a test reading it as of another day.)
  const today = ctx.today || lagosToday();
  const out = [];
  for (const a of assets) {
    for (const w of wearSchedule(a, today)) {
      out.push({
        id: `${a.id}:${w.month}`,
        date: w.day,
        memo: `Wear and tear on ${a.name}, ${w.month}`,
        unit: a.unit,
        location: a.location,
        lines: [
          { key: w.day < start ? "opening_balance_equity" : "depreciation", debit: w.amount },
          { key: "accumulated_depreciation", credit: w.amount },
        ],
      });
    }
  }
  return out;
}

async function sold(db, ctx) {
  const [assets, start, paidIn] = await Promise.all([assetsInBooks(db, ctx), booksStart(db, ctx), matched(db, "asset_sale")]);
  return assets
    .filter((a) => a.disposedOn)
    .map((a) => {
      const worn = wearTo(a, a.disposedOn);
      const fetched = a.disposedFor;
      const gain = Math.round((fetched + worn - a.cost) * 100) / 100;
      const into = paidIn.get(a.id);
      const result = a.disposedOn < start ? "opening_balance_equity" : "asset_disposals";
      return {
        id: String(a.id),
        date: into ? into.day : a.disposedOn,
        memo: `${fetched > 0 ? "Asset sold" : "Asset written off"}: ${a.name}`,
        unit: a.unit,
        location: a.location,
        lines: [
          { key: "accumulated_depreciation", debit: worn },
          ...(fetched > 0 ? [throughBank(into, a.disposedBankAccountId, "debit", fetched)] : []),
          { key: "fixed_assets", credit: a.cost },
          gain >= 0 ? { key: result, credit: gain } : { key: result, debit: -gain },
        ],
      };
    });
}

module.exports = [
  { type: "asset_bought", load: bought },
  { type: "asset_wear", load: wear },
  { type: "asset_sold", load: sold },
];
module.exports.assetsInBooks = assetsInBooks;
module.exports.EXPENSE_BOOKED_SQL = EXPENSE_BOOKED_SQL;
module.exports.unitOf = unitOf;
