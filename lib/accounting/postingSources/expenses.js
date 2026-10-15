const { sql } = require("drizzle-orm");
const { landedCostsFor } = require("../landedCost");

/**
 * Expenses in the general ledger — the same reading as the vendor statement
 * (lib/accounting/sources/vendorExpenses).
 *
 *   expense_bill  an expense approved for payment (or recorded as already
 *                 paid), on the day it was approved, at the whole invoice:
 *                   Dr its own cost account —    what the vendor is owed, plus
 *                      or Stock, for a cargo cost
 *                      that goes into stock (0081)
 *                      or Commission money with
 *                      staff, for money requested
 *                      to pay customer commission
 *                      (0084, commissions.js)
 *                                                the WHT, plus the VAT where we
 *                                                keep it back (0066)
 *                   Cr Vendor payables           what the vendor is owed
 *                   Cr WHT payable to FIRS
 *                   Cr VAT payable to FIRS       only where it is kept back
 *   expense_paid  the same expense paid, on the day it cleared:
 *                   Dr Vendor payables / Cr the bank its withdrawal left,
 *                 on that day, once the statement's line is matched to it
 *                 (0085, services/accounting/bankMatching) — until then
 *                 Cr Suspense, under the bank the expense names.
 *
 * Left out: refund expenses — the money went to a customer, and the order's
 * refund row books it — and a foreign invoice with no exchange rate yet,
 * which has no naira figure to book until one is set.
 */

const rowsOf = (r) => r.rows ?? r;
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);

const BASE = sql`
  SELECT e.id, e.reference_number AS ref, e.category_id, e.pfi_id, e.vendor_id,
         e.delivery_customer_id, pf.pfi_type::text AS pfi_type, pf.location_id AS pfi_depot,
         c.gl_subgroup AS heading, c.into_stock, c.name AS category_name, c.system_key AS category_key,
         -- A plant's expense names the plant; its account in the books is the
         -- delivery customer linked to it (0061).
         (SELECT dc.id FROM delivery_customers dc
           WHERE e.lpg_station_id IS NOT NULL AND dc.lpg_station_id = e.lpg_station_id
           ORDER BY dc.id LIMIT 1) AS plant_customer_id,
         e.lpg_station_id,
         COALESCE(NULLIF(btrim(e.vendor), ''), v.name) AS vendor_name, e.description,
         e.status::text AS status, e.vat_withheld,
         CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN 1 ELSE e.exchange_rate END AS rate,
         COALESCE(e.amount_ngn, CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN e.amount END)::numeric AS owed,
         COALESCE(e.amount_paid_ngn, CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN e.amount_paid END)::numeric AS paid,
         COALESCE(e.vat_amount, 0)::numeric AS vat, COALESCE(e.wht_deduction, 0)::numeric AS wht,
         ${DAY("COALESCE(e.admin_approved_at, e.payment_date, e.expense_date, e.created_at)")} AS owed_day,
         ${DAY("COALESCE(e.payment_date, e.paid_at)")} AS paid_day,
         e.bank_paid_from,
         -- Entered on the Fixed Assets register as what it bought (0088).
         EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.expense_id = e.id AND fa.deleted_at IS NULL) AS is_asset
    FROM pfi_expenses e
    JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN vendors v ON v.id = e.vendor_id
    LEFT JOIN pfis pf ON pf.id = e.pfi_id
   WHERE e.deleted_at IS NULL
     AND e.status IN ('admin_approved', 'paid')
     AND NOT COALESCE(c.is_refund, false)
`;

const who = (e) => [e.ref, e.vendor_name].filter(Boolean).join(" · ");

/**
 * Which part of the business an expense belongs to: what it was raised for
 * (a station, a plant, a cargo), else what kind of cost it is.
 */
function aboutOf(e) {
  if (e.delivery_customer_id != null) {
    return { unit: "stations", location: ["station", Number(e.delivery_customer_id)], pfiId: e.pfi_id };
  }
  if (e.lpg_station_id != null) {
    return { unit: "lpg_plants", location: e.plant_customer_id != null ? ["plant", Number(e.plant_customer_id)] : null, pfiId: e.pfi_id };
  }
  if (e.pfi_id != null) {
    return {
      unit: e.pfi_type === "trucking" ? "trucking" : "depot",
      location: e.pfi_depot != null ? ["depot", Number(e.pfi_depot)] : null,
      pfiId: e.pfi_id,
    };
  }
  if (e.heading === "Fleet & Truck Costs") return { unit: "fleet", location: null, pfiId: null };
  return { unit: "head_office", location: null, pfiId: null };
}

async function bills(db, ctx = {}) {
  const [rows, costs] = await Promise.all([db.execute(BASE).then(rowsOf), landedCostsFor(db, ctx)]);
  return rows
    .filter((e) => e.owed !== null && e.rate !== null)
    .map((e) => {
      const owed = num(e.owed);
      const rate = num(e.rate);
      const wht = Math.round(num(e.wht) * rate * 100) / 100;
      const vat = e.vat_withheld ? Math.round(num(e.vat) * rate * 100) / 100 : 0;
      const party = e.vendor_id == null ? null : ["vendor", Number(e.vendor_id)];
      // Money requested to pay customers their commission is handed to a
      // member of staff, who pays it out (commissions.js) — not a cost.
      const commission = e.category_key === "customer_commission";
      return {
        id: String(e.id),
        date: e.owed_day,
        ...aboutOf(e),
        memo: commission ? `Commission money given to ${who(e) || "staff"}` : `Expense approved: ${who(e)}`,
        lines: [
          // A cost that is part of the product's cost goes into the cargo's
          // stock value (landedCost.js) — under the cargo whose tank holds
          // the litres — and reaches profit only as they are sold.
          // Something the company keeps — a truck, a generator — entered on
          // the Fixed Assets register: owned, not spent (assets.js).
          e.is_asset && !commission
            ? { key: "fixed_assets", debit: owed + wht + vat }
          : commission
            ? { key: "commission_float", debit: owed + wht + vat, pfiId: e.pfi_id == null ? null : Number(e.pfi_id), party }
            : e.into_stock && e.pfi_id != null
              ? { key: "stock", debit: owed + wht + vat, pfiId: costs.get(Number(e.pfi_id))?.stockPfiId ?? Number(e.pfi_id) }
              : { accountId: Number(e.category_id), debit: owed + wht + vat },
          { key: "vendor_payables", credit: owed, party },
          { key: "wht_payable", credit: wht },
          { key: "vat_payable", credit: vat },
        ],
      };
    });
}

/**
 * The bank an expense says it was paid from is free text ("Fidelity Bank ·
 * 1234567890"). Matched on the last ten digits it carries, when they name one
 * of our accounts, so the suspense line says which bank to look for it in.
 */
async function bankByNumber(db) {
  const rows = rowsOf(await db.execute(sql`
    SELECT id, regexp_replace(COALESCE(account_number, ''), '\\D', '', 'g') AS digits FROM bank_accounts`));
  return (label) => {
    const digits = String(label || "").replace(/\D/g, "");
    if (digits.length < 10) return null;
    const hit = rows.find((b) => b.digits && b.digits.length >= 10 && digits.includes(b.digits.slice(-10)));
    return hit ? Number(hit.id) : null;
  };
}

/** Expenses whose withdrawal is on a statement (0085): the bank and the day it left. */
async function withdrawalsFor(db) {
  const rows = rowsOf(await db.execute(sql`
    SELECT k.ref_id, d.bank_account_id, to_char(d.txn_date, 'YYYY-MM-DD') AS day
      FROM bank_line_classifications k JOIN bank_statement_debits d ON d.id = k.line_id
     WHERE k.direction = 'debit' AND k.kind = 'expense'`));
  return new Map(rows.map((r) => [Number(r.ref_id), { bank: Number(r.bank_account_id), day: r.day }]));
}

async function payments(db) {
  const [rows, bankOf, paidOut] = await Promise.all([db.execute(BASE).then(rowsOf), bankByNumber(db), withdrawalsFor(db)]);
  return rows
    .filter((e) => e.status === "paid" && e.paid !== null && e.paid_day)
    .map((e) => {
      const paid = num(e.paid);
      const party = e.vendor_id == null ? null : ["vendor", Number(e.vendor_id)];
      // Its withdrawal found on the statement: out of that bank, that day.
      // Otherwise Suspense, under the bank it names, until the line comes in.
      const out = paidOut.get(Number(e.id));
      return {
        id: String(e.id),
        date: out ? out.day : e.paid_day,
        ...aboutOf(e),
        memo: `Expense paid: ${who(e)}`,
        lines: [
          { key: "vendor_payables", debit: paid, party },
          out
            ? { key: `bank:${out.bank}`, credit: paid, bankAccountId: out.bank }
            : { key: "suspense", credit: paid, bankAccountId: bankOf(e.bank_paid_from) },
        ],
      };
    });
}

module.exports = [
  { type: "expense_bill", load: bills },
  { type: "expense_paid", load: payments },
];
