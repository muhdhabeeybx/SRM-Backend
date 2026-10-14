/**
 * One-off, 2026-10-13: order 12434's "Surplus recorded as delivery" entry (id 1)
 *
 * Changes recorded_by + recorded_by_name on that one entry only. The audit_logs
 * row is left as it is. Undo: surplus_delivery_recorder_fix_20261013.
 *
 *   node scripts/fix-surplus-delivery-recorder-20261013.js          # dry run
 *   node scripts/fix-surplus-delivery-recorder-20261013.js --apply
 */
require("dotenv").config();
const postgres = require("postgres");

const apply = process.argv.includes("--apply");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });

(async () => {
  console.log("DB host:", new URL(process.env.DATABASE_URL).hostname);

  const [entry] = await sql`SELECT * FROM order_surplus_deliveries WHERE id = 1 AND order_id = 12434`;
  if (!entry) throw new Error("entry 1 on order 12434 not found");
  console.log("Entry now:", entry.recorded_by, entry.recorded_by_name);

  const eme = await sql`
    SELECT id, first_name, surname, email FROM staff
    WHERE first_name ILIKE 'eme%' AND surname ILIKE 'obioh%'`;
  console.log("Matches:", eme);
  if (eme.length !== 1) throw new Error(`expected exactly one Eme Obioh, found ${eme.length}`);
  const staff = eme[0];
  const name = `${staff.first_name} ${staff.surname}`.trim();

  if (!apply) {
    console.log(`Dry run: would set entry 1 to #${staff.id} ${name}. Re-run with --apply.`);
    return sql.end();
  }

  await sql.begin(async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS surplus_delivery_recorder_fix_20261013 (
        entry_id int, old_id int, old_name text, new_id int, new_name text,
        fixed_at timestamptz DEFAULT now())`;
    await tx`
      INSERT INTO surplus_delivery_recorder_fix_20261013 (entry_id, old_id, old_name, new_id, new_name)
      VALUES (1, ${entry.recorded_by}, ${entry.recorded_by_name}, ${staff.id}, ${name})`;
    await tx`
      UPDATE order_surplus_deliveries
         SET recorded_by = ${staff.id}, recorded_by_name = ${name}
       WHERE id = 1 AND order_id = 12434`;
  });

  const [after] = await sql`SELECT recorded_by, recorded_by_name FROM order_surplus_deliveries WHERE id = 1`;
  console.log("Entry after:", after);
  await sql.end();
})().catch(async (e) => { console.error(e.message); await sql.end(); process.exit(1); });
