const { client } = require("../../db");
const { balanceOf } = require("../../repositories/bankStatement.repository");

/**
 * One bank account against its own statement.
 *
 * The books hold a bank account at exactly its statement lines (the posting
 * engine books nothing else to a bank), so the books' balance and the
 * statement's printed balance agree once every line is in. What is left to
 * look at is the other side of Suspense, for that bank:
 *
 *   money in nobody has matched       a credit no order, truck or station
 *                                     payment has claimed
 *   money out nothing explains        a withdrawal (0083)
 *   typed money with no line yet      a deposit, refund or expense payment
 *                                     typed in, waiting for the bank's line
 *
 * A pair that is the same money — an expense paid and its withdrawal — clears
 * itself in Suspense. A line no record explains at all (a loan, capital, tax
 * paid to FIRS) is named by Finance, to an account (classify).
 */

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Where an account's statement prints its running balance: the column headed so, if the format has one. */
const BALANCE_HEADING = /^(balance|running balance|closing balance|ledger balance|book balance|avail(able)? balance|avail balance)$/;
async function balanceColumn(bankAccountId) {
  const [m] = await client`SELECT sample_headers FROM bank_statement_column_mappings WHERE bank_account_id = ${bankAccountId}`;
  const headers = Array.isArray(m?.sample_headers) ? m.sample_headers : (Array.isArray(m?.sample_headers?.keys) ? m.sample_headers.keys : []);
  const at = headers.map((h) => String(h ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim()).findIndex((h) => BALANCE_HEADING.test(h));
  return at >= 0 ? { at, width: headers.length } : null;
}

/**
 * A row's running balance: the cell under the Balance heading when the row is
 * laid out as the account's format is, else the last number in the row
 * (repositories/bankStatement balanceOf). The heading matters: Zenith's
 * export ends with a PaymentId after the balance, which the last number would
 * read as the balance.
 */
function rowBalance(rawRow, amount, column) {
  // Rows carried from the old system are kept by heading ({ "Balance": … }).
  if (rawRow && typeof rawRow === "object" && !Array.isArray(rawRow)) {
    const key = Object.keys(rawRow).find((k) => BALANCE_HEADING.test(String(k).toLowerCase().replace(/[^a-z]+/g, " ").trim()));
    const s = key == null ? "" : String(rawRow[key] ?? "").replace(/[,\s"'₦]/g, "");
    return /^-?\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) / 100 : null;
  }
  const cells = Array.isArray(rawRow) ? rawRow : [];
  if (column && cells.length === column.width) {
    const s = String(cells[column.at] ?? "").replace(/[,\s"'₦]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 100) / 100;
    return null;
  }
  return balanceOf(rawRow, amount);
}

/**
 * The balance the statement prints at the end of a day — its last day with a
 * printed balance on or before the one asked for.
 *
 * Which row of a day is the last is not the order rows were stored in (some
 * exports run newest first): it is the row whose balance no other row of that
 * day leads to. Each row's balance less its own movement is the balance
 * before it, so the day's rows chain together and the end of the chain is the
 * day's closing balance. With a row missing — money out not yet uploaded — the
 * chain can break; then the latest row stored is taken.
 */
async function statementBalance(bankAccountId, day) {
  const column = await balanceColumn(bankAccountId);
  const rows = await client`
    SELECT side, amount, raw_row, to_char(txn_date, 'YYYY-MM-DD') AS day, created_at, id FROM (
      SELECT 'credit' AS side, amount, raw_row, txn_date, created_at, id FROM bank_statement_lines
       WHERE bank_account_id = ${bankAccountId} AND (${day}::date IS NULL OR txn_date <= ${day}::date)
         AND txn_date >= COALESCE((SELECT MAX(txn_date) FROM bank_statement_lines
                                    WHERE bank_account_id = ${bankAccountId} AND (${day}::date IS NULL OR txn_date <= ${day}::date)), '1900-01-01') - 31
      UNION ALL
      SELECT 'debit', amount, raw_row, txn_date, created_at, id FROM bank_statement_debits
       WHERE bank_account_id = ${bankAccountId} AND (${day}::date IS NULL OR txn_date <= ${day}::date)
         AND txn_date >= COALESCE((SELECT MAX(txn_date) FROM bank_statement_debits
                                    WHERE bank_account_id = ${bankAccountId} AND (${day}::date IS NULL OR txn_date <= ${day}::date)), '1900-01-01') - 31
    ) x
    ORDER BY txn_date DESC, created_at DESC, id DESC`;
  const withBalance = rows
    .map((r) => ({ ...r, balance: rowBalance(r.raw_row, r.amount, column), move: (r.side === "credit" ? 1 : -1) * Number(r.amount) }))
    .filter((r) => r.balance != null);
  if (!withBalance.length) return null;
  const lastDay = withBalance[0].day;
  const sameDay = withBalance.filter((r) => r.day === lastDay);
  const kobo = (v) => Math.round(v * 100);
  const before = new Set(sameDay.map((r) => kobo(r.balance - r.move)));
  const ends = sameDay.filter((r) => !before.has(kobo(r.balance)));
  const end = ends.length === 1 ? ends[0] : sameDay[0];
  return { balance: end.balance, day: lastDay };
}

async function reconciliation({ bankAccountId, from = null, to = null }) {
  const id = Number(bankAccountId);
  const [account] = await client`SELECT id, gl_code, name FROM expense_categories WHERE bank_account_id = ${id}`;
  if (!account) throw httpError(404, "That bank account has no account in the books yet");

  const [books] = await client`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ${account.id} AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)`;
  const printed = await statementBalance(id, to);

  const range = (col) => client`
    (${from}::date IS NULL OR ${client.unsafe(col)} >= ${from}::date) AND (${to}::date IS NULL OR ${client.unsafe(col)} <= ${to}::date)`;

  const moneyIn = await client`
    SELECT l.id, to_char(l.txn_date, 'YYYY-MM-DD') AS day, l.amount::numeric AS amount, l.depositor AS who,
           l.bank_ref, l.narration, k.account_id, c.gl_code, c.name AS account_name, k.note, k.kind, k.auto
      FROM bank_statement_lines l
      LEFT JOIN bank_line_classifications k ON k.direction = 'credit' AND k.line_id = l.id
      LEFT JOIN expense_categories c ON c.id = k.account_id
     WHERE l.bank_account_id = ${id} AND l.amount > 0 AND ${range("l.txn_date")}
       AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.statement_line_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM delivery_sales s WHERE s.statement_line_id = l.id)
     ORDER BY l.txn_date, l.id`;
  const moneyOut = await client`
    SELECT l.id, to_char(l.txn_date, 'YYYY-MM-DD') AS day, l.amount::numeric AS amount, l.beneficiary AS who,
           l.bank_ref, l.narration, k.account_id, c.gl_code, c.name AS account_name, k.note, k.kind, k.auto
      FROM bank_statement_debits l
      LEFT JOIN bank_line_classifications k ON k.direction = 'debit' AND k.line_id = l.id
      LEFT JOIN expense_categories c ON c.id = k.account_id
     WHERE l.bank_account_id = ${id} AND ${range("l.txn_date")}
     ORDER BY l.txn_date, l.id`;
  // Money typed in or paid out against this bank with no statement line of
  // its own: the other side of Suspense, by the bank it named.
  const typed = await client`
    SELECT e.id AS entry_id, e.entry_date::text AS day, e.source_type, e.memo, SUM(l.debit - l.credit) AS amount
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = (SELECT id FROM expense_categories WHERE system_key = 'suspense')
       AND l.bank_account_id = ${id}
       AND e.source_type IS DISTINCT FROM 'bank_line' AND e.source_type IS DISTINCT FROM 'bank_debit'
       AND ${range("e.entry_date")}
     GROUP BY e.id, e.entry_date, e.source_type, e.memo
    HAVING SUM(l.debit - l.credit) <> 0
     ORDER BY e.entry_date, e.id`;

  // A line looked at and left is still to explain; anything else named or
  // recognised says what it was, and whether a person or the system said so.
  const line = (r) => ({
    id: Number(r.id), day: r.day, amount: money(r.amount), who: r.who || "", bankRef: r.bank_ref || "", narration: r.narration || "",
    namedTo: r.account_id && r.kind !== "left"
      ? { accountId: Number(r.account_id), code: r.gl_code || "", name: r.account_name, note: r.note || "", kind: r.kind || "account", auto: !!r.auto }
      : null,
  });
  const ins = moneyIn.map(line);
  const outs = moneyOut.map(line);
  const sum = (xs) => money(xs.reduce((t, x) => t + x.amount, 0));
  return {
    account: { id: Number(account.id), code: account.gl_code, name: account.name },
    period: { from, to },
    booksBalance: money(books.b),
    statementBalance: printed?.balance ?? null,
    statementBalanceDay: printed?.day ?? null,
    difference: printed ? money(money(books.b) - printed.balance) : null,
    moneyIn: ins,
    moneyOut: outs,
    typed: typed.map((t) => ({ entryId: Number(t.entry_id), day: t.day, source: t.source_type, memo: t.memo, amount: money(t.amount) })),
    totals: {
      inUnmatched: sum(ins.filter((x) => !x.namedTo)),
      outUnexplained: sum(outs.filter((x) => !x.namedTo)),
      sortedAutomatically: [...ins, ...outs].filter((x) => x.namedTo?.auto).length,
      typedWaiting: money(typed.reduce((t, x) => t + Number(x.amount), 0)),
    },
  };
}

/**
 * Name what a line was: an account in the chart, and a note. Not a bank and
 * not Suspense — money between two of our own banks needs no naming, it
 * clears itself through Suspense — and not a line a payment has already
 * claimed.
 */
async function classify({ direction, lineId, accountId, vendorId = null, note = "", staffId = null }) {
  const [acct] = await client`SELECT id, name, system_key, bank_account_id FROM expense_categories WHERE id = ${Number(accountId)}`;
  if (!acct) throw httpError(400, "That account is not in the chart");
  if (acct.bank_account_id != null || acct.system_key === "suspense") {
    throw httpError(400, "Money between our own banks needs no naming — leave both lines, and they clear each other");
  }
  const table = direction === "credit" ? "bank_statement_lines" : "bank_statement_debits";
  const [line] = await client`SELECT id FROM ${client(table)} WHERE id = ${Number(lineId)}`;
  if (!line) throw httpError(404, "That bank line is not on file");
  if (direction === "credit") {
    const [claimed] = await client`
      SELECT 1 FROM order_payments WHERE statement_line_id = ${Number(lineId)}
      UNION ALL SELECT 1 FROM delivery_sales WHERE statement_line_id = ${Number(lineId)} LIMIT 1`;
    if (claimed) throw httpError(409, "A payment has already claimed that line");
  }
  // A person's naming replaces whatever the system recognised.
  await client`
    INSERT INTO bank_line_classifications (direction, line_id, account_id, vendor_id, note, created_by, kind, ref_id, auto)
    VALUES (${direction}, ${Number(lineId)}, ${acct.id}, ${vendorId}, ${note || ""}, ${staffId}, 'account', NULL, false)
    ON CONFLICT (direction, line_id) DO UPDATE
      SET account_id = EXCLUDED.account_id, vendor_id = EXCLUDED.vendor_id, note = EXCLUDED.note,
          created_by = EXCLUDED.created_by, created_at = now(), kind = 'account', ref_id = NULL, auto = false`;
  return { direction, lineId: Number(lineId), accountId: Number(acct.id), account: acct.name };
}

/**
 * Take back what a line was said to be — by a person or by the system — and
 * leave it to explain. Kept as "left" rather than deleted, so the next posting
 * run does not recognise it all over again.
 */
async function unclassify({ direction, lineId, staffId = null }) {
  const [suspense] = await client`SELECT id FROM expense_categories WHERE system_key = 'suspense'`;
  await client`
    INSERT INTO bank_line_classifications (direction, line_id, account_id, note, created_by, kind, ref_id, auto)
    VALUES (${direction}, ${Number(lineId)}, ${suspense.id}, 'Left to explain', ${staffId}, 'left', NULL, false)
    ON CONFLICT (direction, line_id) DO UPDATE
      SET account_id = EXCLUDED.account_id, vendor_id = NULL, note = EXCLUDED.note, created_by = EXCLUDED.created_by,
          created_at = now(), kind = 'left', ref_id = NULL, auto = false`;
  return { direction, lineId: Number(lineId) };
}

/**
 * Every bank account at a glance: its statement's balance against the books',
 * money in and out over the period, and how much is still to explain — the
 * first table on the Banks page. Accounts with no statement and nothing in
 * the books are left off.
 */
async function banks({ from = null, to = null } = {}) {
  const range = (col) => client`
    (${from}::date IS NULL OR ${client.unsafe(col)} >= ${from}::date) AND (${to}::date IS NULL OR ${client.unsafe(col)} <= ${to}::date)`;
  const rows = await client`
    SELECT b.id, b.bank_name, b.account_name, b.account_number, c.id AS account_id,
           (SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
             WHERE l.account_id = c.id AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)) AS books,
           (SELECT COALESCE(SUM(x.amount), 0) FROM bank_statement_lines x WHERE x.bank_account_id = b.id AND x.amount > 0 AND ${range("x.txn_date")}) AS money_in,
           (SELECT COALESCE(SUM(x.amount), 0) FROM bank_statement_debits x WHERE x.bank_account_id = b.id AND ${range("x.txn_date")}) AS money_out,
           (SELECT COUNT(*) FROM bank_statement_lines x
             LEFT JOIN bank_line_classifications k ON k.direction = 'credit' AND k.line_id = x.id
             WHERE x.bank_account_id = b.id AND x.amount > 0 AND ${range("x.txn_date")}
               AND (k.id IS NULL OR k.kind = 'left')
               AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.statement_line_id = x.id)
               AND NOT EXISTS (SELECT 1 FROM delivery_sales s WHERE s.statement_line_id = x.id)) AS in_open,
           (SELECT COALESCE(SUM(x.amount), 0) FROM bank_statement_lines x
             LEFT JOIN bank_line_classifications k ON k.direction = 'credit' AND k.line_id = x.id
             WHERE x.bank_account_id = b.id AND x.amount > 0 AND ${range("x.txn_date")}
               AND (k.id IS NULL OR k.kind = 'left')
               AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.statement_line_id = x.id)
               AND NOT EXISTS (SELECT 1 FROM delivery_sales s WHERE s.statement_line_id = x.id)) AS in_open_amount,
           (SELECT COUNT(*) FROM bank_statement_debits x
             LEFT JOIN bank_line_classifications k ON k.direction = 'debit' AND k.line_id = x.id
             WHERE x.bank_account_id = b.id AND ${range("x.txn_date")} AND (k.id IS NULL OR k.kind = 'left')) AS out_open,
           (SELECT COALESCE(SUM(x.amount), 0) FROM bank_statement_debits x
             LEFT JOIN bank_line_classifications k ON k.direction = 'debit' AND k.line_id = x.id
             WHERE x.bank_account_id = b.id AND ${range("x.txn_date")} AND (k.id IS NULL OR k.kind = 'left')) AS out_open_amount,
           (SELECT MAX(d) FROM (SELECT MAX(txn_date) AS d FROM bank_statement_lines WHERE bank_account_id = b.id
                                UNION ALL SELECT MAX(txn_date) FROM bank_statement_debits WHERE bank_account_id = b.id) z)::text AS last_line
      FROM bank_accounts b
      JOIN expense_categories c ON c.bank_account_id = b.id
     ORDER BY b.bank_name, b.account_name`;
  const out = [];
  for (const r of rows) {
    const printed = await statementBalance(Number(r.id), to);
    const books = money(r.books);
    if (!printed && !r.last_line && books === 0) continue;
    out.push({
      bankAccountId: Number(r.id),
      accountId: Number(r.account_id),
      name: `${r.bank_name} · ${r.account_name}`,
      number: r.account_number ? String(r.account_number).slice(-4) : "",
      statementBalance: printed?.balance ?? null,
      statementBalanceDay: printed?.day ?? null,
      booksBalance: books,
      difference: printed ? money(books - printed.balance) : null,
      moneyIn: money(r.money_in),
      moneyOut: money(r.money_out),
      toExplain: { count: Number(r.in_open) + Number(r.out_open), amount: money(Number(r.in_open_amount) + Number(r.out_open_amount)) },
      lastLine: r.last_line ? String(r.last_line).slice(0, 10) : null,
    });
  }
  return { period: { from, to }, banks: out };
}

module.exports = { reconciliation, classify, unclassify, statementBalance, banks };
