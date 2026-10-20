#!/usr/bin/env node
/**
 * Bring PFIs' past trip AGO onto the AGO stock ledger (0093).
 *
 * The owner's choice, 2026-10-20: PFI 47B, 47C and 47D only (ids 69, 71, 73).
 * Every other trip keeps the AGO typed on Delivery Costing.
 *
 * Each trip with AGO typed on it becomes one "AGO given" entry for that trip:
 * the same litres, dated the day it was allocated. So Delivery Costing reads
 * the same figure as before, now from the ledger. Trips with no AGO, or 0, are
 * left out and listed.
 *
 * The ledger never lets stock go below nothing, so the stock those trucks
 * drew on has to be there first: the opening balance (dated on or before the
 * first trip) and the AGO received since. Pass them unless the ledger already
 * has its opening.
 *
 *   node scripts/ago-bring-over.js --pfis 69,71,73 \
 *     --opening 2026-09-21:120000:"Tank dip" \
 *     --received 2026-10-03:20000:"NIPCO, waybill 4471" [--received …] \
 *     [--apply]
 *
 * Dry run by default: prints the plan, the balance day by day and, if the
 * book would not hold, why and the smallest opening that would. --apply
 * writes everything in one transaction, under the ledger's own lock, after
 * checking the whole book again. Re-running is refused trip by trip: a trip
 * already on the ledger is never given twice.
 */
require("dotenv").config();
const { client } = require("../db");
const { assertBookHolds, bookOrder } = require("../services/agoStock.service");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const APPLY = flag("apply");
const SOURCE = "Brought over from Delivery Costing";
const L = (n) => `${Math.round(n * 100) / 100 === 0 ? 0 : (Math.round(n * 100) / 100).toLocaleString("en-NG")} L`;

/** "2026-09-21:120000:Tank dip" → { day, litres, description } */
const stockArg = (raw, what) => {
  const [day, litres, ...rest] = String(raw).split(":");
  const n = Number(String(litres).replace(/,/g, ""));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || !(n > 0)) throw new Error(`--${what} must be YYYY-MM-DD:LITRES[:description], got "${raw}"`);
  return { day, litres: Math.round(n * 100) / 100, description: rest.join(":").trim() };
};

async function main() {
  const pfiIds = (values("pfis")[0] || "").split(",").map(Number).filter((n) => n > 0);
  if (!pfiIds.length) throw new Error("--pfis is required, e.g. --pfis 69,71,73");
  const opening = values("opening")[0] ? stockArg(values("opening")[0], "opening") : null;
  const received = values("received").map((r) => stockArg(r, "received"));

  console.log(`Database: ${new URL(process.env.DATABASE_URL).hostname}`);
  console.log(APPLY ? "APPLY — writing" : "Dry run — nothing is written (add --apply)");

  const pfis = await client`SELECT id, pfi_number FROM pfis WHERE id = ANY(${pfiIds}::int[]) ORDER BY id`;
  if (pfis.length !== pfiIds.length) throw new Error(`Not every PFI was found: asked ${pfiIds}, found ${pfis.map((p) => p.id)}`);
  const trips = await client`
    SELECT di.id, di.pfi_id, p.pfi_number, di.truck_id,
           COALESCE(NULLIF(trim(di.truck_number), ''), ft.plate_number, '') AS truck_number,
           di.ago_litres, di.date_allocated
      FROM delivery_inventory di
      JOIN pfis p ON p.id = di.pfi_id
      LEFT JOIN fleet_trucks ft ON ft.id = di.truck_id
     WHERE di.pfi_id = ANY(${pfiIds}::int[])
     ORDER BY di.date_allocated, di.id`;

  const book = (await client`
    SELECT id, kind, litres, issue_id, trip_id, truck_number, to_char(entry_date, 'YYYY-MM-DD') AS day
      FROM ago_stock_entries WHERE deleted_at IS NULL`).map((r) => ({
    id: Number(r.id), kind: r.kind, litres: Number(r.litres), day: r.day,
    issueId: r.issue_id == null ? null : Number(r.issue_id), tripId: r.trip_id == null ? null : Number(r.trip_id), truckNumber: r.truck_number,
  }));
  const hasOpening = book.some((e) => e.kind === "opening");
  if (hasOpening && opening) throw new Error("The ledger already has its opening balance — leave --opening out.");
  if (!hasOpening && !opening) console.log("\nNo opening balance on the ledger and none passed: the plan below shows the opening it would need.");

  const skipped = [];
  const onLedger = new Set(book.filter((e) => e.kind === "given" && e.tripId).map((e) => e.tripId));
  const gives = [];
  for (const t of trips) {
    const litres = t.ago_litres == null ? null : Number(t.ago_litres);
    const why = !t.truck_number ? "no truck"
      : litres == null ? "no AGO typed"
        : !(litres > 0) ? "0 L typed"
          : !/^\d{4}-\d{2}-\d{2}$/.test(t.date_allocated || "") ? `no usable date (${t.date_allocated || "blank"})`
            : onLedger.has(Number(t.id)) ? "already on the ledger"
              : null;
    if (why) { skipped.push({ ...t, why }); continue; }
    gives.push({ tripId: Number(t.id), pfiId: Number(t.pfi_id), pfiNumber: t.pfi_number, truckId: t.truck_id == null ? null : Number(t.truck_id), truckNumber: t.truck_number, litres, day: t.date_allocated });
  }

  // Ids above any real one, in the order they will be written: stock first, then the trips.
  let next = 2 ** 31;
  const stock = [
    ...(opening ? [{ id: next++, kind: "opening", litres: opening.litres, day: opening.day, issueId: null, description: opening.description || "Opening balance" }] : []),
    ...received.map((r) => ({ id: next++, kind: "received", litres: r.litres, day: r.day, issueId: null, description: r.description })),
  ];
  const given = gives.map((g) => ({ ...g, id: next++, kind: "given", issueId: null }));

  console.log(`\nPFIs: ${pfis.map((p) => `#${p.id} ${p.pfi_number}`).join(", ")}`);
  for (const p of pfis) {
    const mine = given.filter((g) => g.pfiId === Number(p.id));
    console.log(`  ${p.pfi_number}: ${mine.length} trucks, ${L(mine.reduce((s, g) => s + g.litres, 0))}`);
  }
  console.log(`  Total to bring over: ${given.length} trucks, ${L(given.reduce((s, g) => s + g.litres, 0))}`);
  if (skipped.length) {
    console.log(`\nLeft out (${skipped.length}):`);
    for (const s of skipped) console.log(`  trip #${s.id} ${s.truck_number || "?"} on ${s.pfi_number}, ${s.date_allocated}: ${s.why}`);
  }
  if (stock.length) {
    console.log("\nStock entered first:");
    for (const s of stock) console.log(`  ${s.day}  ${s.kind === "opening" ? "Opening balance" : "Stock received"}  ${L(s.litres)}${s.description ? `  — ${s.description}` : ""}`);
  }

  // The balance day by day, and the smallest opening that would hold it.
  const all = [...book, ...stock, ...given].sort(bookOrder);
  const signOf = (k) => (["opening", "received", "retrieved", "adjust_in"].includes(k) ? 1 : -1);
  let bal = 0;
  let withoutOpening = 0;
  let low = 0;
  const byDay = new Map();
  for (const e of all) {
    bal += signOf(e.kind) * e.litres;
    byDay.set(e.day, bal);
    if (e.kind === "opening") continue;
    // The lowest the stock falls before any opening: the opening has to cover it.
    withoutOpening += signOf(e.kind) * e.litres;
    low = Math.min(low, withoutOpening);
  }
  console.log("\nStock balance at the end of each day:");
  for (const [day, b] of byDay) console.log(`  ${day}  ${L(b)}`);

  let holds = true;
  try {
    assertBookHolds([...book, ...stock, ...given]);
  } catch (err) {
    holds = false;
    console.log(`\nThe ledger would refuse this: ${err.message}`);
    if (!hasOpening) console.log(`With these receipts, the opening (dated on or before ${given[0]?.day}) must be at least ${L(-low)}.`);
  }
  if (!given.length && !stock.length) {
    console.log("\nNothing to bring over: every trip with AGO is on the ledger already.");
    return;
  }
  if (!holds || !APPLY) {
    console.log(holds ? "\nThe book holds. Run again with --apply to write it." : "");
    return;
  }

  // ── Write ────────────────────────────────────────────────────────────────
  const written = await client.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ago_stock_entries'))`;
    // Checked again under the lock, against the book as it stands now.
    const now = (await tx`
      SELECT id, kind, litres, issue_id, trip_id, truck_number, to_char(entry_date, 'YYYY-MM-DD') AS day
        FROM ago_stock_entries WHERE deleted_at IS NULL`).map((r) => ({
      id: Number(r.id), kind: r.kind, litres: Number(r.litres), day: r.day,
      issueId: r.issue_id == null ? null : Number(r.issue_id), tripId: r.trip_id == null ? null : Number(r.trip_id),
    }));
    if (now.length !== book.length) throw new Error("The ledger changed while this ran. Run it again.");
    assertBookHolds([...now, ...stock, ...given]);

    const ids = [];
    for (const s of stock) {
      const [row] = await tx`
        INSERT INTO ago_stock_entries (entry_date, kind, litres, description, recorded_by_name)
        VALUES (${s.day}, ${s.kind}, ${s.litres}, ${s.description}, ${SOURCE}) RETURNING id`;
      ids.push(Number(row.id));
      await tx`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata)
        VALUES ('ago_stock_entry', ${row.id}, ${`ago_stock.${s.kind}`}, 'system',
                ${JSON.stringify({ source: "scripts/ago-bring-over.js", entryDate: s.day, litres: s.litres, description: s.description })}::jsonb)`;
    }
    for (const g of given) {
      const [row] = await tx`
        INSERT INTO ago_stock_entries (entry_date, kind, litres, trip_id, truck_id, truck_number, pfi_id, description, recorded_by_name)
        VALUES (${g.day}, 'given', ${g.litres}, ${g.tripId}, ${g.truckId}, ${g.truckNumber}, ${g.pfiId}, ${SOURCE}, ${SOURCE})
        RETURNING id`;
      ids.push(Number(row.id));
      await tx`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata)
        VALUES ('ago_stock_entry', ${row.id}, 'ago_stock.given', 'system',
                ${JSON.stringify({ source: "scripts/ago-bring-over.js", entryDate: g.day, litres: g.litres, tripId: g.tripId, truckNumber: g.truckNumber, pfiId: g.pfiId })}::jsonb)`;
    }
    return ids;
  });
  console.log(`\nWritten: ${written.length} entries (ids ${written[0]}–${written[written.length - 1]}).`);
}

main()
  .catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; })
  .finally(() => client.end({ timeout: 5 }));
