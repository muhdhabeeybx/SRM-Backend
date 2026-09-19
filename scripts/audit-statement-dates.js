/**
 * Check every stored statement date against the row it was read from.
 *
 * raw_row keeps the original cells, so the file's own date string is still
 * there to be compared against what was stored. Which way round a bank writes
 * dates is decided from the rows where one component is past the 12th — those
 * cannot be ambiguous — and every line stored under the other reading is then
 * a line that is simply wrong.
 *
 *   node scripts/audit-statement-dates.js              # report only
 *   node scripts/audit-statement-dates.js --fix        # dry run of the repair
 *   node scripts/audit-statement-dates.js --fix --commit
 *
 * --fix corrects each line to the date ITS OWN raw row proves, one line at a
 * time. That matters: a statement can hold two days, and several here do, so
 * re-dating by statement would drag correct lines onto the wrong day.
 *
 * dedup_key hashes the date and is uniquely indexed per account, so it is
 * recomputed in the same step — otherwise the fingerprint describes a day the
 * row no longer claims and a re-upload of the real file would duplicate it.
 * order_payments copies the date at match time and is corrected too, at Lagos
 * midnight, the convention migration 0039 left those rows in.
 *
 * A matched line's payment moves between periods on a report that has been
 * signed off. The dry run names every one; read it before --commit.
 */
require("dotenv").config();
const { client } = require("../db");
const { dedupKey } = require("../repositories/bankStatement.repository");
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

(async () => {
  const rows = await client`
    SELECT l.id, l.bank_account_id AS acct, l.statement_id AS stmt, l.txn_date::text AS stored,
           l.amount, l.raw_row, b.bank_name, b.account_name, s.filename
      FROM bank_statement_lines l
      JOIN bank_accounts b ON b.id = l.bank_account_id
      JOIN bank_statements s ON s.id = l.statement_id
     WHERE l.raw_row::text NOT IN ('[]','{}')`;

  const per = new Map();
  for (const r of rows) {
    const raw = r.raw_row;
    const vals = Array.isArray(raw) ? raw : Object.values(raw);
    let hit = null;
    for (const v of vals) {
      const m = String(v ?? "").trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (m) { hit = m; break; }
    }
    if (!hit) continue;
    const a = Number(hit[1]), b2 = Number(hit[2]), y = Number(hit[3]);
    const dayFirst = valid(y, b2, a) ? iso(y, b2, a) : null;   // a=day, b=month
    const monthFirst = valid(y, a, b2) ? iso(y, a, b2) : null; // a=month, b=day
    const ambiguous = a <= 12 && b2 <= 12;
    const key = `${r.acct}`;
    if (!per.has(key)) per.set(key, { acct: r.acct, bank: r.bank_name, name: r.account_name, day: 0, month: 0, rows: [] });
    const g = per.get(key);
    if (!ambiguous) { if (r.stored === dayFirst) g.day++; else if (r.stored === monthFirst) g.month++; }
    g.rows.push({ id: r.id, stmt: r.stmt, file: r.filename, raw: hit[0], stored: r.stored, dayFirst, monthFirst, ambiguous, amount: r.amount });
  }

  console.log("Which way each account's file actually writes dates (from rows where a component is past the 12th):\n");
  for (const g of [...per.values()].sort((x, y2) => x.acct - y2.acct)) {
    const verdict = g.day && !g.month ? "day-first" : g.month && !g.day ? "MONTH-FIRST" : g.day || g.month ? "MIXED!" : "no evidence";
    console.log(`  acct ${String(g.acct).padStart(2)} ${(g.bank + " / " + g.name).padEnd(46)} ${g.rows.length.toString().padStart(4)} rows  evidence: day=${g.day} month=${g.month}  -> ${verdict}`);
  }

  console.log("\nLines stored under the WRONG reading for their account:\n");
  let bad = 0;
  for (const g of per.values()) {
    const truth = g.day && !g.month ? "dayFirst" : g.month && !g.day ? "monthFirst" : null;
    if (!truth) continue;
    for (const r of g.rows) {
      const want = r[truth];
      if (want && r.stored !== want) {
        bad++;
        console.log(`  line ${r.id} acct ${g.acct} stmt ${r.stmt}  raw "${r.raw}"  stored ${r.stored} -> should be ${want}   ${Number(r.amount).toLocaleString()}  ${(r.file||"").slice(0,32)}`);
      }
    }
  }
  console.log(`\n${bad} misdated line(s) with surviving evidence.`);

  if (!process.argv.includes("--fix") || !bad) {
    await client.end();
    return;
  }

  const commit = process.argv.includes("--commit");
  console.log(`\n${commit ? "APPLYING" : "DRY RUN"} — correcting ${bad} line(s)\n`);

  await client.begin(async (tx) => {
    const touchedStatements = new Set();

    for (const g of per.values()) {
      const truth = g.day && !g.month ? "dayFirst" : g.month && !g.day ? "monthFirst" : null;
      if (!truth) continue;

      for (const r of g.rows) {
        const want = r[truth];
        if (!want || r.stored === want) continue;

        const [line] = await tx`
          SELECT id, bank_account_id, amount, bank_ref, depositor
            FROM bank_statement_lines WHERE id = ${r.id}`;
        const key = dedupKey({
          txnDate: want,
          bankRef: line.bank_ref,
          amount: line.amount,
          depositor: line.depositor,
        });

        // A recomputed key already on the account means the real row is
        // present twice. Stop rather than trip the unique index halfway and
        // leave the batch inconsistent with itself.
        const [clash] = await tx`
          SELECT id FROM bank_statement_lines
           WHERE bank_account_id = ${line.bank_account_id}
             AND dedup_key = ${key} AND id <> ${line.id} LIMIT 1`;
        if (clash) {
          throw new Error(`line ${line.id} would collide with line ${clash.id} on ${want}`);
        }

        await tx`
          UPDATE bank_statement_lines
             SET txn_date = ${want}::date, dedup_key = ${key}
           WHERE id = ${line.id}`;

        const payments = await tx`
          UPDATE order_payments
             SET txn_date = (${want}::date::timestamp AT TIME ZONE 'Africa/Lagos')
           WHERE statement_line_id = ${line.id}
          RETURNING id, order_id, amount`;

        console.log(
          `  line ${line.id}  ${r.stored} -> ${want}  ${Number(line.amount).toLocaleString()}` +
            (payments.length
              ? `  [payment ${payments[0].id}, order ${payments[0].order_id} moved]`
              : "")
        );
        touchedStatements.add(r.stmt);
      }
    }

    // The statement's own period is derived from its lines and has to follow.
    for (const id of touchedStatements) {
      const [p] = await tx`
        UPDATE bank_statements s
           SET period_start = x.lo, period_end = x.hi
          FROM (SELECT min(txn_date) AS lo, max(txn_date) AS hi
                  FROM bank_statement_lines WHERE statement_id = ${id}) x
         WHERE s.id = ${id}
        RETURNING s.id, s.period_start::text AS lo, s.period_end::text AS hi`;
      console.log(`  statement ${p.id} period -> ${p.lo} .. ${p.hi}`);
    }

    if (!commit) {
      console.log("\nDRY RUN — rolling back. Re-run with --commit to apply.\n");
      throw Object.assign(new Error("__rollback__"), { rollback: true });
    }
    console.log("\nCommitted.\n");
  }).catch((err) => {
    if (err.rollback) return;
    throw err;
  });

  await client.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
