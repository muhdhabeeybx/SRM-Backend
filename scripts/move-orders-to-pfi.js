#!/usr/bin/env node
/**
 * Move one or more orders onto a different PFI, taking their stock reservation
 * and ticket ledger with them.
 *
 *   node scripts/move-orders-to-pfi.js --orders=11982 --to=PFI/46/26
 *   node scripts/move-orders-to-pfi.js --orders=11962,11963 --to=PFI/46/26 --apply
 *
 * `--to` is matched as a prefix of pfi_number and must resolve to exactly one
 * batch, so a partial like "PFI/46/26" is enough and an ambiguous one is
 * refused rather than guessed at.
 *
 * ── What it corrects ──────────────────────────────────────────────────────
 *
 * An order raised against the wrong batch. Nothing about the sale changes —
 * only which batch it draws on, and therefore which batch is credited with the
 * volume, the revenue and the commission.
 *
 * The orders must all sit on one source PFI, and that PFI and the destination
 * must agree on depot and product. Both are asserted, because moving an order
 * to a batch at another depot or of another product would not be a correction.
 *
 * ── Why this bypasses updateOrder ─────────────────────────────────────────
 *
 * updateOrder refuses a PFI change outside Pending/Paid, because quantity and
 * PFI back a stock reservation and a ticket already cut names a real gate
 * action. It refuses a Completed order outright for the same reason.
 *
 * Both guards are about not letting a batch drift away from tickets already
 * issued against it. Here the tickets move WITH the order — pfi_movements is
 * repointed below, exactly as updateOrder does on a PFI change — so the ledger
 * and the order stay in agreement, which is what those guards protect. What
 * they cannot express is "move both together", which is what this does.
 *
 * ── What moves ────────────────────────────────────────────────────────────
 *
 *   orders.pfi_id            43 → 51
 *   order_pfi_allocations    repointed, quantities untouched
 *   pfi_movements            repointed, so the ticket ledger follows the order
 *   pfis.sold_qty_litres     337,500 L released from #43, reserved on #51
 *
 * ── What does NOT move ────────────────────────────────────────────────────
 *
 * Commission rows 842 and 843 are both PAID. They are not rewritten and do not
 * need to be: a commission carries no pfi_id and reaches its batch through the
 * order, so it re-attributes itself and no figure changes. Money that has left
 * is never restated.
 *
 * Nothing about the sale is touched — quantity, price, total, amount paid,
 * payment status, order status, and all seven gated-out trucks stay exactly as
 * they are. BG11963's N277,500 overpayment stays where it is.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 *   node scripts/move-orders-to-pfi-46.js           dry run
 *   node scripts/move-orders-to-pfi-46.js --apply   commits
 *
 * --apply writes scripts/rollback-pfi-move-<stamp>.json and refuses to commit
 * unless every post-write invariant below holds.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const ORDER_IDS = String(arg("orders") || "")
  .split(",")
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const TO_PREFIX = String(arg("to") || "").trim();

if (!ORDER_IDS.length || !TO_PREFIX) {
  console.error("usage: --orders=11982[,11983] --to=PFI/46/26 [--apply]");
  process.exitCode = 1;
  process.exit();
}

const litres = (n) => Number(n || 0).toLocaleString("en-NG");
const naira = (v) => `₦${Number(v || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");

  try {
    // ── Resolve the destination from its number ─────────────────────────────
    //
    // A prefix is enough, but it must identify ONE batch. Taking the first of
    // several matches would move an order onto whichever row happened to sort
    // first, which is the kind of quiet wrong this script exists to undo.
    const matches = (
      await client.query(
        `SELECT id FROM pfis WHERE pfi_number LIKE $1 || '%' ORDER BY id`,
        [TO_PREFIX]
      )
    ).rows;
    if (!matches.length) throw new Error(`no PFI whose number starts with "${TO_PREFIX}"`);
    if (matches.length > 1) {
      throw new Error(`"${TO_PREFIX}" matches ${matches.length} PFIs (${matches.map((m) => m.id).join(", ")}) — be more specific`);
    }
    const TO_PFI = Number(matches[0].id);

    // ── The source, taken from the orders rather than assumed ───────────────
    const sources = (
      await client.query(
        `SELECT DISTINCT pfi_id FROM orders WHERE id = ANY($1::int[])`,
        [ORDER_IDS]
      )
    ).rows.map((r) => (r.pfi_id == null ? null : Number(r.pfi_id)));
    if (sources.length !== 1) {
      throw new Error(`the orders sit on ${sources.length} different PFIs — move them in one group per source batch`);
    }
    const FROM_PFI = sources[0];
    if (FROM_PFI == null) throw new Error("these orders carry no PFI, so there is nothing to move from");
    if (FROM_PFI === TO_PFI) throw new Error(`already on PFI ${TO_PFI} — nothing to do`);

    // ── Both batches, locked ────────────────────────────────────────────────
    const pfiRows = (
      await client.query(
        `SELECT id, pfi_number, status::text AS status, location_id, product_id,
                starting_qty_litres, sold_qty_litres
           FROM pfis WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [[FROM_PFI, TO_PFI]]
      )
    ).rows;
    const from = pfiRows.find((p) => Number(p.id) === FROM_PFI);
    const to = pfiRows.find((p) => Number(p.id) === TO_PFI);
    if (!from || !to) throw new Error("one of the PFIs was not found");
    // reserveStock refuses a batch that is not active; mirror that rule here.
    if (to.status !== "active") throw new Error(`${to.pfi_number} is ${to.status}, not active`);
    // Moving between depots or products would not be a correction.
    if (Number(from.location_id) !== Number(to.location_id)) {
      throw new Error(`${from.pfi_number} is at depot ${from.location_id}, ${to.pfi_number} at ${to.location_id}`);
    }
    if (Number(from.product_id) !== Number(to.product_id)) {
      throw new Error(`${from.pfi_number} carries product ${from.product_id}, ${to.pfi_number} ${to.product_id}`);
    }

    // ── The orders ──────────────────────────────────────────────────────────
    const orders = (
      await client.query(
        `SELECT id, company_name, quantity, total_amount::numeric AS total,
                amount_paid::numeric AS paid, payment_status::text AS payment_status,
                status::text AS status, pfi_id, depot_id, product_id
           FROM orders WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [ORDER_IDS]
      )
    ).rows;
    if (orders.length !== ORDER_IDS.length) throw new Error("an order was not found");

    for (const o of orders) {
      if (Number(o.pfi_id) !== FROM_PFI) {
        throw new Error(`order ${o.id} is on PFI ${o.pfi_id}, not ${FROM_PFI} — already moved, or moved elsewhere`);
      }
      // The batches must be interchangeable for this order, or the move would
      // put it on a batch of a different product or at another depot.
      if (Number(o.depot_id) !== Number(to.location_id)) {
        throw new Error(`order ${o.id} is at depot ${o.depot_id}; ${to.pfi_number} is at ${to.location_id}`);
      }
      if (Number(o.product_id) !== Number(to.product_id)) {
        throw new Error(`order ${o.id} is product ${o.product_id}; ${to.pfi_number} carries ${to.product_id}`);
      }
    }

    const allocations = (
      await client.query(
        `SELECT id, order_id, pfi_id, quantity FROM order_pfi_allocations
          WHERE order_id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [ORDER_IDS]
      )
    ).rows;
    const movements = (
      await client.query(
        `SELECT id, order_id, pfi_id, qty_litres FROM pfi_movements
          WHERE order_id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [ORDER_IDS]
      )
    ).rows;

    const stray = [...allocations, ...movements].filter((r) => Number(r.pfi_id) !== FROM_PFI);
    if (stray.length) throw new Error(`a row already points somewhere other than ${FROM_PFI} — refusing to guess`);

    // ── Stock: releaseStock(old) then reserveStock(new) ─────────────────────
    const reserved = allocations.reduce((n, a) => n + Number(a.quantity), 0);
    const fromSoldAfter = Math.max(0, Number(from.sold_qty_litres) - reserved);
    const toSoldAfter = Number(to.sold_qty_litres) + reserved;
    if (Number(to.starting_qty_litres) - toSoldAfter < 0) {
      throw new Error(`${to.pfi_number} cannot absorb ${litres(reserved)} L`);
    }

    // ── Report ──────────────────────────────────────────────────────────────
    console.log(`\n${from.pfi_number}  →  ${to.pfi_number}\n`);
    for (const o of orders) {
      const a = allocations.find((x) => Number(x.order_id) === Number(o.id));
      const m = movements.find((x) => Number(x.order_id) === Number(o.id));
      console.log(`  order ${o.id}  (${o.company_name})`);
      console.log(`    ${litres(o.quantity)} L · ${naira(o.total)} · ${o.payment_status} · ${o.status}`);
      console.log(`    allocation #${a ? a.id : "—"}  ${a ? litres(a.quantity) + " L" : "none"}   →  PFI ${TO_PFI}`);
      console.log(`    movement   #${m ? m.id : "—"}  ${m ? litres(m.qty_litres) + " L ticketed" : "none"}   →  PFI ${TO_PFI}`);
    }
    console.log(`\n  ${from.pfi_number}`);
    console.log(`    sold ${litres(from.sold_qty_litres)} L  →  ${litres(fromSoldAfter)} L   (release ${litres(reserved)})`);
    console.log(`  ${to.pfi_number}`);
    console.log(`    sold ${litres(to.sold_qty_litres)} L  →  ${litres(toSoldAfter)} L   (reserve ${litres(reserved)})`);
    console.log(`    remaining ${litres(Number(to.starting_qty_litres) - toSoldAfter)} L of ${litres(to.starting_qty_litres)} L`);
    console.log(`\n  unchanged: quantity, price, total, amount paid, payment status, order status, trucks,`);
    // A commission carries no pfi_id — it reaches its batch through the order —
    // so it re-attributes itself and no figure is rewritten. That holds whether
    // it is still pending or already paid, which is why a paid one is safe here
    // when it would not be safe to restate directly.
    const { rows: comms } = await client.query(
      `SELECT status::text AS status, COUNT(*)::int AS n FROM commissions
        WHERE order_id = ANY($1::int[]) GROUP BY 1 ORDER BY 1`,
      [ORDER_IDS]
    );
    console.log(
      `             and ${comms.map((c) => `${c.n} ${c.status}`).join(", ") || "no"} commission(s) — they follow the order by join.`
    );

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.\n");
      await client.end();
      return;
    }

    // ── Rollback capture ────────────────────────────────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(__dirname, `rollback-pfi-move-${stamp}.json`);
    fs.writeFileSync(
      rollbackPath,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          orders: orders.map((o) => ({ id: o.id, pfi_id: o.pfi_id })),
          allocations: allocations.map((a) => ({ id: a.id, pfi_id: a.pfi_id })),
          movements: movements.map((m) => ({ id: m.id, pfi_id: m.pfi_id })),
          pfis: [
            { id: from.id, sold_qty_litres: Number(from.sold_qty_litres) },
            { id: to.id, sold_qty_litres: Number(to.sold_qty_litres) },
          ],
        },
        null,
        2
      )
    );
    console.log(`\nRollback written to ${rollbackPath}`);

    // ── Write ───────────────────────────────────────────────────────────────
    await client.query(`UPDATE orders SET pfi_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`, [TO_PFI, ORDER_IDS]);
    await client.query(`UPDATE order_pfi_allocations SET pfi_id = $1 WHERE order_id = ANY($2::int[])`, [TO_PFI, ORDER_IDS]);
    await client.query(`UPDATE pfi_movements SET pfi_id = $1 WHERE order_id = ANY($2::int[])`, [TO_PFI, ORDER_IDS]);
    await client.query(`UPDATE pfis SET sold_qty_litres = $1, updated_at = NOW() WHERE id = $2`, [fromSoldAfter, FROM_PFI]);
    await client.query(`UPDATE pfis SET sold_qty_litres = $1, updated_at = NOW() WHERE id = $2`, [toSoldAfter, TO_PFI]);

    for (const o of orders) {
      await client.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata)
         VALUES ('order', $1, 'order.updated', 'system', $2::jsonb)`,
        [
          o.id,
          JSON.stringify({
            changes: { pfiId: [FROM_PFI, TO_PFI] },
            reason: `Moved from ${from.pfi_number} to ${to.pfi_number}. Stock reservation and ticket ledger moved with it; sale, payment and commission untouched.`,
            via: "scripts/move-orders-to-pfi-46.js",
          }),
        ]
      );
    }

    // ── Post-write invariants ───────────────────────────────────────────────
    const problems = [];
    const after = (
      await client.query(
        `SELECT o.id, o.pfi_id, o.quantity, o.total_amount::numeric AS total,
                o.amount_paid::numeric AS paid, o.payment_status::text AS payment_status,
                o.status::text AS status,
                (SELECT COUNT(*) FROM order_pfi_allocations WHERE order_id=o.id AND pfi_id<>$2)::int AS alloc_wrong,
                (SELECT COUNT(*) FROM pfi_movements       WHERE order_id=o.id AND pfi_id<>$2)::int AS move_wrong,
                (SELECT COUNT(*) FROM order_trucks        WHERE order_id=o.id)::int AS trucks
           FROM orders o WHERE o.id = ANY($1::int[]) ORDER BY o.id`,
        [ORDER_IDS, TO_PFI]
      )
    ).rows;

    for (const a of after) {
      const before = orders.find((o) => Number(o.id) === Number(a.id));
      const tag = `order ${a.id}`;
      if (Number(a.pfi_id) !== TO_PFI) problems.push(`${tag} pfi_id is ${a.pfi_id}`);
      if (a.alloc_wrong) problems.push(`${tag} has ${a.alloc_wrong} allocation(s) not on ${TO_PFI}`);
      if (a.move_wrong) problems.push(`${tag} has ${a.move_wrong} movement(s) not on ${TO_PFI}`);
      // The sale itself must be untouched — this moves a batch, not money.
      if (Number(a.quantity) !== Number(before.quantity)) problems.push(`${tag} quantity moved`);
      if (String(a.total) !== String(before.total)) problems.push(`${tag} total_amount moved`);
      if (String(a.paid) !== String(before.paid)) problems.push(`${tag} amount_paid moved`);
      if (a.payment_status !== before.payment_status) problems.push(`${tag} payment_status moved`);
      if (a.status !== before.status) problems.push(`${tag} status moved`);
    }

    const [fromAfter] = (await client.query(`SELECT sold_qty_litres, starting_qty_litres FROM pfis WHERE id=$1`, [FROM_PFI])).rows;
    const [toAfter] = (await client.query(`SELECT sold_qty_litres, starting_qty_litres FROM pfis WHERE id=$1`, [TO_PFI])).rows;
    if (Number(fromAfter.sold_qty_litres) !== fromSoldAfter) problems.push(`#${FROM_PFI} sold is ${fromAfter.sold_qty_litres}`);
    if (Number(toAfter.sold_qty_litres) !== toSoldAfter) problems.push(`#${TO_PFI} sold is ${toAfter.sold_qty_litres}`);
    for (const [id, row] of [[FROM_PFI, fromAfter], [TO_PFI, toAfter]]) {
      if (Number(row.sold_qty_litres) < 0 || Number(row.sold_qty_litres) > Number(row.starting_qty_litres)) {
        problems.push(`#${id} sold_qty_litres out of range`);
      }
    }
    // Litres neither appear nor vanish: what one batch gave up, the other took.
    const moved = Number(from.sold_qty_litres) - Number(fromAfter.sold_qty_litres);
    const gained = Number(toAfter.sold_qty_litres) - Number(to.sold_qty_litres);
    if (moved !== gained) problems.push(`${litres(moved)} L left #${FROM_PFI} but ${litres(gained)} L reached #${TO_PFI}`);

    if (problems.length) {
      console.log(`\nPOST-WRITE CHECKS FAILED:\n  ${problems.join("\n  ")}`);
      throw new Error("post-write invariant broken");
    }
    console.log("\npost-write checks: all clear");

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
