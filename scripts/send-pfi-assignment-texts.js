/**
 * Text a PFI's officers that it is theirs, as what, and its account — the
 * text Start selling sends (services/pfiAssignmentNotices.service.js), for a
 * PFI that started before it existed. Written for PFI 55 (#82) on 29 Oct 2026.
 *
 *   node scripts/send-pfi-assignment-texts.js --pfi 82            dry run: prints each text
 *   node scripts/send-pfi-assignment-texts.js --pfi 82 --apply    sends them
 *
 * Sends through the engine in this process (bell + SMS), not the queue, so the
 * wording is this checkout's catalog whatever the server is running. Set
 * ADMIN_URL to the dashboard's origin so the bell row links to the PFI.
 */
require("dotenv").config();

const { sql } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { CATALOG } = require("../notifications/catalog");
const { notifyAndWait } = require("../notifications");
const { slotsHeld, accountsFor } = require("../services/pfiAssignmentNotices.service");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const apply = process.argv.includes("--apply");
const pfiId = Number(arg("pfi"));
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

(async () => {
  if (!Number.isInteger(pfiId) || pfiId <= 0) throw new Error("Pass --pfi <id>");
  console.log(`Database: ${new URL(process.env.DATABASE_URL).hostname}`);

  const [row] = rowsOf(await db.execute(sql`SELECT * FROM pfis WHERE id = ${pfiId}`));
  if (!row) throw new Error(`No PFI #${pfiId}`);
  const pfi = {
    id: row.id,
    pfiNumber: row.pfi_number,
    status: row.status,
    ...Object.fromEntries(
      require("../lib/pfiSlots").PFI_SLOTS.map((s) => [s.idKey, row[s.column]]),
    ),
  };
  if (pfi.status !== "active") throw new Error(`${pfi.pfiNumber} is ${pfi.status}, not selling`);

  const held = slotsHeld(pfi);
  const accounts = await accountsFor(pfi.id);
  const people = rowsOf(
    await db.execute(sql`
      SELECT id, first_name, surname, phone_number, alt_phone_number, sms_to, is_active, suspended
        FROM staff WHERE id IN (${sql.join([...held.keys()].map((id) => sql`${id}`), sql`, `)})`),
  );

  console.log(`${pfi.pfiNumber} (#${pfi.id}), ${accounts.length} account(s)\n`);
  for (const p of people) {
    const roles = held.get(Number(p.id));
    const data = { firstName: String(p.first_name || "").trim(), pfiId: pfi.id, pfiNumber: pfi.pfiNumber, roles, accounts };
    const text = CATALOG["staff.pfi_assigned"].sms(data);
    const able = p.is_active && !p.suspended;
    const phones = [p.phone_number, p.sms_to === "both" ? p.alt_phone_number : null].filter(Boolean).join(" + ");
    console.log(`${p.first_name} ${p.surname} (#${p.id}) — ${phones || "no phone"}${able ? "" : " — NOT ACTIVE, skipped"}`);
    console.log(`  ${text}`);
    console.log(`  ${text.length} characters, ${text.length <= 160 ? 1 : Math.ceil(text.length / 153)} SMS part(s)\n`);
    if (apply && able) {
      const result = await notifyAndWait("staff.pfi_assigned", { to: { staffId: Number(p.id) }, data });
      console.log(`  sent: ${JSON.stringify(result)}\n`);
    }
  }
  if (!apply) console.log("Dry run. Nothing was sent. Add --apply to send.");
  await client.end();
})().catch(async (err) => {
  console.error(err.message);
  await client.end().catch(() => {});
  process.exit(1);
});
