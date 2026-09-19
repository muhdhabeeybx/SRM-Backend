require("dotenv").config();
const { client } = require("../db");
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
  await client.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
