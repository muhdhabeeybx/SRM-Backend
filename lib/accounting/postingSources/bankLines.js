const { sql } = require("drizzle-orm");

/**
 * Bank statement lines nothing has claimed yet.
 *
 * A bank account in the ledger is exactly its statement. A line matched to an
 * order or a delivery payment is booked by that payment (Dr the bank / Cr the
 * customer). A line nobody has matched is still money in that bank, so it is
 * booked here against Suspense:
 *
 *   bank_line   Dr the bank / Cr Suspense, its bank named
 *
 * When the line is matched, it leaves this list — the engine takes this entry
 * back — and the payment books it properly. Money typed in without a line
 * (plant-sheet deposits, a refund, an expense paid) went the other way through
 * Suspense, so where the two agree Suspense nets to nothing, and what is left
 * in it, bank by bank, is exactly what still needs matching.
 */

const rowsOf = (r) => r.rows ?? r;

/**
 * Finance can say what a line no record explains was — a loan paid in,
 * capital, tax paid to FIRS, a director's drawing (bank_line_classifications,
 * 0083). Such a line books to that account instead of Suspense.
 */
const classified = (direction) => sql`
  LEFT JOIN bank_line_classifications k ON k.direction = ${direction} AND k.line_id = l.id`;

/**
 * A line matched to a record of the Fixed Assets or Loans register (0088) is
 * booked by that record — out of or into this bank, on this day — so it is
 * left out here. While the record stands: a line whose record has since been
 * deleted is open money again, Suspense until somebody says what it was.
 */
const REGISTER_KINDS = ["asset", "asset_sale", "loan", "loan_repayment"];
const registerLive = sql`
  CASE k.kind
    WHEN 'asset' THEN EXISTS (SELECT 1 FROM fixed_assets a WHERE a.id = k.ref_id AND a.deleted_at IS NULL)
    WHEN 'asset_sale' THEN EXISTS (SELECT 1 FROM fixed_assets a WHERE a.id = k.ref_id AND a.deleted_at IS NULL AND a.disposed_on IS NOT NULL)
    WHEN 'loan' THEN EXISTS (SELECT 1 FROM loans n WHERE n.id = k.ref_id AND n.deleted_at IS NULL)
    WHEN 'loan_repayment' THEN EXISTS (SELECT 1 FROM loan_repayments r JOIN loans n ON n.id = r.loan_id
                                        WHERE r.id = k.ref_id AND r.deleted_at IS NULL AND n.deleted_at IS NULL)
    ELSE false
  END`;

async function unclaimedLines(db) {
  const rows = rowsOf(await db.execute(sql`
    SELECT l.id, l.bank_account_id, l.amount::numeric AS amount, to_char(l.txn_date, 'YYYY-MM-DD') AS day,
           l.depositor, k.account_id, k.vendor_id, k.note, k.kind, ${registerLive} AS register_live
      FROM bank_statement_lines l
      ${classified("credit")}
     WHERE l.amount > 0
       AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.statement_line_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM delivery_sales s WHERE s.statement_line_id = l.id)
  `));
  return rows.filter((l) => !l.register_live).map((l) => {
    const bank = Number(l.bank_account_id);
    const amount = Number(l.amount);
    // Looked at and left: still Suspense. So is a line whose register record is gone.
    const named = l.account_id != null && l.kind !== "left" && !REGISTER_KINDS.includes(l.kind);
    return {
      id: String(l.id),
      date: l.day,
      memo: named
        ? `Money in: ${l.note || l.depositor || "named by Finance"}`
        : `Money in, not yet matched${l.depositor ? `: ${l.depositor}` : ""}`,
      lines: [
        { key: `bank:${bank}`, debit: amount, bankAccountId: bank },
        named
          ? { accountId: Number(l.account_id), credit: amount, party: l.vendor_id ? ["vendor", Number(l.vendor_id)] : null }
          : { key: "suspense", credit: amount, bankAccountId: bank },
      ],
    };
  });
}

/**
 * Money out of the bank (0083). The same rule the other way round: booked
 * against the bank, and against Suspense until something explains it.
 *
 * What it turned out to be (0085, services/accounting/bankMatching): a
 * transfer to another of our accounts, a bank charge, a cargo payment or
 * anything Finance named books to that account here. The withdrawal that paid
 * an expense or a refund is booked by that payment instead (expenses.js,
 * orders.js), from this bank on this day, so it is left out here.
 */
async function withdrawals(db) {
  const rows = rowsOf(await db.execute(sql`
    SELECT l.id, l.bank_account_id, l.amount::numeric AS amount, to_char(l.txn_date, 'YYYY-MM-DD') AS day,
           l.beneficiary, l.narration, k.account_id, k.vendor_id, k.note, k.kind, ${registerLive} AS register_live
      FROM bank_statement_debits l
      ${classified("debit")}
     WHERE k.kind IS NULL OR k.kind NOT IN ('expense', 'refund')
  `));
  return rows.filter((l) => !l.register_live).map((l) => {
    const bank = Number(l.bank_account_id);
    const amount = Number(l.amount);
    // Looked at and left: still Suspense. So is a line whose register record is gone.
    const named = l.account_id != null && l.kind !== "left" && !REGISTER_KINDS.includes(l.kind);
    const who = l.beneficiary || l.narration;
    return {
      id: String(l.id),
      date: l.day,
      memo: named ? `Money out: ${l.note || who || "named by Finance"}` : `Money out, not yet matched${who ? `: ${who}` : ""}`,
      lines: [
        named
          ? { accountId: Number(l.account_id), debit: amount, party: l.vendor_id ? ["vendor", Number(l.vendor_id)] : null }
          : { key: "suspense", debit: amount, bankAccountId: bank },
        { key: `bank:${bank}`, credit: amount, bankAccountId: bank },
      ],
    };
  });
}

module.exports = [
  { type: "bank_line", load: unclaimedLines },
  { type: "bank_debit", load: withdrawals },
];
