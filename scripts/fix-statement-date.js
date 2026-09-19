/**
 * Re-date a statement whose file was read the wrong way round.
 *
 * Was fix-statement-447-date.js, hardcoded to one statement and never run.
 * It is the same repair every time, so it takes the id now:
 *
 *   node scripts/fix-statement-date.js <statementId> <YYYY-MM-DD>            # dry run
 *   node scripts/fix-statement-date.js <statementId> <YYYY-MM-DD> --commit   # apply
 *
 * Run scripts/audit-statement-dates.js first — it compares every stored date
 * against the original row the file was read from and tells you which
 * statements are wrong and what they should be.
 *
 * ── What has to move together ─────────────────────────────────────────────
 *
 * dedup_key is a hash OVER the date (see bankStatement.repository.dedupKey),
 * guarded by a unique index on (bank_account_id, dedup_key). Correcting the
 * date without recomputing the key would leave the fingerprint describing a
 * day the row no longer claims — and a later re-upload of the real statement
 * would insert duplicates rather than being recognised as already held.
 *
 * order_payments copies the statement's date at match time, so a matched line
 * has a payment row carrying the same error. order_payments.txn_date is
 * timestamptz and is deliberately left that way by migration 0039; every row
 * written before it holds Lagos midnight for the day meant, and that
 * convention is kept here so these rows read like their neighbours rather
 * than becoming a second exception.
 *
 * ── This moves money between periods ──────────────────────────────────────
 *
 * The finance report filters on order_payments.txn_date. Re-dating a matched
 * line moves its payment from one period to another, and that is a decision
 * for the desk on a report that has been signed off — not something to run
 * because a date looks wrong. The dry run names every payment it would touch;
 * read it before passing --commit.
 */
require("dotenv").config();
const { client } = require("../db");
const { dedupKey } = require("../repositories/bankStatement.repository");

const STATEMENT_ID = Number(process.argv[2]);
const day = process.argv[3];
const commit = process.argv.includes("--commit");

if (!Number.isInteger(STATEMENT_ID) || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) {
  console.error("Usage: node scripts/fix-statement-date.js <statementId> <YYYY-MM-DD> [--commit]");
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
        // txn_date is a `date` column since migration 0039, so the driver
        // hands back a plain "YYYY-MM-DD" string, not a Date. The original
        // script predated that and called toISOString on it.
        `  line ${line.id}  ${String(line.txn_date).slice(0, 10)} -> ${day}   ` +
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
        `  payment ${p.id} (order ${p.order_id}, ${Number(p.amount).toLocaleString()}) -> ${new Date(p.txn_date).toISOString()}`
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
