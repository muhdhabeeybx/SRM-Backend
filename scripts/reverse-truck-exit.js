#!/usr/bin/env node
/**
 * Put a truck back on the yard: gated_out → loaded, so it can be entered and
 * exited again.
 *
 * ── "Ticketed" is `loaded`, not `pending` ─────────────────────────────────
 *
 * The gate flow is:
 *
 *   generate-tickets (ticketing)   →  loaded      the ticket IS the loading
 *   gate-in  (security_entry)   loaded → gated_in     first truck ⇒ Released→Loading
 *   gate-out (security_exit)  gated_in → gated_out    last truck  ⇒ Loading→Completed
 *
 * `pending` is the state BEFORE a ticket exists — a fleet allocation captured
 * at release. So a truck that has been ticketed and is to be re-gated belongs
 * in `loaded`: its ticket is real, still Active, and must stay attached.
 * Sending it to `pending` would orphan a live ticket from the load it names.
 *
 * ── What is undone, and what is deliberately not ──────────────────────────
 *
 * Undone: the two gate stamps and everything observed at them — entered,
 * exited, the driver seen at the gate, the gantry and loader recorded on the
 * way out. They describe a trip that is being re-done, so leaving them would
 * mean the second entry silently keeps the first one's observations.
 *
 * Kept: `loadedAt`/`loadedBy` and the ticket. The ticket was cut, it is Active,
 * and it is the authority the truck carries — the point of this script is to
 * re-run the GATE, not to re-issue paperwork.
 *
 * Kept: pfi_movements. Stock leaves the batch at TICKET GENERATION, not at the
 * gate (see aggregatesFor in repositories/pfiExpense.repository.js). The litres
 * are already accounted against the batch and the ticket still stands, so
 * touching the movement here would be inventing stock back into a cargo that
 * has genuinely been drawn on.
 *
 * Kept: payments, commissions and the PFI reservation. None of them are a
 * function of which side of the gate a truck is on.
 *
 * ── The order comes back to Loading ───────────────────────────────────────
 *
 * The last truck out completes an order, so un-exiting one has to un-complete
 * it: `Completed` → `Loading`, `completed_at` → null. There is no legal
 * backwards transition — TRANSITIONS is forward-only on purpose — so this
 * writes the column directly, which is exactly the kind of thing that should
 * take a named script with a dry run and a rollback rather than a button.
 *
 * Completion also calls walletService.convertHold, which books a wallet hold
 * as a debit. That is NOT reversed here, and for these orders it did nothing —
 * the script refuses if a hold exists, so the case never passes silently.
 *
 * Once the truck is gated out again, gateOutTruck re-completes the order on
 * its own: it looks for `order.status === "Loading"` with nothing remaining,
 * which is precisely the state this leaves behind.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/reverse-truck-exit.js --load=29673                 # dry run
 *   node scripts/reverse-truck-exit.js --load=29673,29674 --apply
 *   node scripts/reverse-truck-exit.js --order=11933 --plate="ABC 123 XA" --apply
 *
 * --apply writes scripts/rollback-truck-exit-<stamp>.json with every column it
 * cleared and each order's previous status, so the exits can be put back.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { eq, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { orders, orderTrucks, tickets, walletHolds } = require("../db/schema");
const { auditLogRepo } = require("../repositories");

const APPLY = process.argv.includes("--apply");
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const plateKey = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");

/** The gate observations. All of them describe the trip being re-done. */
const CLEARED = {
  status: "loaded",
  securityEnteredAt: null,
  securityEnteredBy: null,
  securityExitedAt: null,
  securityExitedBy: null,
  entryDriverName: null,
  entryDriverPhone: null,
  gantry: null,
  loaderName: null,
  loaderPhone: null,
};

async function main() {
  const loadArg = arg("load");
  const orderArg = arg("order");
  const plateArg = arg("plate");

  let loads = [];
  if (loadArg) {
    const ids = loadArg.split(",").map((s) => Number(s.trim())).filter(Number.isInteger);
    loads = await db.select().from(orderTrucks).where(inArray(orderTrucks.id, ids));
    const missing = ids.filter((id) => !loads.some((l) => l.id === id));
    if (missing.length) { console.error(`No truck load ${missing.join(", ")}.`); process.exit(1); }
  } else if (orderArg && plateArg) {
    const all = await db.select().from(orderTrucks).where(eq(orderTrucks.orderId, Number(orderArg)));
    loads = all.filter((l) => plateKey(l.truckNumber) === plateKey(plateArg));
    if (!loads.length) {
      console.error(`No load on order ${orderArg} with plate "${plateArg}".`);
      console.error(`Plates on that order: ${all.map((l) => l.truckNumber).join(", ")}`);
      process.exit(1);
    }
  } else {
    console.error('Pass --load=<id>[,<id>] or --order=<id> --plate="ABC 123 XA".');
    process.exit(1);
  }

  const orderIds = [...new Set(loads.map((l) => l.orderId))];
  const orderRows = await db.select().from(orders).where(inArray(orders.id, orderIds));
  const orderById = new Map(orderRows.map((o) => [o.id, o]));
  const allTickets = await db.select().from(tickets).where(inArray(tickets.orderId, orderIds));
  const holds = await db.select().from(walletHolds).where(inArray(walletHolds.orderId, orderIds));

  const refusals = [];
  console.log("Truck loads to put back on the yard:\n");
  for (const l of loads) {
    const o = orderById.get(l.orderId);
    const tk = allTickets.find((t) => t.orderTruckId === l.id);
    console.log(`  load ${l.id}  order ${l.orderId}  truck ${l.truckIndex}  ${l.truckNumber}`);
    console.log(`    status        ${l.status} -> loaded`);
    console.log(`    quantity      ${Number(l.quantity).toLocaleString("en-NG")} L`);
    console.log(`    ticket        ${tk ? `${tk.ticketNumber} [${tk.status}] — kept` : "none"}`);
    console.log(`    entered       ${l.securityEnteredAt ? new Date(l.securityEnteredAt).toISOString() : "—"} -> null`);
    console.log(`    exited        ${l.securityExitedAt ? new Date(l.securityExitedAt).toISOString() : "—"} -> null`);
    console.log(`    loaded        ${l.loadedAt ? new Date(l.loadedAt).toISOString() : "—"} — kept`);
    console.log(`    gantry/loader ${l.gantry || "—"} / ${l.loaderName || "—"} -> null`);
    console.log("");

    if (l.status !== "gated_out") refusals.push(`load ${l.id} is ${l.status}, not gated_out`);
    if (tk && tk.status === "Redeemed") {
      refusals.push(`load ${l.id}'s ticket ${tk.ticketNumber} is Redeemed — re-gating would re-use a spent ticket`);
    }
  }

  console.log("Orders affected:\n");
  const ordersToReopen = [];
  for (const id of orderIds) {
    const o = orderById.get(id);
    const mine = loads.filter((l) => l.orderId === id).length;
    const total = (await db.select().from(orderTrucks).where(eq(orderTrucks.orderId, id))).length;
    const reopen = o.status === "Completed";
    if (reopen) ordersToReopen.push(id);
    console.log(`  order ${id}  ${o.orderNumber}`);
    console.log(`    status        ${o.status}${reopen ? " -> Loading" : " (unchanged)"}`);
    console.log(`    completed_at  ${o.completedAt ? new Date(o.completedAt).toISOString() : "—"}${reopen ? " -> null" : ""}`);
    console.log(`    trucks        ${mine} of ${total} being reversed`);
    console.log("");
    if (o.status !== "Completed" && o.status !== "Loading") {
      refusals.push(`order ${id} is ${o.status} — expected Completed or Loading`);
    }
  }

  const liveHolds = holds.filter((h) => h.status !== "released");
  if (liveHolds.length) {
    refusals.push(
      `${liveHolds.length} wallet hold(s) on these orders — completion booked them as a debit and this script does not reverse money`
    );
  }

  if (refusals.length) {
    console.error("Refusing:");
    for (const r of refusals) console.error(`  · ${r}`);
    process.exit(1);
  }

  console.log("Untouched: tickets, pfi_movements (stock left at ticketing, not at the gate), payments, commissions.\n");

  if (!APPLY) {
    console.log("DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  const before = [];
  await db.transaction(async (tx) => {
    for (const id of orderIds) {
      const [locked] = await tx.select().from(orders).where(eq(orders.id, id)).for("update").limit(1);
      if (!["Completed", "Loading"].includes(locked.status)) {
        throw new Error(`order ${id} moved to ${locked.status} while this ran — aborted`);
      }
    }

    for (const l of loads) {
      const [now] = await tx.select().from(orderTrucks).where(eq(orderTrucks.id, l.id));
      if (now.status !== "gated_out") throw new Error(`load ${l.id} moved to ${now.status} while this ran — aborted`);

      before.push({
        loadId: l.id, orderId: l.orderId, truckNumber: l.truckNumber, status: l.status,
        securityEnteredAt: l.securityEnteredAt, securityEnteredBy: l.securityEnteredBy,
        securityExitedAt: l.securityExitedAt, securityExitedBy: l.securityExitedBy,
        entryDriverName: l.entryDriverName, entryDriverPhone: l.entryDriverPhone,
        gantry: l.gantry, loaderName: l.loaderName, loaderPhone: l.loaderPhone,
      });

      await tx.update(orderTrucks).set({ ...CLEARED, updatedAt: new Date() }).where(eq(orderTrucks.id, l.id));

      await auditLogRepo.record(
        {
          entityType: "order_truck",
          entityId: l.id,
          action: "order_truck.exit_reversed",
          prevState: "gated_out",
          newState: "loaded",
          actor: { type: "system" },
          metadata: {
            orderId: l.orderId,
            truckNumber: l.truckNumber,
            reason: "Returned to the yard so entry and exit can be recorded again",
            clearedEnteredAt: l.securityEnteredAt,
            clearedExitedAt: l.securityExitedAt,
          },
        },
        tx
      );
    }

    for (const id of ordersToReopen) {
      const o = orderById.get(id);
      await tx.update(orders).set({ status: "Loading", completedAt: null, updatedAt: new Date() }).where(eq(orders.id, id));
      await auditLogRepo.record(
        {
          entityType: "order",
          entityId: id,
          action: "order.reopened_for_regating",
          prevState: o.status,
          newState: "Loading",
          actor: { type: "system" },
          metadata: { reason: "A truck's exit was reversed, so the order is no longer fully departed" },
        },
        tx
      );
    }
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rollbackPath = path.join(__dirname, `rollback-truck-exit-${stamp}.json`);
  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        note: "Undo: restore each load's columns from loadsBefore, and each order's status/completedAt from ordersBefore.",
        loadsBefore: before,
        ordersBefore: ordersToReopen.map((id) => ({
          id,
          orderNumber: orderById.get(id).orderNumber,
          status: orderById.get(id).status,
          completedAt: orderById.get(id).completedAt,
        })),
      },
      null,
      2
    )
  );

  console.log(`✓ ${loads.length} truck load(s) back to loaded; ${ordersToReopen.length} order(s) back to Loading.`);
  console.log(`  rollback: ${rollbackPath}`);
  console.log(`\nThe gate can now record entry and exit again. Gating the last truck out re-completes the order by itself.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(`\nFAILED: ${err.message}`); process.exit(1); });
