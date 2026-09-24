#!/usr/bin/env node
/**
 * Delete the delivery sales and stock entries recorded against filling
 * stations. The station records themselves are kept.
 *
 * ── What a "filling station" is ───────────────────────────────────────────
 *
 * A row in `delivery_customers` with customer_type = 'filling_station' — the
 * same table that holds ordinary delivery customers, split by that column.
 * See controllers/administration/filingStation.controller.js, which is a view
 * over exactly that filter.
 *
 * ── What is removed ───────────────────────────────────────────────────────
 *
 *   delivery_sales      every row whose customer_id is a filling station
 *   delivery_inventory  the same
 *
 * Nothing references either table by foreign key, so this leaves nothing
 * dangling and needs no cascade.
 *
 * ── What is KEPT, deliberately ────────────────────────────────────────────
 *
 * The 8 station records. They are the register the dashboard lists, and the
 * foreign keys from sales and inventory are ON DELETE SET NULL — so deleting
 * stations would NOT remove their sales, it would strand them with a null
 * customer_id. Keeping the stations is what makes this a clean truncation of
 * the entries rather than a half-detached history.
 *
 * ── Read this before running it ───────────────────────────────────────────
 *
 * These are not scratch rows. At the time of writing that is 385 sales worth
 * ₦302,466,212.60 across 903,706 litres, running from 30 May to the day this
 * was written, and 372 of them fall inside delivery cycles already CLOSED on
 * 2026-09-11 (PFI-14B, PFI-19B, PFI-24B, PFI-25C). Closing a cycle is a
 * sign-off on what was delivered and collected in it; deleting the rows
 * underneath one leaves that closure certifying figures that no longer exist.
 * The script prints the breakdown every run so the cost is never implicit.
 *
 * ── The backup is the whole safety net ────────────────────────────────────
 *
 * There is no soft-delete on these tables, so the JSON file this writes is the
 * only way back. Every column of every deleted row goes into it — not a
 * summary — and it is written and flushed BEFORE the delete runs, so a crash
 * mid-way cannot leave rows gone with nothing to restore them from. The delete
 * itself is one transaction, and it verifies the rows are gone before
 * committing.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/clear-filling-station-entries.js               # dry run
 *   node scripts/clear-filling-station-entries.js --sales-only  # narrow it
 *   node scripts/clear-filling-station-entries.js --apply
 *
 * Restore: the backup is {sales: [...], inventory: [...]} of whole rows, so a
 * plain INSERT of each array back into its table puts them all back, ids
 * included.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const SALES_ONLY = process.argv.includes("--sales-only");
const INVENTORY_ONLY = process.argv.includes("--inventory-only");

const N = (v) =>
  "₦" + Number(v || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const L = (v) => Number(v || 0).toLocaleString("en-NG");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const q = async (sql, params) => (await client.query(sql, params)).rows;

    const stations = await q(
      `SELECT id, name FROM delivery_customers WHERE customer_type = 'filling_station' ORDER BY id`
    );
    if (!stations.length) {
      console.log("No filling stations on record — nothing to clear.");
      return;
    }
    const ids = stations.map((s) => s.id);

    const wantSales = !INVENTORY_ONLY;
    const wantInventory = !SALES_ONLY;

    const sales = wantSales
      ? await q(`SELECT * FROM delivery_sales WHERE customer_id = ANY($1) ORDER BY id`, [ids])
      : [];
    const inventory = wantInventory
      ? await q(`SELECT * FROM delivery_inventory WHERE customer_id = ANY($1) ORDER BY id`, [ids])
      : [];

    console.log(`${stations.length} filling station(s) — the station records themselves are KEPT.\n`);

    if (wantSales) {
      const value = sales.reduce((s, r) => s + Number(r.sales_value || 0), 0);
      const paid = sales.reduce((s, r) => s + Number(r.payment_amount || 0), 0);
      const litres = sales.reduce((s, r) => s + Number(r.quantity || 0), 0);
      const dates = sales.map((r) => r.created_at).filter(Boolean).sort();
      console.log(`delivery_sales to delete : ${sales.length}`);
      console.log(`  litres                 : ${L(litres)}`);
      console.log(`  sales value            : ${N(value)}`);
      console.log(`  payments recorded      : ${N(paid)}`);
      if (dates.length) {
        console.log(
          `  period                 : ${new Date(dates[0]).toISOString().slice(0, 10)} → ${new Date(dates[dates.length - 1]).toISOString().slice(0, 10)}`
        );
      }

      const perStation = stations
        .map((s) => {
          const mine = sales.filter((r) => r.customer_id === s.id);
          return {
            station: (s.name || "").slice(0, 28),
            rows: mine.length,
            value: N(mine.reduce((a, r) => a + Number(r.sales_value || 0), 0)),
          };
        })
        .filter((r) => r.rows > 0);
      if (perStation.length) console.table(perStation);

      // Cycles already signed off. Printed every run — see the header.
      const closed = await q(
        `SELECT b.code, b.status, COUNT(ds.id)::int n
           FROM delivery_batches b
           JOIN delivery_sales ds ON ds.allocation_code = b.code
          WHERE ds.customer_id = ANY($1)
          GROUP BY b.code, b.status ORDER BY 3 DESC`,
        [ids]
      );
      if (closed.length) {
        const inClosed = closed.reduce((a, r) => a + r.n, 0);
        console.log(`\n  ⚠ ${inClosed} of these sit inside delivery cycles that are already closed:`);
        console.table(closed.map((r) => ({ cycle: r.code, status: r.status, sales: r.n })));
        console.log(`    Those closures will go on certifying figures whose rows no longer exist.`);
      }
    }

    if (wantInventory) {
      console.log(`\ndelivery_inventory to delete : ${inventory.length}`);
    }

    const total = sales.length + inventory.length;
    if (total === 0) {
      console.log("\nNothing to delete.");
      return;
    }

    if (!APPLY) {
      console.log(`\nDRY RUN — nothing written. ${total} row(s) would be deleted.`);
      console.log("Re-run with --apply to back them up and delete.");
      return;
    }

    // ── Backup FIRST, flushed to disk, before a single row is removed ──────
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(__dirname, `backup-filling-station-entries-${stamp}.json`);
    const fd = fs.openSync(backupPath, "w");
    fs.writeSync(
      fd,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          note:
            "Whole rows, ids included. Restore with a plain INSERT of each array back into its table. " +
            "The filling station records in delivery_customers were never deleted.",
          stations,
          sales,
          inventory,
        },
        null,
        2
      )
    );
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    console.log(`\nBacked up ${total} row(s) to:\n  ${backupPath}`);

    await client.query("BEGIN");
    let deletedSales = 0;
    let deletedInventory = 0;
    try {
      if (wantSales && sales.length) {
        const r = await client.query(`DELETE FROM delivery_sales WHERE customer_id = ANY($1)`, [ids]);
        deletedSales = r.rowCount;
      }
      if (wantInventory && inventory.length) {
        const r = await client.query(`DELETE FROM delivery_inventory WHERE customer_id = ANY($1)`, [ids]);
        deletedInventory = r.rowCount;
      }

      if (deletedSales !== sales.length || deletedInventory !== inventory.length) {
        throw new Error(
          `row counts moved under the delete (sales ${deletedSales}/${sales.length}, ` +
            `inventory ${deletedInventory}/${inventory.length}) — rolled back`
        );
      }

      const [{ s }] = (await client.query(
        `SELECT COUNT(*)::int s FROM delivery_sales WHERE customer_id = ANY($1)`, [ids]
      )).rows;
      const [{ i }] = (await client.query(
        `SELECT COUNT(*)::int i FROM delivery_inventory WHERE customer_id = ANY($1)`, [ids]
      )).rows;
      if ((wantSales && s !== 0) || (wantInventory && i !== 0)) {
        throw new Error(`rows still present after delete (sales ${s}, inventory ${i}) — rolled back`);
      }

      const [{ st }] = (await client.query(
        `SELECT COUNT(*)::int st FROM delivery_customers WHERE customer_type = 'filling_station'`
      )).rows;
      if (st !== stations.length) {
        throw new Error(`station count changed from ${stations.length} to ${st} — rolled back`);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log(`\n✓ deleted ${deletedSales} sale(s) and ${deletedInventory} inventory row(s).`);
    console.log(`  ${stations.length} filling station record(s) kept.`);
    console.log(`  restore from: ${backupPath}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
});
