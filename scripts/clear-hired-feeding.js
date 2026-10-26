#!/usr/bin/env node
/**
 * Clear the feeding typed on hired trucks' trips.
 *
 * A third party's driver is fed by the truck's owner, not by us (the user,
 * 2026-10-26), and Delivery Costing no longer takes feeding on a hired truck.
 * On 26 Oct 2026 six hired trips on PFI 38B (#853–#858, GOMBE and YOLA's
 * trucks) carried ₦50,000 each — ₦300,000 counted in 38B's landing cost that
 * nobody pays. EXP-646 (₦2.3m) covers the 46 Soroman trucks only.
 *
 * Only trips on a hired truck whose feeding is on no payment request. Each
 * row's figures are kept in hired_feeding_cleared_20261026 first, so it can be
 * put back: UPDATE delivery_inventory d SET feeding_allowance = u.feeding_allowance,
 * feeding_in_expenses = u.feeding_in_expenses FROM hired_feeding_cleared_20261026 u WHERE u.id = d.id;
 *
 *   node scripts/clear-hired-feeding.js            dry run: lists the trips
 *   node scripts/clear-hired-feeding.js --apply    clears them, in one transaction
 */
require("dotenv").config();
const { client } = require("../db");

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await client`
    SELECT d.id, d.truck_number, f.owner_name, d.pfi_number, d.feeding_allowance, d.feeding_in_expenses
      FROM delivery_inventory d
      JOIN fleet_trucks f ON f.id = d.truck_id
     WHERE f.is_third_party AND d.feeding_allowance IS NOT NULL AND d.feeding_expense_id IS NULL
     ORDER BY d.id`;
  const total = rows.reduce((s, r) => s + Number(r.feeding_allowance), 0);
  for (const r of rows) {
    console.log(`#${r.id}  ${r.truck_number}  ${r.owner_name}  ${r.pfi_number}  ₦${Number(r.feeding_allowance).toLocaleString("en-NG")}`);
  }
  console.log(`${rows.length} hired trip(s), ₦${total.toLocaleString("en-NG")} of feeding.`);
  if (!APPLY) {
    console.log("Dry run. Nothing changed. Run again with --apply to clear them.");
    return;
  }
  if (!rows.length) return;

  await client.begin(async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS hired_feeding_cleared_20261026 (
        id integer PRIMARY KEY,
        feeding_allowance numeric(14, 2),
        feeding_in_expenses boolean,
        cleared_at timestamptz NOT NULL DEFAULT now()
      )`;
    const ids = rows.map((r) => Number(r.id));
    await tx`
      INSERT INTO hired_feeding_cleared_20261026 (id, feeding_allowance, feeding_in_expenses)
      SELECT id, feeding_allowance, feeding_in_expenses FROM delivery_inventory WHERE id = ANY(${ids}::int[])
      ON CONFLICT (id) DO NOTHING`;
    const done = await tx`
      UPDATE delivery_inventory
         SET feeding_allowance = NULL, feeding_in_expenses = false, updated_at = NOW()
       WHERE id = ANY(${ids}::int[]) AND feeding_expense_id IS NULL
       RETURNING id`;
    await tx`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata)
      VALUES ('delivery_inventory', ${String(ids[0])}, 'delivery_inventory.hired_feeding_cleared', 'system',
              ${JSON.stringify({ trips: ids, total, reason: "Hired trucks are fed by their owner (2026-10-26)", undo: "hired_feeding_cleared_20261026" })})`;
    console.log(`Cleared feeding on ${done.length} trip(s). Undo table: hired_feeding_cleared_20261026.`);
  });
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => client.end());
