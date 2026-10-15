const { sql } = require("drizzle-orm");

/**
 * Loans in the general ledger (0088), from the Loans register. Each line on
 * Loans names its loan (party 'loan'), so what is still owed is read lender
 * by lender.
 *
 *   loan_received   money lent to us, on the day it landed:
 *                     Dr the bank — its statement line once matched (0088,
 *                        services/accounting/bankMatching), Suspense under
 *                        that bank until then
 *                     Cr Loans
 *                   A hire purchase lends no money: what it financed is put
 *                   on it by the assets it paid for (assets.js).
 *   loan_repayment  paid back, on the day it left:
 *                     Dr Loans               the part off what is owed
 *                     Dr Interest on loans   the interest
 *                     Cr the bank
 */

const rowsOf = (r) => r.rows ?? r;
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

async function matched(db, kind) {
  const credit = kind === "loan";
  const rows = rowsOf(await db.execute(sql`
    SELECT k.ref_id, x.bank_account_id, to_char(x.txn_date, 'YYYY-MM-DD') AS day
      FROM bank_line_classifications k
      JOIN ${sql.raw(credit ? "bank_statement_lines" : "bank_statement_debits")} x ON x.id = k.line_id
     WHERE k.direction = ${credit ? "credit" : "debit"} AND k.kind = ${kind}`));
  return new Map(rows.map((r) => [Number(r.ref_id), { bank: Number(r.bank_account_id), day: r.day }]));
}

const throughBank = (out, bank, side, amount) =>
  out
    ? { key: `bank:${out.bank}`, [side]: amount, bankAccountId: out.bank }
    : { key: "suspense", [side]: amount, bankAccountId: bank };

async function received(db) {
  const [rows, paidIn] = await Promise.all([
    db.execute(sql`
      SELECT id, lender, amount::numeric AS amount, bank_account_id, to_char(received_on, 'YYYY-MM-DD') AS day
        FROM loans
       WHERE deleted_at IS NULL AND kind <> 'hire_purchase' AND amount > 0 AND received_on IS NOT NULL`).then(rowsOf),
    matched(db, "loan"),
  ]);
  return rows.map((n) => {
    const into = paidIn.get(Number(n.id));
    const bank = n.bank_account_id == null ? null : Number(n.bank_account_id);
    return {
      id: String(n.id),
      date: into ? into.day : n.day,
      memo: `Loan received from ${n.lender}`,
      unit: "head_office",
      lines: [
        throughBank(into, bank, "debit", num(n.amount)),
        { key: "loans", credit: num(n.amount), party: ["loan", Number(n.id)] },
      ],
    };
  });
}

async function repayments(db) {
  const [rows, paidOut] = await Promise.all([
    db.execute(sql`
      SELECT r.id, r.loan_id, n.lender, r.principal::numeric AS principal, r.interest::numeric AS interest,
             r.bank_account_id, to_char(r.paid_on, 'YYYY-MM-DD') AS day
        FROM loan_repayments r JOIN loans n ON n.id = r.loan_id
       WHERE r.deleted_at IS NULL AND n.deleted_at IS NULL`).then(rowsOf),
    matched(db, "loan_repayment"),
  ]);
  return rows.map((r) => {
    const out = paidOut.get(Number(r.id));
    const bank = r.bank_account_id == null ? null : Number(r.bank_account_id);
    const principal = num(r.principal);
    const interest = num(r.interest);
    return {
      id: String(r.id),
      date: out ? out.day : r.day,
      memo: `Loan repaid to ${r.lender}`,
      unit: "head_office",
      lines: [
        { key: "loans", debit: principal, party: ["loan", Number(r.loan_id)] },
        { key: "loan_interest", debit: interest },
        throughBank(out, bank, "credit", principal + interest),
      ],
    };
  });
}

module.exports = [
  { type: "loan_received", load: received },
  { type: "loan_repayment", load: repayments },
];
