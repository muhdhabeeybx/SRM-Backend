const { client } = require("../../db");
const { lagosToday } = require("../../lib/zonedDay");

/**
 * The Loans register (0088): money the company has borrowed — a bank loan,
 * hire purchase or a lease, another lender — and what has been paid back.
 * The books read it (lib/accounting/postingSources/loans.js, assets.js).
 *
 * A bank overdraft is not entered here: it is a bank account below nought,
 * and the books and the report read it off the bank.
 */

const KINDS = ["bank_loan", "hire_purchase", "other_lender"];
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const dayText = (d) => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const bankLabel = (r, p = "") =>
  r[`${p}bank_name`] ? `${r[`${p}bank_name`]} · ${r[`${p}account_name`]}${r[`${p}account_number`] ? ` ••${String(r[`${p}account_number`]).slice(-4)}` : ""}` : null;

/** Every loan, what was borrowed, paid back and is still owed — on a day, today by default. */
async function list({ at = lagosToday() } = {}) {
  const loans = await client`
    SELECT n.*, to_char(n.received_on, 'YYYY-MM-DD') AS received_day, to_char(n.closed_on, 'YYYY-MM-DD') AS closed_day,
           b.bank_name, b.account_name, b.account_number,
           -- A hire purchase lends what its assets put on it.
           (SELECT COALESCE(SUM(COALESCE(a.financed, a.cost)), 0) FROM fixed_assets a
             WHERE a.loan_id = n.id AND a.deleted_at IS NULL AND a.paid_how = 'loan' AND a.bought_on <= ${at}::date) AS financed,
           (SELECT COUNT(*) FROM fixed_assets a WHERE a.loan_id = n.id AND a.deleted_at IS NULL) AS asset_count
      FROM loans n
      LEFT JOIN bank_accounts b ON b.id = n.bank_account_id
     WHERE n.deleted_at IS NULL
     ORDER BY COALESCE(n.received_on, n.created_at::date) DESC, n.id DESC`;
  const repayments = await client`
    SELECT r.*, to_char(r.paid_on, 'YYYY-MM-DD') AS paid_day, b.bank_name, b.account_name, b.account_number
      FROM loan_repayments r
      LEFT JOIN bank_accounts b ON b.id = r.bank_account_id
     WHERE r.deleted_at IS NULL AND r.loan_id = ANY(${loans.map((n) => n.id)}::int[])
     ORDER BY r.paid_on DESC, r.id DESC`;
  const assets = await client`
    SELECT a.id, a.loan_id, a.name, COALESCE(a.financed, a.cost)::numeric AS financed
      FROM fixed_assets a WHERE a.deleted_at IS NULL AND a.paid_how = 'loan' AND a.loan_id = ANY(${loans.map((n) => n.id)}::int[])
     ORDER BY a.id`;

  const out = loans.map((n) => {
    const mine = repayments.filter((r) => Number(r.loan_id) === Number(n.id));
    const upTo = mine.filter((r) => r.paid_day <= at);
    const borrowed = n.kind === "hire_purchase" ? money(n.financed) : (n.received_day && n.received_day <= at ? money(n.amount) : 0);
    const repaid = money(upTo.reduce((t, r) => t + Number(r.principal), 0));
    const interest = money(upTo.reduce((t, r) => t + Number(r.interest), 0));
    return {
      id: Number(n.id),
      kind: n.kind,
      lender: n.lender,
      amount: n.amount == null ? null : money(n.amount),
      receivedOn: n.received_day,
      bankAccountId: n.bank_account_id == null ? null : Number(n.bank_account_id),
      bankName: bankLabel(n),
      interestRate: n.interest_rate == null ? null : Number(n.interest_rate),
      termMonths: n.term_months == null ? null : Number(n.term_months),
      notes: n.notes || "",
      closedOn: n.closed_day,
      borrowed,
      repaid,
      interestPaid: interest,
      stillOwed: money(borrowed - repaid),
      lastPaidOn: upTo[0]?.paid_day || null,
      assets: assets.filter((a) => Number(a.loan_id) === Number(n.id)).map((a) => ({ id: Number(a.id), name: a.name, financed: money(a.financed) })),
      repayments: mine.map((r) => ({
        id: Number(r.id),
        paidOn: r.paid_day,
        principal: money(r.principal),
        interest: money(r.interest),
        total: money(Number(r.principal) + Number(r.interest)),
        bankAccountId: r.bank_account_id == null ? null : Number(r.bank_account_id),
        bankName: bankLabel(r),
        notes: r.notes || "",
      })),
    };
  });
  return {
    at,
    loans: out,
    totals: {
      borrowed: money(out.reduce((t, n) => t + n.borrowed, 0)),
      repaid: money(out.reduce((t, n) => t + n.repaid, 0)),
      interestPaid: money(out.reduce((t, n) => t + n.interestPaid, 0)),
      stillOwed: money(out.reduce((t, n) => t + n.stillOwed, 0)),
    },
  };
}

function shapeOf(body, prev = null) {
  const v = { ...(prev || {}), ...body };
  if (!KINDS.includes(v.kind)) throw httpError(400, "Say what kind of loan it is");
  const lender = String(v.lender || "").trim();
  if (!lender) throw httpError(400, "Say who lent the money");
  const hp = v.kind === "hire_purchase";
  const amount = hp ? null : Number(v.amount);
  const receivedOn = v.receivedOn ? dayText(v.receivedOn) : null;
  const bankAccountId = hp || !v.bankAccountId ? null : Number(v.bankAccountId);
  if (!hp) {
    if (!(amount > 0)) throw httpError(400, "Say how much was borrowed");
    if (!receivedOn) throw httpError(400, "Say the day the money came in");
    if (!bankAccountId) throw httpError(400, "Say which bank account the money came into");
  }
  const rate = v.interestRate == null || v.interestRate === "" ? null : Number(v.interestRate);
  if (rate != null && !(rate >= 0 && rate < 1000)) throw httpError(400, "The interest rate is a percentage");
  const term = v.termMonths == null || v.termMonths === "" ? null : Number(v.termMonths);
  if (term != null && !(Number.isInteger(term) && term > 0)) throw httpError(400, "Say the term in months");
  return {
    kind: v.kind,
    lender: lender.slice(0, 255),
    amount: amount == null ? null : money(amount),
    received_on: receivedOn,
    bank_account_id: bankAccountId,
    interest_rate: rate,
    term_months: term,
    notes: String(v.notes || "").trim().slice(0, 2000),
    closed_on: v.closedOn ? dayText(v.closedOn) : null,
  };
}

async function current(id) {
  const [n] = await client`
    SELECT n.*, to_char(n.received_on, 'YYYY-MM-DD') AS received_day FROM loans n WHERE n.id = ${id} AND n.deleted_at IS NULL`;
  if (!n) throw httpError(404, "That loan is not on the register");
  return {
    id: Number(n.id), kind: n.kind, lender: n.lender, amount: n.amount == null ? null : Number(n.amount),
    receivedOn: n.received_day, bankAccountId: n.bank_account_id, interestRate: n.interest_rate == null ? null : Number(n.interest_rate),
    termMonths: n.term_months, notes: n.notes, closedOn: n.closed_on,
  };
}

/** Its matches on the statement are let go, so the next run matches it as it stands now. */
const forgetLoanMatch = (tx, id) => tx`DELETE FROM bank_line_classifications WHERE kind = 'loan' AND ref_id = ${id} AND auto`;
const forgetRepaymentMatch = (tx, id) => tx`DELETE FROM bank_line_classifications WHERE kind = 'loan_repayment' AND ref_id = ${id} AND auto`;

async function create(body, staffId = null) {
  const row = shapeOf(body);
  const [r] = await client`INSERT INTO loans ${client({ ...row, created_by: staffId, updated_by: staffId })} RETURNING id`;
  return { id: Number(r.id) };
}

async function update(id, body, staffId = null) {
  const prev = await current(id);
  const row = shapeOf(body, prev);
  if (prev.kind !== row.kind && (prev.kind === "hire_purchase" || row.kind === "hire_purchase")) {
    const [a] = await client`SELECT COUNT(*)::int AS n FROM fixed_assets WHERE loan_id = ${id} AND deleted_at IS NULL`;
    if (a.n > 0) throw httpError(409, "Assets are on this loan — move them off it before changing it to or from hire purchase");
  }
  await client.begin(async (tx) => {
    await tx`UPDATE loans SET ${tx({ ...row, updated_by: staffId, updated_at: new Date() })} WHERE id = ${id}`;
    await forgetLoanMatch(tx, id);
  });
  return { id };
}

async function remove(id, staffId = null) {
  await current(id);
  const [a] = await client`SELECT COUNT(*)::int AS n FROM fixed_assets WHERE loan_id = ${id} AND deleted_at IS NULL`;
  if (a.n > 0) throw httpError(409, `${a.n} asset${a.n === 1 ? " is" : "s are"} on this loan — move ${a.n === 1 ? "it" : "them"} off it first`);
  await client.begin(async (tx) => {
    await tx`UPDATE loans SET deleted_at = now(), updated_by = ${staffId}, updated_at = now() WHERE id = ${id}`;
    await forgetLoanMatch(tx, id);
    const reps = await tx`UPDATE loan_repayments SET deleted_at = now() WHERE loan_id = ${id} AND deleted_at IS NULL RETURNING id`;
    for (const r of reps) await forgetRepaymentMatch(tx, Number(r.id));
  });
  return { id };
}

async function addRepayment(loanId, body, staffId = null) {
  await current(loanId);
  const paidOn = dayText(body.paidOn);
  if (!paidOn) throw httpError(400, "Say the day it was paid");
  const principal = Number(body.principal) || 0;
  const interest = Number(body.interest) || 0;
  if (principal < 0 || interest < 0 || principal + interest <= 0) throw httpError(400, "Say how much was paid back, and how much of it was interest");
  if (!body.bankAccountId) throw httpError(400, "Say which bank account it was paid from");
  const [r] = await client`
    INSERT INTO loan_repayments ${client({
      loan_id: loanId, paid_on: paidOn, principal: money(principal), interest: money(interest),
      bank_account_id: Number(body.bankAccountId), notes: String(body.notes || "").trim().slice(0, 2000), created_by: staffId,
    })} RETURNING id`;
  return { id: Number(r.id) };
}

async function removeRepayment(loanId, repaymentId) {
  const [r] = await client`
    SELECT id FROM loan_repayments WHERE id = ${repaymentId} AND loan_id = ${loanId} AND deleted_at IS NULL`;
  if (!r) throw httpError(404, "That repayment is not on the loan");
  await client.begin(async (tx) => {
    await tx`UPDATE loan_repayments SET deleted_at = now() WHERE id = ${repaymentId}`;
    await forgetRepaymentMatch(tx, repaymentId);
  });
  return { id: repaymentId };
}

module.exports = { list, create, update, remove, addRepayment, removeRepayment, KINDS };
