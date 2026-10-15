const { client } = require("../../db");

/**
 * What a bank line no record has claimed turned out to be, recognised before
 * every posting run so a person only looks at what is left (0085).
 *
 * How Soroman's money moves (studied on the live book, 14 Oct 2026):
 * customers pay into the collection accounts; money is moved from there to
 * Fidelity Expenses (and other accounts) and to cargo suppliers; expenses are
 * paid out of Fidelity Expenses; the bank takes its charges. So, in this order,
 * each kind taking only lines nothing earlier took:
 *
 *   transfer   a withdrawal from one of our accounts and money in to another,
 *              the same amount, the money in at most a day before or three
 *              after. And money in from an account of our own whose
 *              statement is not on file — the payer is one of our names
 *              ("SOROMAN WARRI/…", "ACTION ENERGY L/…") — waiting for its
 *              other side.
 *   expense    the withdrawal that paid an expense marked paid: the same
 *              amount, from three days before to a week after the day it was
 *              marked paid, out of the bank the expense names if it names one
 *   refund     the same for a refund paid to a customer
 *   charges    the bank's own charge — its wording (the upload's own list,
 *              less "commission", which commission payments are called too)
 *              and ₦100,000 or less
 *   supplier   paid to a cargo's supplier (named on the PFI), or to Dangote
 *   asset,     the Fixed Assets and Loans registers (0088): an asset paid
 *   loan, …    for from a bank (or a hire purchase's deposit), a loan paid
 *              back, money in from a lender or for an asset sold — the same
 *              amount, in the bank the record names, from three days before
 *              to a week after its day
 *
 * Never over a person: a line Finance has named, or looked at and left, is
 * not touched. A match is written once and stays; the posting engine books it
 * (postingSources/bankLines, expenses, orders).
 */

const DAY_MS = 86_400_000;
const dayNo = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / DAY_MS);
const kobo = (v) => Math.round(Number(v) * 100);
const words = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const shiftDay = (day, n) => new Date((dayNo(day) + n) * DAY_MS).toISOString().slice(0, 10);

/** Whole-word bank charge wording, less "commission" (commission payments say it too). */
const BANK_CHARGE = /\b(charge|charges|chrg|levy|emtl)\b|\bstamp duty\b|\bsms alert\b|\bmaintenance fee\b|\baccount maintenance\b|\bcommission on turnover\b|\bcot\b/i;
const CHARGE_LIMIT = 100_000;

/**
 * The names our own accounts send money as: the first two words of every
 * account's name ("SOROMAN WARRI", "ACTION ENERGY", "NURA MANU"), and the
 * group's own name where three or more accounts start with it ("SOROMAN").
 */
function ownNames(accounts) {
  const names = new Set();
  const firsts = new Map();
  for (const a of accounts) {
    const w = words(a.account_name).split(" ").filter(Boolean);
    if (w.length >= 2) names.add(`${w[0]} ${w[1]}`);
    if (w[0]) firsts.set(w[0], (firsts.get(w[0]) || 0) + 1);
  }
  for (const [w, n] of firsts) if (n >= 3 && w.length >= 5) names.add(w);
  return [...names];
}
const sentByUs = (text, names) => {
  const t = words(text);
  return t !== "" && names.some((n) => t === n || t.startsWith(`${n} `));
};

/** The bank an expense says it was paid from ("Fidelity Bank · 5540074886"), by the last ten digits. */
const bankByDigits = (banks) => (label) => {
  const digits = String(label || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const hit = banks.find((b) => {
    const own = String(b.account_number || "").replace(/\D/g, "");
    return own.length >= 10 && digits.includes(own.slice(-10));
  });
  return hit ? Number(hit.id) : null;
};

/** The nearest unused candidate by days apart, then the earliest line. */
const nearest = (cands, day) =>
  cands.sort((a, b) => Math.abs(dayNo(a.day) - dayNo(day)) - Math.abs(dayNo(b.day) - dayNo(day)) || a.id - b.id)[0] || null;

/**
 * @param {{ booksStart: string }} p
 * @returns {Promise<Record<string, number>>} how many lines of each kind were recognised
 */
async function recognise({ booksStart }) {
  const keys = new Map((await client`SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`)
    .map((r) => [r.system_key, Number(r.id)]));
  const needed = ["transfers_clearing", "vendor_payables", "customer_receivables", "bank_charges", "supplier_payables"];
  if (needed.some((k) => !keys.has(k))) return { skipped: 1 };
  // Lines from a little before the books start, so a transfer across the start pairs.
  const since = shiftDay(booksStart, -10);

  const banks = await client`SELECT id, bank_name, account_name, account_number FROM bank_accounts`;
  const bankName = new Map(banks.map((b) => [Number(b.id), `${b.bank_name} · ${b.account_name}`]));
  const names = ownNames(banks);
  const bankOf = bankByDigits(banks);

  const credits = (await client`
    SELECT l.id, l.bank_account_id, l.amount::numeric AS amount, to_char(l.txn_date, 'YYYY-MM-DD') AS day,
           l.depositor, l.narration, k.kind
      FROM bank_statement_lines l
      LEFT JOIN bank_line_classifications k ON k.direction = 'credit' AND k.line_id = l.id
     WHERE l.amount > 0 AND l.txn_date >= ${since}::date
       AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.statement_line_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM delivery_sales s WHERE s.statement_line_id = l.id)
       -- Open, or money in from ourselves still waiting for its other side.
       AND (k.id IS NULL OR (k.kind = 'transfer' AND k.ref_id IS NULL))`)
    .map((c) => ({ ...c, id: Number(c.id), bank: Number(c.bank_account_id), k: kobo(c.amount) }));
  const debits = (await client`
    SELECT l.id, l.bank_account_id, l.amount::numeric AS amount, to_char(l.txn_date, 'YYYY-MM-DD') AS day,
           l.beneficiary, l.narration, l.bank_ref
      FROM bank_statement_debits l
     WHERE l.txn_date >= ${since}::date
       AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.direction = 'debit' AND k.line_id = l.id)
     ORDER BY l.txn_date, l.id`)
    .map((d) => ({ ...d, id: Number(d.id), bank: Number(d.bank_account_id), k: kobo(d.amount) }));

  const found = [];
  const credited = new Set();
  const debited = new Set();
  const open = (d) => !debited.has(d.id);

  // ── Transfers between our own accounts ──────────────────────────────────
  const creditsByAmount = new Map();
  for (const c of credits) {
    if (!creditsByAmount.has(c.k)) creditsByAmount.set(c.k, []);
    creditsByAmount.get(c.k).push(c);
  }
  for (const d of debits) {
    const cands = (creditsByAmount.get(d.k) || []).filter((c) => !credited.has(c.id) && c.bank !== d.bank
      && dayNo(c.day) - dayNo(d.day) >= -1 && dayNo(c.day) - dayNo(d.day) <= 3);
    const c = nearest(cands, d.day);
    if (!c) continue;
    credited.add(c.id);
    debited.add(d.id);
    found.push({ direction: "debit", lineId: d.id, kind: "transfer", account: "transfers_clearing", refId: c.id, note: `Moved to ${bankName.get(c.bank) || "another of our accounts"}` });
    found.push({ direction: "credit", lineId: c.id, kind: "transfer", account: "transfers_clearing", refId: d.id, note: `Moved from ${bankName.get(d.bank) || "another of our accounts"}`, existing: c.kind === "transfer" });
  }
  for (const c of credits) {
    if (credited.has(c.id) || c.kind) continue;
    if (!sentByUs(c.depositor || c.narration, names)) continue;
    credited.add(c.id);
    found.push({ direction: "credit", lineId: c.id, kind: "transfer", account: "transfers_clearing", refId: null, note: `From our own account (${String(c.depositor || c.narration).trim().slice(0, 80)}); its other side is not on file yet` });
  }

  // ── Expenses paid, and refunds paid ─────────────────────────────────────
  const pair = (rows, kind, account, noteOf) => {
    for (const r of rows) {
      const cands = debits.filter((d) => open(d) && d.k === kobo(r.amount)
        && (r.bank == null || d.bank === Number(r.bank))
        && dayNo(d.day) - dayNo(r.day) >= -3 && dayNo(d.day) - dayNo(r.day) <= 7);
      const d = nearest(cands, r.day);
      if (!d) continue;
      debited.add(d.id);
      found.push({ direction: "debit", lineId: d.id, kind, account, refId: Number(r.id), note: noteOf(r) });
    }
  };
  const expenses = (await client`
    SELECT e.id, e.reference_number AS ref, e.bank_paid_from,
           COALESCE(e.amount_paid_ngn, CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN e.amount_paid END)::numeric AS amount,
           to_char(COALESCE(e.payment_date, e.paid_at) AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day
      FROM pfi_expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.deleted_at IS NULL AND e.status = 'paid' AND NOT COALESCE(c.is_refund, false)
       AND COALESCE(e.payment_date, e.paid_at) >= ${since}::date
       AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.kind = 'expense' AND k.ref_id = e.id)
     ORDER BY COALESCE(e.payment_date, e.paid_at), e.id`)
    .filter((e) => Number(e.amount) > 0 && e.day)
    .map((e) => ({ ...e, bank: bankOf(e.bank_paid_from) }));
  pair(expenses, "expense", "vendor_payables", (e) => `Paid expense ${e.ref || `#${e.id}`}`);

  const refunds = await client`
    SELECT p.id, (-p.amount)::numeric AS amount, p.bank_account_id AS bank, o.order_number AS ref,
           to_char(COALESCE(p.txn_date, p.created_at) AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day
      FROM order_payments p JOIN orders o ON o.id = p.order_id
     WHERE p.source = 'refund' AND p.amount < 0 AND COALESCE(p.txn_date, p.created_at) >= ${since}::date
       AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.kind = 'refund' AND k.ref_id = p.id)
     ORDER BY COALESCE(p.txn_date, p.created_at), p.id`;
  pair(refunds, "refund", "customer_receivables", (r) => `Refund paid on ${r.ref}`);

  // ── The Fixed Assets and Loans registers (0088) ─────────────────────────
  if (keys.has("fixed_assets") && keys.has("loans")) {
    const assetsPaid = await client`
      SELECT a.id, a.name, a.bank_account_id AS bank, to_char(a.bought_on, 'YYYY-MM-DD') AS day,
             (CASE WHEN a.paid_how = 'bank' THEN a.cost ELSE a.cost - COALESCE(a.financed, a.cost) END)::numeric AS amount
        FROM fixed_assets a
       WHERE a.deleted_at IS NULL AND a.paid_how IN ('bank', 'loan') AND a.bank_account_id IS NOT NULL
         AND a.bought_on >= ${since}::date
         AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.kind = 'asset' AND k.ref_id = a.id)
       ORDER BY a.bought_on, a.id`;
    pair(assetsPaid.filter((a) => Number(a.amount) > 0), "asset", "fixed_assets", (a) => `Paid for ${a.name}`);

    const repaid = await client`
      SELECT r.id, n.lender, r.bank_account_id AS bank, to_char(r.paid_on, 'YYYY-MM-DD') AS day,
             (r.principal + r.interest)::numeric AS amount
        FROM loan_repayments r JOIN loans n ON n.id = r.loan_id
       WHERE r.deleted_at IS NULL AND n.deleted_at IS NULL AND r.bank_account_id IS NOT NULL
         AND r.paid_on >= ${since}::date
         AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.kind = 'loan_repayment' AND k.ref_id = r.id)
       ORDER BY r.paid_on, r.id`;
    pair(repaid, "loan_repayment", "loans", (r) => `Loan repaid to ${r.lender}`);

    // Money in: a lender's money, and what an asset fetched.
    const pairIn = (rows, kind, account, noteOf) => {
      for (const r of rows) {
        const cands = credits.filter((c) => !credited.has(c.id) && !c.kind && c.k === kobo(r.amount)
          && c.bank === Number(r.bank)
          && dayNo(c.day) - dayNo(r.day) >= -3 && dayNo(c.day) - dayNo(r.day) <= 7);
        const c = nearest(cands, r.day);
        if (!c) continue;
        credited.add(c.id);
        found.push({ direction: "credit", lineId: c.id, kind, account, refId: Number(r.id), note: noteOf(r) });
      }
    };
    const lent = await client`
      SELECT n.id, n.lender, n.bank_account_id AS bank, to_char(n.received_on, 'YYYY-MM-DD') AS day, n.amount::numeric AS amount
        FROM loans n
       WHERE n.deleted_at IS NULL AND n.kind <> 'hire_purchase' AND n.amount > 0 AND n.bank_account_id IS NOT NULL
         AND n.received_on >= ${since}::date
         AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.kind = 'loan' AND k.ref_id = n.id)
       ORDER BY n.received_on, n.id`;
    pairIn(lent, "loan", "loans", (n) => `Loan from ${n.lender}`);
    const fetched = await client`
      SELECT a.id, a.name, a.disposed_bank_account_id AS bank, to_char(a.disposed_on, 'YYYY-MM-DD') AS day,
             a.disposed_for::numeric AS amount
        FROM fixed_assets a
       WHERE a.deleted_at IS NULL AND a.disposed_on IS NOT NULL AND a.disposed_for > 0
         AND a.disposed_bank_account_id IS NOT NULL AND a.disposed_on >= ${since}::date
         AND NOT EXISTS (SELECT 1 FROM bank_line_classifications k WHERE k.kind = 'asset_sale' AND k.ref_id = a.id)
       ORDER BY a.disposed_on, a.id`;
    pairIn(fetched, "asset_sale", "fixed_assets", (a) => `${a.name} sold`);
  }

  // ── The bank's own charges ──────────────────────────────────────────────
  for (const d of debits) {
    if (!open(d) || Number(d.amount) > CHARGE_LIMIT) continue;
    if (!BANK_CHARGE.test(`${d.beneficiary || ""} ${d.narration || ""} ${d.bank_ref || ""}`)) continue;
    debited.add(d.id);
    found.push({ direction: "debit", lineId: d.id, kind: "charges", account: "bank_charges", refId: null, note: "Bank charge" });
  }

  // ── Paid for cargo ──────────────────────────────────────────────────────
  const suppliers = (await client`
    SELECT DISTINCT v.id, v.name FROM pfis p JOIN vendors v ON v.id = p.supplier_vendor_id`)
    .map((v) => ({ id: Number(v.id), name: words(v.name) }))
    .filter((v) => v.name.length >= 5);
  for (const d of debits) {
    if (!open(d)) continue;
    const text = words(`${d.beneficiary || ""} ${d.narration || ""}`);
    const vendor = suppliers.find((v) => text.includes(v.name));
    if (!vendor && !/\bDANGOTE\b/.test(text)) continue;
    debited.add(d.id);
    found.push({
      direction: "debit", lineId: d.id, kind: "supplier", account: "supplier_payables", refId: null,
      vendorId: vendor ? vendor.id : null, note: `Paid for cargo${vendor ? ` to ${vendor.name}` : ""}`,
    });
  }

  // Written once; a line someone named in the meantime keeps their name.
  const counts = {};
  for (const f of found) {
    if (f.existing) {
      await client`
        UPDATE bank_line_classifications SET ref_id = ${f.refId}, note = ${f.note}
         WHERE direction = 'credit' AND line_id = ${f.lineId} AND kind = 'transfer' AND ref_id IS NULL`;
    } else {
      const [row] = await client`
        INSERT INTO bank_line_classifications (direction, line_id, account_id, vendor_id, note, kind, ref_id, auto)
        VALUES (${f.direction}, ${f.lineId}, ${keys.get(f.account)}, ${f.vendorId ?? null}, ${f.note}, ${f.kind}, ${f.refId}, true)
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!row) continue;
    }
    counts[f.kind] = (counts[f.kind] || 0) + 1;
  }
  return counts;
}

module.exports = { recognise, ownNames, sentByUs, BANK_CHARGE };
