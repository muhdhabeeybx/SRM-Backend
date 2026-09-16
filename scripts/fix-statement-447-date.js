/**
 * Statement 447 was uploaded with the year 2028.
 *
 * Its period_start, period_end and all four of its lines read 2028-07-08 — the
 * only non-2026 dates in bank_statement_lines (4 rows out of 4,419), so this is
 * one bad upload, not a parser fault. Two of the four lines are matched to
 * order 11651, and order_payments copies the statement's date at match time, so
 * those two payment rows carry the error too.
 *
 * dedup_key is a hash OVER the date (see bankStatement.repository.dedupKey),
 * guarded by a unique index on (bank_account_id, dedup_key). Correcting the
 * date without recomputing the key would leave the fingerprint describing a day
 * the row no longer claims — and a later re-upload of the real statement would
 * insert duplicates rather than being recognised. Both move together here.
 *
 * order_payments.txn_date is timestamptz and is deliberately left that way by
 * migration 0039; every row written before it holds Lagos midnight for the day
 * meant. The same convention is kept here so these two rows read like their
 * neighbours rather than becoming a second exception.
 *
 *   node scripts/fix-statement-447-date.js 2026-09-01           # dry run
 *   node scripts/fix-statement-447-date.js 2026-09-01 --commit  # apply
 */
require("dotenv").config();
const { client } = require("../db");
const { dedupKey } = require("../repositories/bankStatement.repository");

const STATEMENT_ID = 447;

const day = process.argv[2];
const commit = process.argv.includes("--commit");

if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) {
  console.error("Usage: node scripts/fix-statement-447-date.js <YYYY-MM-DD> [--commit]");
  process.exit(1);
}

(async () => {
  await client.begin(async (tx) => {
    const lines = await tx`
      SELECT id, bank_account_id, txn_date, amount, bank_ref, depositor, dedup_key, status
      FROM bank_statement_lines
      WHERE statement_id = ${STATEMENT_ID}
      ORDER BY id
    `;
    if (!lines.length) throw new Error(`Statement ${STATEMENT_ID} has no lines`);

    console.log(`\nStatement ${STATEMENT_ID}: ${lines.length} lines -> ${day}\n`);

    for (const line of lines) {
      const key = dedupKey({
        txnDate: day,
        bankRef: line.bank_ref,
        amount: line.amount,
        depositor: line.depositor,
      });

      // A recomputed key that already exists on this account means the real
      // statement is present twice. Stop rather than trip the unique index
      // halfway through and leave the four lines inconsistent with each other.
      const [clash] = await tx`
        SELECT id FROM bank_statement_lines
        WHERE bank_account_id = ${line.bank_account_id}
          AND dedup_key = ${key}
          AND id <> ${line.id}
        LIMIT 1
      `;
      if (clash) {
        throw new Error(
          `line ${line.id} would collide with existing line ${clash.id} on the corrected date`
        );
      }

      await tx`
        UPDATE bank_statement_lines
        SET txn_date = ${day}::date, dedup_key = ${key}
        WHERE id = ${line.id}
      `;
      console.log(
        `  line ${line.id}  ${line.txn_date.toISOString().slice(0, 10)} -> ${day}   ` +
          `${Number(line.amount).toLocaleString()}  ${line.status}  ` +
          `dedup ${line.dedup_key.slice(0, 8)} -> ${key.slice(0, 8)}`
      );
    }

    await tx`
      UPDATE bank_statements
      SET period_start = ${day}::date, period_end = ${day}::date
      WHERE id = ${STATEMENT_ID}
    `;
    console.log(`  statement ${STATEMENT_ID} period -> ${day}`);

    // Lagos midnight, matching every order_payments row written before 0039.
    const payments = await tx`
      UPDATE order_payments p
      SET txn_date = (${day}::date::timestamp AT TIME ZONE 'Africa/Lagos')
      FROM bank_statement_lines l
      WHERE l.statement_id = ${STATEMENT_ID}
        AND p.statement_line_id = l.id
      RETURNING p.id, p.order_id, p.amount, p.txn_date
    `;
    for (const p of payments) {
      console.log(
        `  payment ${p.id} (order ${p.order_id}, ${Number(p.amount).toLocaleString()}) -> ${p.txn_date.toISOString()}`
      );
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
})().catch((err) => {
  console.error("\nFailed:", err.message, "\n");
  process.exit(1);
});
