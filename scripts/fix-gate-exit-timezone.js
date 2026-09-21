#!/usr/bin/env node
/**
 * Pull hand-entered gate EXIT times back by the hour the server added to them.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * The gate forms send a `datetime-local` value: a naked wall clock,
 * "2026-09-19T17:32", with no timezone on it. Sent like that, the SERVER
 * decides what it means, because `new Date(s)` reads an offset-less datetime as
 * local to whoever parses it. Production runs in UTC and the depots run on WAT,
 * so every hand-typed exit time was stored an hour in the future.
 *
 * Fixed forward in the browser (see localDateTimeToISO in the dashboard); this
 * is the repair for what was already written.
 *
 * ── Why only exits ─────────────────────────────────────────────────────────
 *
 * Entry times are clean: all 1,839 of them sit exactly 0 minutes from their
 * own audit row, because gate-in reaches the server with no timestamp at all
 * and falls through to the server's own clock. Only the exit form actually
 * sends the string, so only exits drifted. This script touches nothing else.
 *
 * ── How a row is chosen ────────────────────────────────────────────────────
 *
 * Every candidate must sit 55–65 minutes AFTER the audit row written in the
 * same request — the hour, plus the minute or two between opening the dialog
 * and submitting it. That window is deliberately narrow and deliberately
 * forward-only:
 *
 *   - forward-only, because a legitimately corrected exit is BACKdated (an
 *     officer recording a truck that left earlier), and those are left alone;
 *   - 55–65, because nobody types an exit time an hour into the future on
 *     purpose, so a row in this window can only be the bug.
 *
 * Rows outside it are not touched, however wrong they look. This script fixes
 * one known defect, not everything that might be odd about a timestamp.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *
 *   node scripts/fix-gate-exit-timezone.js              # dry run, changes nothing
 *   node scripts/fix-gate-exit-timezone.js --apply      # writes
 *
 * A dry run prints what would change and writes the before-state to
 * gate-exit-timezone-backup-<timestamp>.json next to the working directory.
 * --apply writes that file first and only then updates, so the reversal is on
 * disk before anything moves. Reversing is the same file:
 *
 *   node scripts/fix-gate-exit-timezone.js --revert <backup.json>
 *
 * Idempotent in practice: once a row is corrected it sits ~0 minutes from its
 * audit row and no longer matches the window, so a second run finds nothing.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { db } = require("../config/db");
const { sql } = require("drizzle-orm");

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

const MIN_SECONDS = 3300; // 55 minutes
const MAX_SECONDS = 3900; // 65 minutes

async function candidates() {
  return rowsOf(
    await db.execute(sql`
      SELECT t.id,
             t.order_id            AS "orderId",
             t.truck_number        AS "truckNumber",
             t.security_exited_at  AS "storedAt",
             a.created_at          AS "recordedAt",
             ROUND(EXTRACT(EPOCH FROM (t.security_exited_at - a.created_at)) / 60)::int AS "minutesAhead"
        FROM order_trucks t
        JOIN audit_logs a
          ON a.entity_type = 'order_truck'
         AND a.entity_id   = t.id
         AND a.action      = 'order_truck.gated_out'
       WHERE t.security_exited_at IS NOT NULL
         AND EXTRACT(EPOCH FROM (t.security_exited_at - a.created_at))
             BETWEEN ${MIN_SECONDS} AND ${MAX_SECONDS}
       ORDER BY t.id
    `),
  );
}

const lagos = (d) =>
  new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Lagos", hour12: false });

async function main() {
  const apply = process.argv.includes("--apply");
  const revertIdx = process.argv.indexOf("--revert");

  if (revertIdx !== -1) {
    const file = process.argv[revertIdx + 1];
    if (!file) throw new Error("--revert needs the backup file path");
    const backup = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`Reverting ${backup.rows.length} rows from ${file}`);
    for (const r of backup.rows) {
      await db.execute(sql`
        UPDATE order_trucks SET security_exited_at = ${r.storedAt} WHERE id = ${r.id}
      `);
    }
    console.log("Reverted. Every row is back to the value in the backup.");
    return;
  }

  const rows = await candidates();
  console.log(`${rows.length} exit times sit 55-65 minutes after the moment they were recorded.`);
  if (!rows.length) {
    console.log("Nothing to do.");
    return;
  }

  const orders = new Set(rows.map((r) => r.orderId));
  console.log(`Across ${orders.size} orders.\n`);
  console.log("Sample (times shown in Lagos, which is what the officer typed and expects to see):\n");
  console.log("  truck          stored now            after the fix");
  for (const r of rows.slice(0, 8)) {
    const fixed = new Date(new Date(r.storedAt).getTime() - 3600_000);
    console.log(
      `  ${String(r.truckNumber || "—").padEnd(14)} ${lagos(r.storedAt).padEnd(21)} ${lagos(fixed)}`,
    );
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply to write.");
    return;
  }

  // The reversal goes to disk BEFORE anything moves.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(process.cwd(), `gate-exit-timezone-backup-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 2),
  );
  console.log(`\nBefore-state written to ${file}`);

  const ids = rows.map((r) => Number(r.id));
  const result = await db.execute(sql`
    UPDATE order_trucks
       SET security_exited_at = security_exited_at - INTERVAL '1 hour',
           updated_at = NOW()
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  console.log(`Updated ${result.count ?? ids.length} rows.`);

  const left = await candidates();
  console.log(`Still matching the window afterwards: ${left.length} (expected 0).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err.cause?.message || err.message);
    process.exit(1);
  });
