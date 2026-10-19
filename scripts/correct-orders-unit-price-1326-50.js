#!/usr/bin/env node
/**
 * Re-rate four PFI/50/26/DANGOTE/PMS/3ML/SEP orders to ₦1,326.50/L.
 *
 * ── What is wrong ─────────────────────────────────────────────────────────
 *
 * The agreed rate on all four is ₦1,326.50. Three were placed at ₦1,328.00
 * and one at ₦1,325.00, so every money figure derived from the unit price is
 * off by the difference:
 *
 *     PE12458  Pure Empire Global         45,000 L   ₦1,328.00   Pending  Unpaid
 *     MM12462  MBM Mainstream Nig Ltd     90,000 L   ₦1,328.00   Pending  Unpaid
 *     FO12463  Fortis Oil & Gas           90,000 L   ₦1,328.00   Pending  Unpaid
 *     AS12465  Attajiri Service Nig Ltd   45,000 L   ₦1,325.00   Pending  Unpaid
 *
 * The price is the only wrong figure. Quantity is right on all four, so the
 * PFI reservation behind them (order_pfi_allocations on PFI 61) is right too
 * and is deliberately left alone — this script moves no stock.
 *
 * What it does move, per order:
 *
 *   Sales value   total_amount = price x quantity + delivery_fee, the same
 *                 derivation updateOrder uses. All four are pickup orders with
 *                 no delivery fee, and the script refuses to run otherwise.
 *
 * That is all. None of the four has a payment or a commission, so there is no
 * payment status to re-derive and no commission basis to re-snapshot — and
 * the script refuses to run if either has appeared since it was written,
 * rather than carrying logic for a state it was never checked against.
 *
 * ── Why this bypasses updateOrder ─────────────────────────────────────────
 *
 * updateOrder would handle this edit correctly on each order. It takes one
 * transaction per order, though, and a re-rating that half-applies is worse
 * than one that does not apply at all. Everything updateOrder would have done
 * for a price-only edit on an unpaid, priced order — set price, derive
 * total_amount, write an order.updated audit row — is done below, for all
 * four at once.
 *
 * ── What this does NOT do ─────────────────────────────────────────────────
 *
 * The depot's configured product price is not touched — this corrects four
 * orders, not the price list.
 *
 * expected_payments rows are left as they are. They are advisory notes of
 * what the customer said is coming (see services/expectedPayment.service.js),
 * not derived from the order, and updateOrder does not touch them either.
 * MM12462 and FO12463 already expect ₦119,385,000, which is the corrected
 * total; PE12458 and AS12465 expect the old figures.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 *   node scripts/correct-orders-unit-price-1326-50.js           dry run
 *   node scripts/correct-orders-unit-price-1326-50.js --apply   commits
 *
 * The dry run performs every write and every post-write check, then rolls
 * back, so it exercises exactly the path --apply commits. --apply also writes
 * scripts/rollback-unit-price-<stamp>.json first.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");

/** Order id → the price it was placed at. */
const ORDERS = new Map([
  [12458, "1328.00"],
  [12462, "1328.00"],
  [12463, "1328.00"],
  [12465, "1325.00"],
]);
const NEW_PRICE = "1326.50";
const PFI_ID = 61;

/** updateOrder's EDIT_LOCKED_STATUSES — an order past these is never re-rated. */
const EDIT_LOCKED = new Set(["Completed", "Cancelled", "Expired"]);

const K = (v) => Math.round(Number(v || 0) * 100);
const naira = (k) =>
  `₦${(k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (k) => (k < 0 ? `−${naira(-k)}` : `+${naira(k)}`);
const dec = (k) => (k / 100).toFixed(2);
const litres = (n) => Number(n).toLocaleString("en-NG");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");

  try {
    const newPriceK = K(NEW_PRICE);
    const plans = [];

    const [pfiBefore] = (await client.query(`SELECT sold_qty_litres FROM pfis WHERE id = $1 FOR UPDATE`, [PFI_ID])).rows;

    for (const [orderId, expectedPrice] of ORDERS) {
      // ── Read and assert the starting state ──────────────────────────────
      const [order] = (
        await client.query(
          `SELECT id, order_number, company_name, pfi_id, quantity,
                  price::numeric AS price, total_amount::numeric AS total,
                  delivery_fee::numeric AS delivery_fee, pricing_status::text AS pricing_status,
                  amount_paid::numeric AS paid, payment_status::text AS payment_status,
                  status::text AS status
             FROM orders WHERE id = $1 FOR UPDATE`,
          [orderId]
        )
      ).rows;
      if (!order) throw new Error(`order ${orderId} not found`);

      if (Number(order.price).toFixed(2) !== expectedPrice) {
        throw new Error(
          `order ${orderId} price is ${order.price}, expected ${expectedPrice} — already corrected, or changed since this script was written`
        );
      }
      if (EDIT_LOCKED.has(order.status)) {
        throw new Error(`order ${orderId} is ${order.status} — a ${order.status.toLowerCase()} order is not re-rated`);
      }
      if (order.pricing_status === "pending") {
        throw new Error(`order ${orderId} is unpriced — it is priced through POST /orders/:id/price, not re-rated`);
      }
      if (order.pfi_id !== PFI_ID) throw new Error(`order ${orderId} is on PFI ${order.pfi_id}, expected ${PFI_ID}`);
      if (K(order.delivery_fee) !== 0) {
        throw new Error(`order ${orderId} carries a delivery fee of ${order.delivery_fee} — not the state this script was written for`);
      }
      // The sales value is price x quantity, so a total that does not already
      // agree with the old price is a second problem this script cannot see.
      if (K(order.total) !== K(order.price) * order.quantity) {
        throw new Error(
          `order ${orderId} total ${order.total} is not ${order.price} x ${order.quantity} — refusing to overwrite a total that was set deliberately`
        );
      }

      const [{ n: paymentRows }] = (
        await client.query(`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = $1`, [orderId])
      ).rows;
      const [{ n: commissionRows }] = (
        await client.query(`SELECT COUNT(*)::int AS n FROM commissions WHERE order_id = $1`, [orderId])
      ).rows;
      if (paymentRows || K(order.paid) || order.payment_status !== "Unpaid") {
        throw new Error(`order ${orderId} has a payment recorded — not the state this script was written for`);
      }
      if (commissionRows) {
        throw new Error(`order ${orderId} has a commission — not the state this script was written for`);
      }

      plans.push({ order, newTotalK: newPriceK * order.quantity });
    }

    // ── Report ──────────────────────────────────────────────────────────────
    console.log(`\nunit price  →  ${naira(newPriceK)}/L\n`);
    let salesBeforeK = 0;
    let salesAfterK = 0;

    for (const p of plans) {
      const { order } = p;
      salesBeforeK += K(order.total);
      salesAfterK += p.newTotalK;

      console.log(`${order.order_number}  (${order.id} — ${order.company_name})`);
      console.log(`  unit price      ${naira(K(order.price))}/L  →  ${naira(newPriceK)}/L`);
      console.log(`  quantity        ${litres(order.quantity)} L  (unchanged)`);
      console.log(
        `  sales value     ${naira(K(order.total))}  →  ${naira(p.newTotalK)}   (${signed(p.newTotalK - K(order.total))})`
      );
      console.log(`  payment status  Unpaid  (unchanged — no payments)`);
      console.log("");
    }

    console.log(
      `total sales value  ${naira(salesBeforeK)}  →  ${naira(salesAfterK)}   (${signed(salesAfterK - salesBeforeK)})`
    );

    // ── Rollback capture ────────────────────────────────────────────────────
    if (APPLY) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rollbackPath = path.join(__dirname, `rollback-unit-price-${stamp}.json`);
      fs.writeFileSync(
        rollbackPath,
        JSON.stringify(
          {
            takenAt: new Date().toISOString(),
            orders: plans.map((p) => ({
              id: p.order.id,
              order_number: p.order.order_number,
              price: Number(p.order.price).toFixed(2),
              total_amount: Number(p.order.total).toFixed(2),
            })),
          },
          null,
          2
        )
      );
      console.log(`\nRollback written to ${rollbackPath}`);
    }

    // ── Write ───────────────────────────────────────────────────────────────
    for (const p of plans) {
      const { order } = p;

      await client.query(`UPDATE orders SET price = $1, total_amount = $2, updated_at = NOW() WHERE id = $3`, [
        NEW_PRICE,
        dec(p.newTotalK),
        order.id,
      ]);

      await client.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata)
         VALUES ('order', $1, 'order.updated', 'system', $2::jsonb)`,
        [
          order.id,
          JSON.stringify({
            changes: {
              price: [Number(order.price).toFixed(2), NEW_PRICE],
              totalAmount: [Number(order.total).toFixed(2), dec(p.newTotalK)],
            },
            reason: `Re-rated from ₦${Number(order.price).toFixed(2)} to ₦${NEW_PRICE} per litre — placed at the wrong unit price. Quantity and PFI stock unchanged.`,
            via: "scripts/correct-orders-unit-price-1326-50.js",
          }),
        ]
      );
    }

    // ── Post-write invariants ───────────────────────────────────────────────
    const problems = [];
    for (const p of plans) {
      const { order } = p;
      const [after] = (
        await client.query(
          `SELECT o.quantity, o.price::numeric AS price, o.total_amount::numeric AS total,
                  o.amount_paid::numeric AS paid, o.payment_status::text AS payment_status,
                  o.status::text AS status,
                  (SELECT COALESCE(SUM(quantity), 0) FROM order_pfi_allocations WHERE order_id = o.id)::int AS alloc
             FROM orders o WHERE o.id = $1`,
          [order.id]
        )
      ).rows;

      const tag = `order ${order.id}`;
      if (K(after.price) !== newPriceK) problems.push(`${tag} price is ${after.price}`);
      if (K(after.total) !== p.newTotalK) problems.push(`${tag} total_amount is ${after.total}`);
      if (K(after.total) !== K(after.price) * after.quantity) problems.push(`${tag} total_amount is not price x quantity`);
      if (after.quantity !== order.quantity) problems.push(`${tag} quantity moved to ${after.quantity}`);
      if (after.status !== order.status) problems.push(`${tag} status moved to ${after.status}`);
      if (K(after.paid) !== 0 || after.payment_status !== "Unpaid") problems.push(`${tag} payment moved`);
      if (after.alloc !== order.quantity) problems.push(`${tag} pfi allocation is ${after.alloc}, expected ${order.quantity}`);
    }

    // The PFI backing all four must not have moved a litre.
    const [pfiAfter] = (await client.query(`SELECT sold_qty_litres FROM pfis WHERE id = $1`, [PFI_ID])).rows;
    if (Number(pfiAfter.sold_qty_litres) !== Number(pfiBefore.sold_qty_litres)) {
      problems.push(`PFI ${PFI_ID} sold_qty_litres moved ${pfiBefore.sold_qty_litres} → ${pfiAfter.sold_qty_litres}`);
    }

    if (problems.length) {
      console.log(`\nPOST-WRITE CHECKS FAILED:\n  ${problems.join("\n  ")}`);
      throw new Error("post-write invariant broken");
    }
    console.log("\npost-write checks: all clear");

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("DRY RUN — every write above was rolled back. Re-run with --apply to commit.");
    } else {
      await client.query("COMMIT");
      console.log("COMMITTED");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK:", err.message);
    process.exitCode = 1;
  }

  await client.end();
}

main();
