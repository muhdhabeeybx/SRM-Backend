/**
 * The same transaction, imported twice under two different dates.
 *
 * bank_statement_lines is deduplicated on a fingerprint that INCLUDES the date
 * (see bankStatement.repository.dedupKey), so one credit read off two exports
 * of the same account that disagree by a day passes as two rows. On account 8
 * that happened 19 times on 16-17 September — an .xlsx dating them 16
 * September and a .csv dating them 15 — leaving N776,822,000 of credits
 * sitting in the unmatched pool beside their own already-matched twins, where
 * the next person to confirm a payment would have matched one as if the money
 * had arrived twice.
 *
 * The bank's transaction id is what identifies them as one: 34503253780 is
 * issued once by Zenith and never reused. Rows are therefore grouped by
 * (account, transaction id) — digits only, eight or more, the same shape test
 * the repository now applies at upload. A reference that is really narration
 * text is not an identity and is not touched here.
 *
 * WHICH COPY SURVIVES: the matched one. It is the row an order's payment was
 * confirmed against, and order_payments.statement_line_id references it. Where
 * no copy is matched the lowest id survives, being the one already in front of
 * the desk. Anything with a payment behind it is refused rather than deleted —
 * this removes surplus rows nobody has used, nothing more.
 *
 * WHAT IT DOES NOT DO: decide which date was right. The surviving row keeps
 * whatever date it was imported with, and where that is a day out it is a
 * separate correction (see fix-statement-447-date.js) — one that moves figures
 * on a signed-off finance report and therefore belongs in its own change, with
 * its own before-and-after, not folded into a cleanup.
 *
 *   node scripts/remove-duplicate-statement-lines.js            # dry run, all accounts
 *   node scripts/remove-duplicate-statement-lines.js 8          # dry run, account 8
 *   node scripts/remove-duplicate-statement-lines.js 8 --commit # apply
 */
require("dotenv").config();
const { client } = require("../db");

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const accountArg = args.find((a) => /^\d+$/.test(a));
const accountId = accountArg ? Number(accountArg) : null;

const naira = (n) => `N${Number(n).toLocaleString()}`;
const day = (d) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);

(async () => {
  await client
    .begin(async (tx) => {
      const groups = await tx`
        SELECT bank_account_id, bank_ref, count(*)::int AS n
          FROM bank_statement_lines
         WHERE bank_ref ~ '^[0-9]{8,}$'
           AND (${accountId}::int IS NULL OR bank_account_id = ${accountId}::int)
         GROUP BY bank_account_id, bank_ref
        HAVING count(*) > 1
         ORDER BY bank_account_id, bank_ref
      `;

      if (!groups.length) {
        console.log("\nNo transaction id appears twice on any account. Nothing to do.\n");
        return;
      }

      console.log(`\n${groups.length} transaction${groups.length === 1 ? "" : "s"} imported more than once\n`);

      let removed = 0;
      let removedValue = 0;

      for (const g of groups) {
        const rows = await tx`
          SELECT l.id, l.txn_date, l.amount, l.status, l.statement_id,
                 l.matched_order_id, l.depositor,
                 (SELECT count(*)::int FROM order_payments p WHERE p.statement_line_id = l.id) AS payments
            FROM bank_statement_lines l
           WHERE l.bank_account_id = ${g.bank_account_id}
             AND l.bank_ref = ${g.bank_ref}
           ORDER BY l.id
        `;

        /**
         * Two rows of the same transaction that disagree about the AMOUNT are
         * not what this script is for. That is a parse fault or a reference
         * the bank has reused, and either way deleting one would be deleting
         * evidence — so it is reported and left alone.
         */
        const amounts = new Set(rows.map((r) => Number(r.amount).toFixed(2)));
        if (amounts.size > 1) {
          console.log(
            `  ref ${g.bank_ref} (account ${g.bank_account_id}) — SKIPPED: copies disagree on amount ` +
              `(${[...amounts].map(naira).join(", ")})`,
          );
          continue;
        }

        const used = rows.filter((r) => r.payments > 0 || r.status === "MATCHED");
        if (used.length > 1) {
          console.log(
            `  ref ${g.bank_ref} (account ${g.bank_account_id}) — SKIPPED: ${used.length} copies are matched ` +
              `(lines ${used.map((r) => r.id).join(", ")}, orders ${used.map((r) => r.matched_order_id ?? "-").join(", ")}). ` +
              `This one HAS been counted twice and needs a payment removed first.`,
          );
          continue;
        }

        const keep = used[0] || rows[0];
        const drop = rows.filter((r) => r.id !== keep.id);

        console.log(
          `  ref ${g.bank_ref} (account ${g.bank_account_id}) ${naira(keep.amount)} ${keep.depositor || ""}`.trimEnd(),
        );
        console.log(
          `    keep   line ${keep.id}  ${day(keep.txn_date)}  ${keep.status}` +
            `${keep.matched_order_id ? ` -> order ${keep.matched_order_id}` : ""}  (statement ${keep.statement_id})`,
        );

        for (const r of drop) {
          console.log(
            `    delete line ${r.id}  ${day(r.txn_date)}  ${r.status}  (statement ${r.statement_id})`,
          );
          await tx`DELETE FROM bank_statement_lines WHERE id = ${r.id}`;
          removed++;
          removedValue += Number(r.amount);
        }
      }

      console.log(
        `\n${removed} surplus row${removed === 1 ? "" : "s"} removed, ${naira(removedValue)} taken back out of the pool`,
      );

      if (!commit) {
        console.log("\nDRY RUN — rolling back. Re-run with --commit to apply.\n");
        throw Object.assign(new Error("__rollback__"), { rollback: true });
      }
      console.log("\nCommitted.\n");
    })
    .catch((err) => {
      if (err.rollback) return;
      throw err;
    });

  await client.end();
})().catch((err) => {
  console.error("\nFailed:", err.message, "\n");
  process.exit(1);
});
