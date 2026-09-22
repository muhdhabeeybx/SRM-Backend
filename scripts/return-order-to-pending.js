#!/usr/bin/env node
/**
 * Put an order back to Pending, with nothing paid against it.
 *
 * ── Why this is a script and not an endpoint ───────────────────────────────
 *
 * There is no legal transition back to Pending. TRANSITIONS in
 * orderStatus.service.js reads Pending -> Paid -> Released -> Loading ->
 * Completed and never the other way, deliberately: once a truck has gated in,
 * the order describes something that physically happened. So this writes
 * `orders.status` directly, which is exactly the kind of thing that should
 * take a named script, a dry run and a rollback file rather than a button.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 *
 *   1. Refuses outright if any payment row still stands on the order. Resetting
 *      amount_paid to 0 while rows remain would put the cached figure BELOW its
 *      own evidence — the mirror of the ₦1.11bn overstatement migration 0021
 *      left behind. Unmatch the payments first (the dashboard can do this now;
 *      see the paymentParam fix), then run this.
 *
 *   2. Deletes the order's tickets. A ticket is authority to load, and
 *      `ticket_status` has no void state — Active or Redeemed, nothing else —
 *      so a ticket issued for a payment that has since been removed cannot be
 *      neutralised in place. Leaving it would let the full quantity be loaded
 *      against an unpaid, pending order. Confirming payment again regenerates
 *      it: runPostPaymentEffects is idempotent.
 *
 *   3. Deletes the order's commission rows, for the same reason — they were
 *      written by the post-payment effects of a payment that no longer exists.
 *
 *   4. Sets status Pending, paymentStatus Unpaid, amountPaid 0,
 *      paymentConfirmedAt null, and writes an audit row naming what it removed.
 *
 * What it deliberately does NOT touch: the PFI allocation. The order is still
 * live and still holds its quantity against the batch. And order_trucks — if a
 * truck has gated out, product physically left the depot, and deleting that
 * record would erase the only evidence of it. The script warns instead.
 *
 * ── Read this before running it on a delivered order ──────────────────────
 *
 * `findStalePending` sweeps orders that are Pending AND Unpaid AND past their
 * deadline (23:59 Lagos on the day they were placed), expires them, and hands
 * their reserved stock back to the PFI. Note what that means here: an order
 * you return to Pending today but which was PLACED on an earlier day is
 * already past its deadline, so the next sweep or portal read will expire it
 * straight back. If you need it to stay Pending, pay it or set
 * ORDER_EXPIRY_DISABLED=true for the duration.
 *
 * That sweep is correct for an order nobody has loaded. It is NOT correct for
 * one whose trucks have gated out: the stock is physically gone, and returning
 * it to the batch invents inventory. The script refuses those unless you pass
 * --gated-out-anyway, so the decision is explicit.
 *
 * Usage:
 *   node scripts/return-order-to-pending.js --order=11761           # dry run
 *   node scripts/return-order-to-pending.js --order=11761 --apply
 *   node scripts/return-order-to-pending.js --order=11761 --apply --gated-out-anyway
 *
 * --apply writes scripts/rollback-order-to-pending-<stamp>.json holding the
 * order's previous status and money columns plus every ticket and commission
 * row removed, so the change can be undone.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { eq } = require("drizzle-orm");
const { db } = require("../config/db");
const { orders, tickets, commissions, orderPayments, orderTrucks } = require("../db/schema");
const { auditLogRepo } = require("../repositories");

const APPLY = process.argv.includes("--apply");
const GATED_OUT_ANYWAY = process.argv.includes("--gated-out-anyway");
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const REASON = "Returned to Pending — no payment stands on this order";

async function main() {
  const orderId = Number(arg("order"));
  if (!Number.isInteger(orderId) || orderId <= 0) {
    console.error("Pass --order=<id>, e.g. --order=11761 (the numeric id; AT11761's id is 11761).");
    process.exit(1);
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) {
    console.error(`No order ${orderId}.`);
    process.exit(1);
  }

  const pays = await db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
  const tks = await db.select().from(tickets).where(eq(tickets.orderId, orderId));
  const cms = await db.select().from(commissions).where(eq(commissions.orderId, orderId));
  const trucks = await db.select().from(orderTrucks).where(eq(orderTrucks.orderId, orderId));
  const gatedOut = trucks.filter((t) => t.status === "gated_out");

  console.log(`order ${orderId}  ${order.orderNumber}  ${order.companyName}`);
  console.log(`  status         ${order.status} -> Pending`);
  console.log(`  payment_status ${order.paymentStatus} -> Unpaid`);
  console.log(`  amount_paid    ${order.amountPaid} -> 0.00`);
  console.log(`  total_amount   ${order.totalAmount}`);
  console.log(`  payment rows   ${pays.length}`);
  console.log(`  tickets        ${tks.length}${tks.length ? ` (${tks.map((t) => `${t.ticketNumber}/${t.status}`).join(", ")}) -> deleted` : ""}`);
  console.log(`  commissions    ${cms.length}${cms.length ? " -> deleted" : ""}`);
  console.log(`  trucks         ${trucks.length}${gatedOut.length ? `, ${gatedOut.length} GATED OUT` : ""}`);

  if (pays.length > 0) {
    console.error(
      `\nRefusing: ${pays.length} payment row(s) totalling ` +
        `₦${pays.reduce((s, p) => s + Number(p.amount), 0).toLocaleString()} still stand on this order.\n` +
        `Unmatch them first, then re-run — resetting amount_paid to 0 underneath live rows\n` +
        `would leave the cached figure below its own evidence.`
    );
    process.exit(1);
  }

  if (gatedOut.length > 0 && !GATED_OUT_ANYWAY) {
    console.error(
      `\nRefusing: ${gatedOut.length} truck(s) have gated out — ` +
        `${gatedOut.map((t) => t.truckNumber).join(", ")}.\n` +
        `Product physically left the depot. Pending + Unpaid is what findStalePending\n` +
        `sweeps, and expiring this order would hand its reserved stock back to the PFI,\n` +
        `inventing inventory that is already gone. Pass --gated-out-anyway to override.`
    );
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  await db.transaction(async (tx) => {
    // Re-read under a row lock so a concurrent payment cannot land between the
    // check above and the write below.
    const [locked] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    const nowPays = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    if (nowPays.length > 0) throw new Error("a payment landed while this was running — aborted");

    const removedTickets = await tx.delete(tickets).where(eq(tickets.orderId, orderId)).returning();
    const removedCommissions = await tx.delete(commissions).where(eq(commissions.orderId, orderId)).returning();

    await tx
      .update(orders)
      .set({
        status: "Pending",
        paymentStatus: "Unpaid",
        amountPaid: "0.00",
        paymentConfirmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.returned_to_pending",
        prevState: locked.status,
        newState: "Pending",
        actor: { type: "system" },
        metadata: {
          reason: REASON,
          ticketsRemoved: removedTickets.map((t) => t.ticketNumber),
          commissionsRemoved: removedCommissions.length,
          gatedOutTrucks: gatedOut.map((t) => t.truckNumber),
        },
      },
      tx
    );

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(__dirname, `rollback-order-to-pending-${stamp}.json`);
    fs.writeFileSync(
      rollbackPath,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          note:
            "Undo: restore orders.status/payment_status/amount_paid/payment_confirmed_at from orderBefore, " +
            "then re-insert ticketsRemoved and commissionsRemoved.",
          orderBefore: {
            id: locked.id,
            orderNumber: locked.orderNumber,
            status: locked.status,
            paymentStatus: locked.paymentStatus,
            amountPaid: locked.amountPaid,
            paymentConfirmedAt: locked.paymentConfirmedAt,
          },
          ticketsRemoved: removedTickets,
          commissionsRemoved: removedCommissions,
        },
        null,
        2
      )
    );

    console.log(`\napplied. status ${locked.status} -> Pending`);
    console.log(`  tickets deleted    : ${removedTickets.map((t) => t.ticketNumber).join(", ") || "none"}`);
    console.log(`  commissions deleted: ${removedCommissions.length}`);
    console.log(`rollback written to ${rollbackPath}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("return-order-to-pending failed:", err.message);
    process.exit(1);
  });
