/**
 * Merge one depot into another: everything at the first falls under the second.
 *
 *   node scripts/merge-depots.js --from 48 --into 38                              dry run
 *   node scripts/merge-depots.js --from 48 --into 38 --text "Dangote Refinery Soroman Ticket" --apply
 *
 * Written for the owner's ask of 14 Oct 2026: "Dangote Lagos — Soroman Ticket"
 * (#48) is the Dangote Refinery (#38), and all its data should be there.
 *
 * In one transaction:
 *
 *   moved      orders, commissions, deposits, price changes, expected payments,
 *              truck allocations, contacts, PFIs (and their location name),
 *              bank accounts' depot lists — from the first depot to the second
 *   kept once  a price, capacity, commission rate, staff assignment or PFI
 *              permission the second depot already has for the same product,
 *              person or PFI: the first depot's copy is dropped, the second's
 *              kept; one it lacks is moved
 *   renamed    where a truck, sales-ledger row or delivery note names the first
 *              depot as text — its name, or any --text given — it names the
 *              second
 *   removed    the first depot itself
 *
 * Every value changed is saved first in an undo table
 * (depot_merge_<from>_into_<into>), the merge is written to the audit log, and
 * a dry run shows all of it without writing anything.
 *
 * The books: these are records' own tags. A record from before the books
 * started is carried by the opening balance and books nothing when re-tagged;
 * one after it is moved between depots by the posting engine's next run.
 *
 * Reads and writes DATABASE_URL — check which database .env names first.
 */
require("dotenv").config();
const { client } = require("../db");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const texts = process.argv.flatMap((a, i) => (a === "--text" ? [process.argv[i + 1]] : [])).filter(Boolean);
const FROM = Number(arg("--from"));
const INTO = Number(arg("--into"));
const APPLY = process.argv.includes("--apply");

/** Tables that point at a depot by id. `key`: what the depot may hold only once of. */
const BY_ID = [
  { table: "orders", col: "depot_id" },
  { table: "commissions", col: "depot_id" },
  { table: "deposits", col: "depot_id" },
  { table: "depot_price_changes", col: "depot_id" },
  { table: "expected_payments", col: "depot_id" },
  { table: "pfi_truck_allocations", col: "depot_id" },
  { table: "contacts", col: "location_id" },
  { table: "pfis", col: "location_id" },
  { table: "depot_product_prices", col: "depot_id", key: "product_id" },
  { table: "depot_product_capacities", col: "depot_id", key: "product_id" },
  { table: "depot_product_commissions", col: "depot_id", key: "product_id" },
  { table: "depot_staff", col: "depot_id", key: "staff_id" },
  { table: "pfi_allowed_locations", col: "depot_id", key: "pfi_id" },
];
/** Text that names a depot. */
const BY_TEXT = [
  { table: "delivery_sales", col: "depot_loaded" },
  { table: "delivery_inventory", col: "depot" },
  { table: "delivery_notes", col: "depot_of_loading" },
  { table: "pfis", col: "location_name" },
];
const JSON_LISTS = [{ table: "bank_accounts", col: "depot_ids" }, { table: "bank_accounts", col: "assigned_depot_ids" }];

const ident = (s) => `"${s.replace(/"/g, '""')}"`;

(async () => {
  if (!FROM || !INTO || FROM === INTO) throw new Error("Give --from <depot id> and --into <another depot id>");
  const [from] = await client`SELECT * FROM depots WHERE id = ${FROM}`;
  const [into] = await client`SELECT * FROM depots WHERE id = ${INTO}`;
  if (!from || !into) throw new Error("Both depots must exist");
  const names = [...new Set([from.name, ...texts])];
  console.log(`Merge #${FROM} ${from.name}  →  #${INTO} ${into.name}${APPLY ? "" : "   (dry run)"}`);
  console.log(`Text renamed to "${into.name}": ${names.map((x) => `"${x}"`).join(", ")}\n`);

  const run = async (tx) => {
    const undo = `depot_merge_${FROM}_into_${INTO}`;
    if (APPLY) {
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS ${undo} (tbl text, row_id integer, col text, old_value text, saved_at timestamptz DEFAULT now())`);
    }
    const save = async (table, col, rows) => {
      if (!APPLY || !rows.length) return;
      for (const r of rows) {
        await tx.unsafe(`INSERT INTO ${undo} (tbl, row_id, col, old_value) VALUES ($1, $2, $3, $4)`,
          [table, r.id, col, typeof r.old === "object" ? JSON.stringify(r.old) : String(r.old)]);
      }
    };
    const summary = [];

    for (const { table, col, key } of BY_ID) {
      const rows = await tx.unsafe(`SELECT * FROM ${ident(table)} WHERE ${ident(col)} = $1`, [FROM]);
      if (!rows.length) continue;
      let dropped = [];
      if (key) {
        const held = new Set((await tx.unsafe(`SELECT ${ident(key)} AS k FROM ${ident(table)} WHERE ${ident(col)} = $1`, [INTO])).map((r) => String(r.k)));
        dropped = rows.filter((r) => held.has(String(r[key])));
      }
      const moved = rows.filter((r) => !dropped.includes(r));
      summary.push(`${table}: ${moved.length} moved${dropped.length ? `, ${dropped.length} dropped (${INTO} already has them)` : ""}`);
      if (!APPLY) continue;
      await save(table, "*row*", dropped.map((r) => ({ id: r.id, old: r })));
      if (dropped.length) await tx.unsafe(`DELETE FROM ${ident(table)} WHERE id = ANY($1::int[])`, [dropped.map((r) => r.id)]);
      await save(table, col, moved.map((r) => ({ id: r.id, old: FROM })));
      if (moved.length) await tx.unsafe(`UPDATE ${ident(table)} SET ${ident(col)} = $1 WHERE id = ANY($2::int[])`, [INTO, moved.map((r) => r.id)]);
    }

    for (const { table, col } of BY_TEXT) {
      const rows = await tx.unsafe(`SELECT id, ${ident(col)} AS v FROM ${ident(table)} WHERE btrim(${ident(col)}) = ANY($1::text[])`, [names]);
      if (!rows.length) continue;
      summary.push(`${table}.${col}: ${rows.length} renamed`);
      if (!APPLY) continue;
      await save(table, col, rows.map((r) => ({ id: r.id, old: r.v })));
      await tx.unsafe(`UPDATE ${ident(table)} SET ${ident(col)} = $1 WHERE id = ANY($2::int[])`, [into.name, rows.map((r) => r.id)]);
    }

    for (const { table, col } of JSON_LISTS) {
      const rows = await tx.unsafe(`SELECT id, ${ident(col)} AS v FROM ${ident(table)} WHERE ${ident(col)} @> $1::jsonb OR ${ident(col)} @> $2::jsonb`,
        [JSON.stringify([FROM]), JSON.stringify([String(FROM)])]);
      if (!rows.length) continue;
      summary.push(`${table}.${col}: ${rows.length} lists changed`);
      if (!APPLY) continue;
      await save(table, col, rows.map((r) => ({ id: r.id, old: r.v })));
      for (const r of rows) {
        const list = [...new Set((r.v || []).map((x) => (Number(x) === FROM ? INTO : Number(x))))];
        await tx.unsafe(`UPDATE ${ident(table)} SET ${ident(col)} = $1::jsonb WHERE id = $2`, [JSON.stringify(list), r.id]);
      }
    }

    summary.push(`depots: #${FROM} removed`);
    if (APPLY) {
      await save("depots", "*row*", [{ id: FROM, old: from }]);
      await tx`DELETE FROM depots WHERE id = ${FROM}`;
      await tx`
        INSERT INTO audit_logs (entity_type, entity_id, action, prev_state, new_state, actor_type, metadata)
        VALUES ('depot', ${INTO}, 'depot.merged', NULL, 'merged', 'system',
                ${JSON.stringify({ from: { id: FROM, name: from.name }, into: { id: INTO, name: into.name }, renamedText: names, summary, undo })}::jsonb)`;
    }
    for (const line of summary) console.log(`  ${line}`);
    return summary;
  };

  if (APPLY) {
    await client.begin(run);
    console.log(`\nDone. Everything changed is saved in depot_merge_${FROM}_into_${INTO}.`);
  } else {
    await run(client);
    console.log("\nDry run — nothing changed. Add --apply to merge.");
  }
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
