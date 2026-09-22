#!/usr/bin/env node
/**
 * Make pfis.sold_qty_litres agree with the orders underneath it again.
 *
 * ── The invariant, and where it broke ──────────────────────────────────────
 *
 *   pfis.sold_qty_litres = SUM(orders.quantity)
 *                          WHERE orders.pfi_id = pfi
 *                            AND orders.status NOT IN ('Cancelled','Expired')
 *
 * The counter means "litres spoken for on this batch". It is not derived: only
 * `reserveStock` raises it and only `releaseStock` lowers it, both inside the
 * transaction of the order write that caused the change. Payment is NOT part
 * of it — an order reserves its litres the moment it is placed, because the
 * product cannot be sold twice while somebody is paying for it.
 *
 * The bulk-assign endpoint broke it. `assignOrdersToPfi` set orders.pfi_id and
 * nothing else, so the litres moved in the orders table while the reservation
 * stayed on the batch the order left and was never added to the batch it
 * joined. Both batches came out wrong, in opposite directions, silently. That
 * is fixed at source in controllers/administration/pfi.controller.js; this
 * repairs the arithmetic it already got wrong.
 *
 * ── Why this matters beyond a wrong number on a page ───────────────────────
 *
 * The Create Order page offers `starting_qty_litres - sold_qty_litres` as
 * available stock (services/pfi.service.js), and `reserveStock` uses the same
 * subtraction to decide whether an order may be placed at all. So a counter
 * that reads LOW lets the company sell product it has already sold.
 *
 * ── The two directions are NOT the same problem ────────────────────────────
 *
 * counter < orders   (the common case; 36 batches, up to 20.3M litres)
 *     The batch is offering litres that are already on an order. Raising the
 *     counter takes them back off the shelf. This direction can only ever
 *     PREVENT a sale that should not have been possible, so it is the safe
 *     one — and it is the one that matters operationally.
 *
 * counter > orders   (2 batches: PFI 7 by 50.3M, PFI 45 by 270,000)
 *     The batch is holding litres no order claims, so stock nobody can buy.
 *     Lowering the counter puts them back on sale. That is the right answer
 *     if and only if the orders table is complete for this batch — so this
 *     direction needs `--release` and is never applied by default. It is
 *     reported either way.
 *
 * ── What this never touches ────────────────────────────────────────────────
 *
 * Status. Nothing here finishes, reopens or activates a batch, even where the
 * repaired counter crosses starting_qty_litres — `markFinishedIfComplete` and
 * `releaseStock`'s reopen are decisions for the order flow, not for a repair.
 * Orders, allocations, movements, payments and commissions are all read-only
 * here: this script rewrites one integer per batch and nothing else.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/reconcile-pfi-stock-counters.js              # report only
 *   node scripts/reconcile-pfi-stock-counters.js --json       # machine-readable
 *   node scripts/reconcile-pfi-stock-counters.js --active     # active batches only
 *   node scripts/reconcile-pfi-stock-counters.js --apply      # repair the safe direction
 *   node scripts/reconcile-pfi-stock-counters.js --apply --release   # both directions
 *   node scripts/reconcile-pfi-stock-counters.js --apply --pfi=45    # just one
 *
 * Writes nothing without --apply. With it, a rollback file lands beside the
 * other scripts/rollback-*.json holding each batch's previous counter, and the
 * whole repair runs in ONE transaction that is rolled back unless every batch
 * it wrote verifies against the invariant afterwards.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { classifyDrift, DEAD_ORDER_STATUSES } = require("../lib/pfiStockInvariant");

const APPLY = process.argv.includes("--apply");
const RELEASE = process.argv.includes("--release");
const JSON_OUT = process.argv.includes("--json");
const ACTIVE_ONLY = process.argv.includes("--active");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const ONLY_PFI = arg("pfi") ? Number(arg("pfi")) : null;

const n = (v) => Number(v || 0).toLocaleString("en-NG");
const signed = (v) => (Number(v) > 0 ? `+${n(v)}` : n(v));

/**
 * Every batch, its counter, and what its live orders say the counter should be.
 *
 * LEFT JOIN, not an inner one: a batch with no orders at all must still be
 * examined — several hold a non-zero counter with nothing on them, which is
 * precisely the stranded-reservation case.
 */
const SQL = `
  SELECT p.id,
         p.pfi_number,
         p.status::text                          AS status,
         -- Landed plus any evacuation surplus: what the batch offers from.
         (p.starting_qty_litres + p.evacuation_surplus_litres)::bigint AS tank,
         p.sold_qty_litres::bigint               AS counter,
         COALESCE(o.live_qty, 0)::bigint         AS expected,
         COALESCE(o.live_orders, 0)::int          AS live_orders,
         COALESCE(o.paid_qty, 0)::bigint          AS paid_qty
    FROM pfis p
    LEFT JOIN (
           SELECT pfi_id,
                  SUM(quantity) FILTER (WHERE NOT (status::text = ANY($1::text[])))                AS live_qty,
                  COUNT(*)      FILTER (WHERE NOT (status::text = ANY($1::text[])))                AS live_orders,
                  SUM(quantity) FILTER (WHERE payment_status = 'Paid')                             AS paid_qty
             FROM orders
            WHERE pfi_id IS NOT NULL
            GROUP BY pfi_id
         ) o ON o.pfi_id = p.id
   ORDER BY p.id
`;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(SQL, [DEAD_ORDER_STATUSES]);

    let considered = rows;
    if (ACTIVE_ONLY) considered = considered.filter((r) => r.status === "active");
    if (ONLY_PFI != null) considered = considered.filter((r) => Number(r.id) === ONLY_PFI);

    // Direction, and what each batch offers before and after, both from
    // lib/pfiStockInvariant so the rule is not restated here.
    const drifted = considered
      .map((r) => ({
        id: Number(r.id),
        pfiNumber: r.pfi_number,
        status: r.status,
        tank: Number(r.tank),
        counter: Number(r.counter),
        liveOrders: Number(r.live_orders),
        paidQty: Number(r.paid_qty),
        ...classifyDrift({ counter: r.counter, expected: r.expected, tank: r.tank }),
      }))
      .filter((r) => r.direction !== "ok");

    const tooLow = drifted.filter((r) => r.direction === "under_reserved");
    const tooHigh = drifted.filter((r) => r.direction === "over_reserved");
    const toWrite = RELEASE ? drifted : tooLow;

    if (JSON_OUT) {
      console.log(JSON.stringify({ drifted, tooLow, tooHigh, willWrite: toWrite.map((r) => r.id) }, null, 2));
    } else {
      report(considered, drifted, tooLow, tooHigh, toWrite);
    }

    if (!APPLY) {
      if (!JSON_OUT) {
        console.log(
          drifted.length
            ? `\nNothing written. Re-run with --apply to repair ${toWrite.length} batch(es)` +
                (RELEASE ? "." : `, or --apply --release for all ${drifted.length}.`)
            : "\nNothing to do — every counter agrees with its orders."
        );
      }
      return;
    }

    if (toWrite.length === 0) {
      console.log("\nNothing to write.");
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(__dirname, `rollback-pfi-stock-counters-${stamp}.json`);

    await client.query("BEGIN");

    for (const r of toWrite) {
      // Guarded on the value we read, so a concurrent order write between the
      // read and here loses this repair rather than silently overwriting a
      // counter that has legitimately moved since.
      const res = await client.query(
        `UPDATE pfis SET sold_qty_litres = $1, updated_at = NOW()
          WHERE id = $2 AND sold_qty_litres = $3`,
        [r.expected, r.id, r.counter]
      );
      if (res.rowCount !== 1) {
        await client.query("ROLLBACK");
        throw new Error(
          `PFI ${r.id} changed underneath this repair (counter was ${n(r.counter)}). Nothing written — re-run.`
        );
      }
    }

    // Verify the invariant for every batch written, inside the transaction, and
    // refuse to commit unless all of them hold.
    const ids = toWrite.map((r) => r.id);
    const { rows: after } = await client.query(
      `SELECT p.id, p.sold_qty_litres::bigint AS counter,
              COALESCE(SUM(o.quantity) FILTER (WHERE NOT (o.status::text = ANY($2::text[]))), 0)::bigint AS expected
         FROM pfis p
         LEFT JOIN orders o ON o.pfi_id = p.id
        WHERE p.id = ANY($1::int[])
        GROUP BY p.id, p.sold_qty_litres`,
      [ids, DEAD_ORDER_STATUSES]
    );
    const bad = after.filter((r) => Number(r.counter) !== Number(r.expected));
    if (bad.length) {
      await client.query("ROLLBACK");
      throw new Error(`invariant still broken on PFI ${bad.map((b) => b.id).join(", ")} — rolled back`);
    }

    fs.writeFileSync(
      rollbackPath,
      JSON.stringify(
        {
          wroteAt: new Date().toISOString(),
          note: "Restore with: UPDATE pfis SET sold_qty_litres = <previousCounter> WHERE id = <id>",
          batches: toWrite.map((r) => ({
            id: r.id,
            pfiNumber: r.pfiNumber,
            previousCounter: r.counter,
            newCounter: r.expected,
          })),
        },
        null,
        2
      )
    );

    await client.query("COMMIT");

    console.log(`\nRepaired ${toWrite.length} batch(es). Rollback written to:\n  ${rollbackPath}`);
    if (!RELEASE && tooHigh.length) {
      console.log(
        `\n${tooHigh.length} batch(es) hold litres no order claims and were LEFT ALONE.` +
          ` Re-run with --release once you are satisfied the orders are complete for them.`
      );
    }
  } finally {
    await client.end();
  }
}

function report(considered, drifted, tooLow, tooHigh, toWrite) {
  console.log(`PFI stock counter reconciliation — ${considered.length} batch(es) examined\n`);
  console.log(`  invariant : sold_qty_litres = live orders on the batch (Cancelled/Expired excluded)`);
  console.log(`  drifted   : ${drifted.length}`);
  console.log(`  too low   : ${tooLow.length}  (offering litres already sold — the dangerous direction)`);
  console.log(`  too high  : ${tooHigh.length}  (holding litres nobody can buy)`);

  if (tooLow.length) {
    console.log(`\n── Counter too LOW — these batches offer stock that is already on an order ──`);
    console.table(
      tooLow
        .slice()
        .sort((a, b) => a.drift - b.drift)
        .map((r) => ({
          pfi: r.id,
          number: r.pfiNumber.slice(0, 32),
          status: r.status,
          counter: n(r.counter),
          "should be": n(r.expected),
          drift: signed(r.drift),
          "offers now": n(r.offeredNow),
          "offers after": n(r.offeredAfter),
        }))
    );
  }

  if (tooHigh.length) {
    console.log(`\n── Counter too HIGH — these hold litres no live order claims (needs --release) ──`);
    console.table(
      tooHigh
        .slice()
        .sort((a, b) => b.drift - a.drift)
        .map((r) => ({
          pfi: r.id,
          number: r.pfiNumber.slice(0, 32),
          status: r.status,
          counter: n(r.counter),
          "should be": n(r.expected),
          drift: signed(r.drift),
          "offers now": n(r.offeredNow),
          "offers after": n(r.offeredAfter),
        }))
    );
  }

  const offeredButSold = tooLow.reduce((s, r) => s + Math.abs(r.drift), 0);
  if (offeredButSold) {
    console.log(`\nTotal litres currently offered for sale that are already on an order: ${n(offeredButSold)}`);
  }
  void toWrite;
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
