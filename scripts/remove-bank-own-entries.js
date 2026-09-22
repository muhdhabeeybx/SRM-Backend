/**
 * Take out the reversals and bank charges that reached the pool before the
 * upload learned to leave them out.
 *
 * Since 423bef7 a statement upload refuses the bank's own entries — ***RSVL
 * reversals, NIP charges, stamp duty — because they arrive in the credit column
 * looking exactly like a customer's money, and matching one to an order invents
 * a payment. Rows uploaded before that are still sitting UNMATCHED, one of them
 * a ₦129,870,000 reversal. This removes them.
 *
 * ── Only what nothing has touched ──────────────────────────────────────────
 *
 * A line is removed only if EVERY one of these holds, checked again under a row
 * lock inside the transaction that deletes it:
 *
 *   - status is UNMATCHED
 *   - matched_order_id, matched_delivery_sale_id and matched_deposit_id are null
 *   - no order_payments row names it (that FK is RESTRICT, so Postgres would
 *     refuse anyway — this makes the refusal a readable skip, not a crash)
 *   - no delivery_sales row names it
 *
 * A line that fails any of them is reported and left exactly where it is. If
 * one of these was matched to an order, that is a phantom payment to unwind by
 * hand with the order in front of you, not something to delete from under it.
 *
 * The rule deciding what counts as the bank's own entry is the upload's own
 * (bankStatementRepo.bankOwnEntry), not a copy — the two cannot drift.
 *
 * Usage:
 *   node scripts/remove-bank-own-entries.js            # dry run, writes nothing
 *   node scripts/remove-bank-own-entries.js --apply
 *
 * --apply writes scripts/rollback-bank-own-entries-<stamp>.json holding every
 * removed row in full, and one audit_logs row per line.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { auditLogRepo } = require("../repositories");
const bankStatementRepo = require("../repositories/bankStatement.repository");

const APPLY = process.argv.includes("--apply");
const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
const host = (u) => String(u || "").replace(/^.*@/, "").replace(/\?.*$/, "");

// Candidates: the SQL narrows cheaply, the upload's rule decides.
const CANDIDATES = sql`
  SELECT l.*,
         (SELECT COUNT(*) FROM order_payments op WHERE op.statement_line_id = l.id)::int AS payment_refs,
         (SELECT COUNT(*) FROM delivery_sales ds WHERE ds.statement_line_id = l.id)::int AS sale_refs
    FROM bank_statement_lines l
   WHERE (l.depositor || ' ' || l.narration || ' ' || l.bank_ref)
         ~* '(rsvl|rvsl|revers|charge|chrg|commission|levy|stamp duty|sms alert|maintenance)'
   ORDER BY l.amount DESC`;

const untouched = (l) =>
  l.status === "UNMATCHED" &&
  l.matched_order_id == null &&
  l.matched_delivery_sale_id == null &&
  l.matched_deposit_id == null &&
  Number(l.payment_refs) === 0 &&
  Number(l.sale_refs) === 0;

const toRow = (l) => ({ depositor: l.depositor, narration: l.narration, bankRef: l.bank_ref });

async function main() {
  console.log(`Target database: ${host(process.env.DATABASE_URL)}`);
  console.log(APPLY ? "Mode: APPLY\n" : "Mode: dry run (pass --apply to remove)\n");

  const found = await db.execute(CANDIDATES);
  const own = found
    .map((l) => ({ ...l, why: bankStatementRepo.bankOwnEntry(toRow(l)) }))
    .filter((l) => l.why);

  const remove = own.filter(untouched);
  const keep = own.filter((l) => !untouched(l));

  console.log(`Bank's own entries found: ${own.length}`);
  for (const l of remove) {
    console.log(
      `  remove  #${l.id}  ${String(l.txn_date).slice(0, 10)}  ${naira(l.amount).padStart(18)}  ${l.why.padEnd(11)}  ${l.depositor.slice(0, 50)}`,
    );
  }
  for (const l of keep) {
    console.log(
      `  KEEP    #${l.id}  ${naira(l.amount).padStart(18)}  ${l.status}  payments:${l.payment_refs} sales:${l.sale_refs}  ${l.depositor.slice(0, 40)}  — in use, unwind by hand`,
    );
  }
  const total = remove.reduce((s, l) => s + Number(l.amount), 0);
  console.log(`\nTo remove: ${remove.length} line(s), ${naira(total)}`);
  if (keep.length) console.log(`Left alone: ${keep.length} line(s) already in use`);

  if (!APPLY || !remove.length) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rollbackPath = path.join(__dirname, `rollback-bank-own-entries-${stamp}.json`);
  // Written BEFORE anything is deleted: a rollback file that only exists when
  // the run succeeded is no use for the run that did not.
  fs.writeFileSync(rollbackPath, JSON.stringify({ removedAt: new Date().toISOString(), lines: remove }, null, 2));
  console.log(`Rollback written: ${rollbackPath}`);

  let removed = 0;
  await db.transaction(async (tx) => {
    for (const l of remove) {
      // Re-check under a lock: something may have been matched since the scan.
      const rows = await tx.execute(sql`
        SELECT l.*,
               (SELECT COUNT(*) FROM order_payments op WHERE op.statement_line_id = l.id)::int AS payment_refs,
               (SELECT COUNT(*) FROM delivery_sales ds WHERE ds.statement_line_id = l.id)::int AS sale_refs
          FROM bank_statement_lines l WHERE l.id = ${l.id} FOR UPDATE`);
      const now = rows[0];
      if (!now || !untouched(now)) {
        console.log(`  skipped #${l.id} — changed since the scan`);
        continue;
      }
      await tx.execute(sql`DELETE FROM bank_statement_lines WHERE id = ${l.id}`);
      // Keep the upload's own count honest about what it now holds.
      await tx.execute(sql`
        UPDATE bank_statements SET row_count = GREATEST(row_count - 1, 0) WHERE id = ${l.statement_id}`);
      await auditLogRepo.record(
        {
          entityType: "bank_statement_line",
          entityId: l.id,
          action: "bank_statement_line.removed_bank_own_entry",
          actor: { type: "system" },
          metadata: {
            reason: l.why,
            amount: String(l.amount),
            txnDate: String(l.txn_date).slice(0, 10),
            depositor: l.depositor,
            bankAccountId: l.bank_account_id,
            statementId: l.statement_id,
            rollbackFile: path.basename(rollbackPath),
          },
        },
        tx,
      );
      removed++;
    }
  });
  console.log(`\nRemoved ${removed} line(s).`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
