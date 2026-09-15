#!/usr/bin/env node
/**
 * Reopen orders marked Completed while trucks were still to leave.
 *
 * ── Why they are wrong ────────────────────────────────────────────────────
 *
 * Redeeming a ticket used to write Completed onto the whole order, however
 * many trucks were still to come (fixed in c848d85). The gate then refuses a
 * Completed order — "Order is Completed; it is not open for gating" — so the
 * trucks could not be exited even by hand. The bug made the jam and then
 * locked the door on it.
 *
 * This opens the door: status back to Loading, completed_at cleared, so the
 * gate accepts them and the last truck out completes each order properly.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 *
 * Completed, completed_at >= 2026-07-01, and carrying at least one truck that
 * has not gated out. 198 orders and 684 trucks at time of writing.
 *
 * 3,505 orders are affected in total, back to December 2024. The older ones
 * are deliberately left alone: those trucks left the yard long ago and only
 * the row disagrees, so reopening them would reverse two years of completed
 * history to fix a record nobody is going to act on. July is where the desk
 * still intends to gate.
 *
 * ── Why this bypasses orderStatus.transition ──────────────────────────────
 *
 * Completed is terminal in TRANSITIONS — `Completed: []` — because in the
 * normal course nothing comes back from it. These orders never legitimately
 * reached it, so the rule that guards the state machine is not the rule being
 * broken here; the row is being put back where the gate left off.
 *
 * ── What this does NOT touch ──────────────────────────────────────────────
 *
 * No money and no stock. Quantity, price, total, amount paid, payment status,
 * PFI, allocations, movements and every truck row are left exactly as they
 * are — this moves one status column and one timestamp.
 *
 * Wallet holds: none of the 198 has one, checked before writing. Even if one
 * appeared, convertHold only acts on an `active` hold and completion would be
 * a no-op the second time.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 *   node scripts/reopen-orders-with-trucks-in.js           dry run
 *   node scripts/reopen-orders-with-trucks-in.js --apply   commits
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const SINCE = "2026-07-01";

const n = (v) => Number(v || 0).toLocaleString("en-NG");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");

  try {
    const { rows: targets } = await client.query(
      `SELECT o.id, o.company_name, o.quantity, o.status::text AS status, o.completed_at,
              COUNT(t.id)::int                                            AS trucks,
              COUNT(*) FILTER (WHERE t.status <> 'gated_out')::int        AS not_out,
              COALESCE(SUM(t.quantity), 0)::numeric                       AS ticketed
         FROM orders o
         JOIN order_trucks t ON t.order_id = o.id
        WHERE o.status = 'Completed'
          AND o.completed_at >= $1
        GROUP BY o.id, o.company_name, o.quantity, o.status, o.completed_at
       HAVING COUNT(*) FILTER (WHERE t.status <> 'gated_out') > 0
        ORDER BY o.completed_at DESC, o.id DESC`,
      [SINCE]
    );

    if (!targets.length) {
      console.log("\nNothing to reopen — no Completed order since " + SINCE + " has a truck still in.\n");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }

    const ids = targets.map((t) => Number(t.id));

    // Holds are the one thing a reopen could disturb, so it is asserted rather
    // than assumed — completion converts a hold, and a second conversion on a
    // re-completion would book the spend twice if one were ever active.
    const [{ active_holds }] = (
      await client.query(
        `SELECT COUNT(*)::int AS active_holds FROM wallet_holds
          WHERE order_id = ANY($1::int[]) AND status = 'active'`,
        [ids]
      )
    ).rows;
    if (active_holds > 0) {
      throw new Error(`${active_holds} of these orders hold wallet funds — stopping rather than risk a double debit`);
    }

    const trucksToExit = targets.reduce((s, t) => s + t.not_out, 0);
    console.log(`\nReopening orders Completed on or after ${SINCE} that still have trucks in.\n`);
    console.log(`  ${targets.length} order(s), ${trucksToExit} truck(s) to exit\n`);
    for (const t of targets.slice(0, 12)) {
      console.log(
        `  ${String(t.id).padEnd(6)} ${String(t.company_name || "").slice(0, 24).padEnd(25)} ` +
          `${n(t.quantity).padStart(9)} L  ${t.not_out}/${t.trucks} still in   completed ${new Date(t.completed_at).toISOString().slice(0, 10)}`
      );
    }
    if (targets.length > 12) console.log(`  … and ${targets.length - 12} more`);
    console.log(`\n  status Completed → Loading, completed_at cleared. Nothing else changes.`);

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.\n");
      await client.end();
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(__dirname, `rollback-reopen-${stamp}.json`);
    fs.writeFileSync(
      rollbackPath,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          since: SINCE,
          orders: targets.map((t) => ({
            id: t.id,
            status: t.status,
            completed_at: t.completed_at,
          })),
        },
        null,
        2
      )
    );
    console.log(`\nRollback written to ${rollbackPath}`);

    await client.query(
      `UPDATE orders SET status = 'Loading', completed_at = NULL, updated_at = NOW()
        WHERE id = ANY($1::int[])`,
      [ids]
    );

    // One audit row each, with the states named — the transition that put them
    // in this position wrote none, which is why it could not be traced.
    for (const t of targets) {
      await client.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, prev_state, new_state, actor_type, metadata)
         VALUES ('order', $1, 'order.reopened', 'Completed', 'Loading', 'system', $2::jsonb)`,
        [
          t.id,
          JSON.stringify({
            reason:
              `Completed while ${t.not_out} of ${t.trucks} truck(s) had not gated out. Reopened so the gate will accept them; ` +
              `the last truck out will complete it properly.`,
            trucksNotOut: t.not_out,
            trucksTotal: t.trucks,
            completedAtBefore: t.completed_at,
            via: "scripts/reopen-orders-with-trucks-in.js",
          }),
        ]
      );
    }

    // ── Post-write invariants ───────────────────────────────────────────────
    const problems = [];
    const { rows: after } = await client.query(
      `SELECT o.id, o.status::text AS status, o.completed_at, o.quantity,
              o.total_amount::numeric AS total, o.amount_paid::numeric AS paid,
              o.payment_status::text AS payment_status, o.pfi_id,
              (SELECT COUNT(*) FROM order_trucks WHERE order_id = o.id)::int AS trucks
         FROM orders o WHERE o.id = ANY($1::int[]) ORDER BY o.id`,
      [ids]
    );

    if (after.length !== targets.length) problems.push(`expected ${targets.length} rows back, got ${after.length}`);
    for (const a of after) {
      const before = targets.find((t) => Number(t.id) === Number(a.id));
      const tag = `order ${a.id}`;
      if (a.status !== "Loading") problems.push(`${tag} is ${a.status}`);
      if (a.completed_at !== null) problems.push(`${tag} still carries completed_at`);
      // Nothing but the status and its timestamp may have moved.
      if (Number(a.quantity) !== Number(before.quantity)) problems.push(`${tag} quantity moved`);
      if (a.trucks !== before.trucks) problems.push(`${tag} truck count moved`);
    }

    // And every reopened order must still have a truck to exit — otherwise it
    // was completable after all and should not have been touched.
    const [{ fully_out }] = (
      await client.query(
        `SELECT COUNT(*)::int AS fully_out FROM orders o
          WHERE o.id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM order_trucks t WHERE t.order_id = o.id AND t.status <> 'gated_out')`,
        [ids]
      )
    ).rows;
    if (fully_out > 0) problems.push(`${fully_out} reopened order(s) have no truck left to exit`);

    if (problems.length) {
      console.log(`\nPOST-WRITE CHECKS FAILED:\n  ${problems.join("\n  ")}`);
      throw new Error("post-write invariant broken");
    }
    console.log(`\npost-write checks: all clear — ${after.length} order(s) now Loading`);

    await client.query("COMMIT");
    console.log("COMMITTED\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK:", err.message);
    process.exitCode = 1;
  }

  await client.end();
}

main();
