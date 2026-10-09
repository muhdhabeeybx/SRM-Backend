/**
 * Bring a trucking PFI an allocation made into line with its trucks — its
 * order on the parent cargo, the cargo's stock, its own figures and the
 * allocation — for trucks that went onto it before the inventory writes kept
 * them in step (PFI-47D: 13 trucks, 635,000 L, 9 October 2026).
 *
 *   node scripts/sync-allocation-trucks.js --pfi 73              dry run: what would change
 *   node scripts/sync-allocation-trucks.js --pfi 73 --apply      change it
 *
 *   --pfi    the trucking PFI's id, or a unique part of its number ("PFI/47D/")
 *   --staff  the staff id the change is recorded under (default 1)
 *
 * The same code the inventory endpoints run (services/allocationTrucks.service.js),
 * so the result is what adding the trucks today would have done. A dry run
 * makes the change inside a transaction and rolls it back.
 *
 * It writes to whatever DATABASE_URL resolves to, and says which first.
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SMS_ENABLED = "false";
process.env.EMAIL_ENABLED = "false";
process.env.WHATSAPP_ENABLED = "false";
require("dotenv").config();

const { sql } = require("drizzle-orm");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const APPLY = process.argv.includes("--apply");
const DRY_RUN = Symbol("dry run");

async function main() {
  console.log(`Database: ${new URL(process.env.DATABASE_URL).hostname}`);
  console.log(APPLY ? "APPLYING\n" : "Dry run — nothing is kept. Add --apply to change it.\n");

  const { db, client } = require("../config/db");
  const { syncFromTrucks } = require("../services/allocationTrucks.service");

  const wanted = arg("pfi");
  if (!wanted) throw new Error("--pfi is required");
  const matches = /^\d+$/.test(wanted)
    ? await client`SELECT id, pfi_number FROM pfis WHERE id = ${Number(wanted)}`
    : await client`SELECT id, pfi_number FROM pfis WHERE pfi_number ILIKE ${`%${wanted}%`}`;
  if (matches.length !== 1) {
    throw new Error(`--pfi ${wanted} matches ${matches.length} PFIs: ${matches.map((m) => m.pfi_number).join(", ")}`);
  }
  const pfi = matches[0];
  const actor = { type: "staff", staffId: Number(arg("staff", 1)) };

  const show = async (tx, label) => {
    const [r] = await tx.execute(sql`
      SELECT o.order_number, o.status, o.quantity, o.total_amount, o.credit_qty, o.expected_trucks,
             (SELECT count(*) FROM order_trucks t WHERE t.order_id = o.id)::int AS loads,
             parent.pfi_number AS parent, parent.sold_qty_litres AS parent_sold,
             parent.starting_qty_litres + parent.evacuation_surplus_litres - parent.operational_loss_litres - parent.sold_qty_litres AS parent_left,
             sub.starting_qty_litres AS sub_qty, sub.sold_qty_litres AS sub_sold, sub.ticket_count AS sub_trucks,
             a.quantity AS alloc_qty, jsonb_array_length(a.trucks) AS alloc_trucks
        FROM pfi_truck_allocations a
        JOIN pfis sub ON sub.id = a.sub_pfi_id
        JOIN orders o ON o.id = a.order_id
        JOIN pfis parent ON parent.id = o.pfi_id
       WHERE a.sub_pfi_id = ${pfi.id} AND a.status = 'approved'`).then((x) => x.rows ?? x);
    if (!r) throw new Error(`${pfi.pfi_number} was not made by an approved allocation with an order`);
    console.log(label);
    console.log(`  order ${r.order_number} (${r.status}): ${Number(r.quantity).toLocaleString()} L, ₦${Number(r.total_amount).toLocaleString()}, credit ${Number(r.credit_qty).toLocaleString()}, ${r.expected_trucks} trucks expected, ${r.loads} loads`);
    console.log(`  ${r.parent}: sold ${Number(r.parent_sold).toLocaleString()}, ${Number(r.parent_left).toLocaleString()} left`);
    console.log(`  ${pfi.pfi_number}: quantity ${Number(r.sub_qty).toLocaleString()}, sold ${Number(r.sub_sold).toLocaleString()}, ${r.sub_trucks} trucks`);
    console.log(`  allocation: ${Number(r.alloc_qty).toLocaleString()} over ${r.alloc_trucks} trucks\n`);
  };

  try {
    await db.transaction(async (tx) => {
      await show(tx, "Before");
      const result = await syncFromTrucks(pfi.id, { tx, actor });
      if (!result) {
        console.log("Already in step — nothing to change.");
      } else {
        await show(tx, "After");
        if (result.added.length) console.log(`  loads added: ${result.added.map((a) => `${a.truckNumber} ${a.quantity.toLocaleString()}`).join(", ")}`);
        if (result.removed.length) console.log(`  loads removed: ${result.removed.map((a) => a.truckNumber).join(", ")}`);
        if (result.resized.length) console.log(`  loads resized: ${result.resized.map((a) => `${a.truckNumber} ${a.from}→${a.to}`).join(", ")}`);
      }
      if (!APPLY) throw DRY_RUN;
    });
    console.log("\nDone.");
  } catch (err) {
    if (err !== DRY_RUN) throw err;
    console.log("\nRolled back (dry run).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
