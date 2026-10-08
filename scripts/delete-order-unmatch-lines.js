#!/usr/bin/env node
/**
 * Delete an order outright, returning every bank statement line on it to the
 * unmatched pool first.
 *
 * ── Why this is a script and not the Delete button ─────────────────────────
 *
 * The super-admin DELETE /orders/:id removes the order and lets order_payments
 * cascade with it — but bank_statement_lines.matched_order_id has no foreign
 * key, so every line that paid for the order is left MATCHED, pointing at an
 * order that no longer exists. Nothing can ever match it again. This script
 * unmatches each payment through orderPayment.service.removePayment (the same
 * path as the bin on the finance report, audit row included) and then deletes
 * the order exactly as the controller does, all in ONE transaction: if the
 * delete is refused, the lines stay matched to a live order.
 *
 * ── What it refuses ───────────────────────────────────────────────────────
 *
 *   - a --ref that is not the order's displayed reference (AS12388 etc.), so a
 *     typo in --order cannot delete someone else's order;
 *   - transfer legs, refunds and transfer requests. Their tables are ON DELETE
 *     RESTRICT and each needs undoing on its own desk first;
 *   - an order that was itself merged away into another;
 *   - an order other orders were merged INTO, unless --with-merged. There is no
 *     unmerge: the merged-away orders are empty Cancelled rows whose only job is
 *     to point here, and their merge record and that pointer are both ON DELETE
 *     RESTRICT. The dry run lists them, with what each held before the merge.
 *     --with-merged deletes each merge record and merged-away order as well —
 *     only if that order really holds nothing — with an order.deleted audit row
 *     carrying its pre-merge figures;
 *   - legacy (wallet-era) payment rows, which have no statement line to return;
 *   - gated-out trucks, unless --gated-out-anyway: product physically left the
 *     depot and its PFI stock would be handed back.
 *
 * Usage (from Sman-Backend):
 *   node scripts/delete-order-unmatch-lines.js --order=12388 --ref=AS12388 --staff=1           # dry run
 *   node scripts/delete-order-unmatch-lines.js --order=12388 --ref=AS12388 --staff=1 --apply
 *   ... --with-merged        also delete the merge record and the empty orders merged into it
 *
 * --apply first writes scripts/backup-deleted-order-<id>-<stamp>.json holding
 * every row it is about to remove or change, so nothing is lost with the order.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { orderReferenceSql } = require("../lib/orderReferenceSql");
const { orderPfiAllocationRepo, pfiRepo, auditLogRepo } = require("../repositories");
const walletService = require("../services/wallet.service");
const orderPaymentService = require("../services/orderPayment.service");

const APPLY = process.argv.includes("--apply");
const GATED_OUT_ANYWAY = process.argv.includes("--gated-out-anyway");
const WITH_MERGED = process.argv.includes("--with-merged");
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const naira = (n) => `₦${Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);
const q = async (tx, query) => rowsOf(await tx.execute(query));

/** Everything that hangs off the order, read through whichever handle is given. */
async function gather(tx, orderId) {
  const [order] = await q(tx, sql`
    SELECT o.*, ${orderReferenceSql("o", "c")} AS reference, c.name AS customer_name
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${orderId}`);
  if (!order) return null;

  const payments = await q(tx, sql`SELECT * FROM order_payments WHERE order_id = ${orderId} ORDER BY id`);
  const lineIds = payments.map((p) => p.statement_line_id).filter((id) => id != null);
  const lines = await q(tx, sql`
    SELECT * FROM bank_statement_lines
     WHERE matched_order_id = ${orderId}
        OR id IN (SELECT statement_line_id FROM order_payments WHERE order_id = ${orderId} AND statement_line_id IS NOT NULL)
     ORDER BY id`);

  const by = (table, col = "order_id") => q(tx, sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier(col)} = ${orderId}`);
  return {
    order,
    payments,
    lineIds,
    lines,
    tickets: await by("tickets"),
    commissions: await by("commissions"),
    walletHolds: await by("wallet_holds"),
    orderTrucks: await by("order_trucks"),
    pfiAllocations: await by("order_pfi_allocations"),
    pfiMovements: await by("pfi_movements"),
    depositAllocations: await by("order_deposit_allocations"),
    truckAllocations: await by("pfi_truck_allocations"),
    expectedPayments: await by("expected_payments"),
    // ON DELETE RESTRICT: any row here blocks the delete.
    blockers: {
      transfers: await q(tx, sql`SELECT id, from_order_id, to_order_id, amount FROM order_payment_transfers WHERE from_order_id = ${orderId} OR to_order_id = ${orderId}`),
      refunds: await q(tx, sql`SELECT id, status, amount FROM order_refunds WHERE order_id = ${orderId}`),
      merges: await q(tx, sql`SELECT * FROM order_merges WHERE source_order_id = ${orderId} OR target_order_id = ${orderId} ORDER BY id`),
      mergedAway: await q(tx, sql`SELECT id FROM orders WHERE merged_into_order_id = ${orderId} ORDER BY id`),
      transferRequests: await q(tx, sql`SELECT id, status, from_order_id, to_order_id FROM order_transfer_requests WHERE from_order_id = ${orderId} OR to_order_id = ${orderId}`),
    },
  };
}

function refusals(g) {
  const out = [];
  const b = g.blockers;
  if (b.transfers.length) out.push(`${b.transfers.length} surplus transfer(s) — reverse them first`);
  if (b.refunds.length) out.push(`${b.refunds.length} refund request(s) — cancel or undo them first`);
  const id = g.order.id;
  if (g.order.merged_into_order_id != null || b.merges.some((m) => m.source_order_id === id)) {
    out.push(`this order was itself merged into order #${g.order.merged_into_order_id ?? "?"} — it holds nothing to delete`);
  }
  const inbound = shellIds(g);
  if (inbound.length && !WITH_MERGED) {
    out.push(`${inbound.length} order(s) were merged into this one (${inbound.map((s) => `#${s}`).join(", ")}) — pass --with-merged to delete them and the merge record too`);
  }
  if (b.transferRequests.length) out.push(`${b.transferRequests.length} surplus transfer request(s)`);
  const legs = g.payments.filter((p) => p.transfer_id != null || p.refund_id != null);
  if (legs.length) out.push(`${legs.length} transfer/refund payment row(s): ${legs.map((p) => `#${p.id} ${p.source}`).join(", ")}`);
  const legacy = g.payments.filter((p) => p.transfer_id == null && p.refund_id == null && p.statement_line_id == null);
  if (legacy.length) out.push(`${legacy.length} payment row(s) with no statement line (${legacy.map((p) => `#${p.id} ${p.source}`).join(", ")}) — nothing to return to the pool`);
  const gatedOut = g.orderTrucks.filter((t) => t.status === "gated_out");
  if (gatedOut.length && !GATED_OUT_ANYWAY) {
    out.push(`${gatedOut.length} truck(s) GATED OUT (${gatedOut.map((t) => t.truck_number).join(", ")}) — pass --gated-out-anyway to delete regardless`);
  }
  return out;
}

/** The orders merged into this one: by merge record or by their own pointer. */
const shellIds = (g) => [
  ...new Set([
    ...g.blockers.merges.filter((m) => m.target_order_id === g.order.id).map((m) => m.source_order_id),
    ...g.blockers.mergedAway.map((r) => r.id),
  ]),
].sort((a, b) => a - b);

/**
 * A merged-away order may go only if the merge really did empty it. Anything
 * still on it — a payment, a truck, stock, a ticket — means it is not the husk
 * the merge describes, and deleting it would destroy something real.
 */
function shellProblems(s, targetId) {
  const out = [];
  const o = s.order;
  if (o.merged_into_order_id !== targetId) out.push(`points to #${o.merged_into_order_id ?? "nothing"}, not #${targetId}`);
  if (o.status !== "Cancelled") out.push(`status ${o.status}, not Cancelled`);
  const held = {
    payments: s.payments, "statement lines": s.lines, tickets: s.tickets, commissions: s.commissions,
    "wallet holds": s.walletHolds, trucks: s.orderTrucks, "PFI allocations": s.pfiAllocations,
    "deposit allocations": s.depositAllocations, transfers: s.blockers.transfers, refunds: s.blockers.refunds,
    "transfer requests": s.blockers.transferRequests, "orders merged into it": s.blockers.mergedAway,
  };
  for (const [what, rows] of Object.entries(held)) if (rows.length) out.push(`${rows.length} ${what}`);
  if (s.blockers.merges.some((m) => m.target_order_id === o.id)) out.push("is itself a merge target");
  return out;
}

async function gatherShells(tx, g) {
  const shells = [];
  for (const sid of shellIds(g)) {
    const s = await gather(tx, sid);
    if (!s) throw new Error(`merge names order #${sid}, which does not exist`);
    shells.push(s);
  }
  return shells;
}

function reportShells(g, shells) {
  if (!shells.length) return;
  console.log(`\n  merged into this order (${shells.length}) — ${WITH_MERGED ? "DELETED with it, merge record included (--with-merged)" : "these block the delete; --with-merged deletes them too"}:`);
  for (const s of shells) {
    const m = g.blockers.merges.find((r) => r.source_order_id === s.order.id);
    const before = m?.source_before || {};
    const problems = shellProblems(s, g.order.id);
    console.log(`    #${s.order.id}  ${s.order.reference}  now ${s.order.status} / ${naira(s.order.total_amount)}  ${problems.length ? `NOT EMPTY: ${problems.join(", ")}` : "empty"}`);
    if (m) {
      console.log(`      merged ${new Date(m.created_at).toISOString()}${m.reason ? `  "${m.reason}"` : ""}`);
      console.log(`      before the merge: ${before.status ?? "?"}, qty ${before.quantity ?? "?"}, value ${naira(before.totalAmount)}, paid ${naira(before.amountPaid)}, placed ${before.createdAt ?? "?"}`);
    } else {
      console.log(`      no merge record — only its merged_into pointer`);
    }
  }
}

function report(g) {
  const o = g.order;
  console.log(`order ${o.id}  ${o.reference}  (stored number ${o.order_number})`);
  console.log(`  customer       ${o.customer_name ?? "-"} #${o.customer_id}`);
  console.log(`  status         ${o.status} / ${o.payment_status}`);
  console.log(`  total / paid   ${naira(o.total_amount)} / ${naira(o.amount_paid)}`);
  console.log(`  quantity       ${o.quantity}   PFI #${o.pfi_id ?? "-"}   placed ${new Date(o.created_at).toISOString()}`);

  console.log(`\n  payments (${g.payments.length}) — each removed, its line returned to UNMATCHED:`);
  for (const p of g.payments) {
    console.log(`    #${p.id}  ${p.source.padEnd(10)} ${naira(p.amount).padStart(20)}  line ${p.statement_line_id ?? "-"}  ${p.txn_date ?? ""}  ${p.depositor ?? ""}  ${p.bank_ref ?? ""}`);
  }
  console.log(`\n  statement lines (${g.lines.length}) — set UNMATCHED:`);
  for (const l of g.lines) {
    const via = g.lineIds.includes(l.id) ? "payment row" : "matched_order_id only";
    console.log(`    line ${l.id}  ${l.status}  amount ${naira(l.amount)}  ${l.txn_date ?? ""}  (${via})`);
  }

  console.log(`\n  removed with the order:`);
  console.log(`    tickets ${g.tickets.length}${g.tickets.length ? ` (${g.tickets.map((t) => `${t.ticket_number}/${t.status}`).join(", ")})` : ""}`);
  console.log(`    commissions ${g.commissions.length}, wallet holds ${g.walletHolds.length}, order trucks ${g.orderTrucks.length}${g.orderTrucks.length ? ` (${g.orderTrucks.map((t) => `${t.truck_number}/${t.status}`).join(", ")})` : ""}`);
  console.log(`    PFI allocations ${g.pfiAllocations.length} (stock released: ${g.pfiAllocations.map((a) => `PFI #${a.pfi_id} ${a.quantity}`).join(", ") || "none"})`);
  console.log(`    PFI movements ${g.pfiMovements.length}, deposit allocations ${g.depositAllocations.length}`);
  console.log(`  unlinked, kept: truck allocations ${g.truckAllocations.length}, expected payments ${g.expectedPayments.length}`);
}

async function main() {
  const orderId = Number(arg("order"));
  const ref = (arg("ref") || "").trim().toUpperCase();
  const staffId = Number(arg("staff"));
  const reason = arg("reason") || "Order deleted at the owner's request — its statement lines go back to the pool";
  if (!Number.isInteger(orderId) || orderId <= 0 || !ref || !Number.isInteger(staffId) || staffId <= 0) {
    console.error("Pass --order=<id> --ref=<reference> --staff=<staff id>, e.g. --order=12388 --ref=AS12388 --staff=1");
    process.exit(1);
  }

  console.log(`database: ${new URL(process.env.DATABASE_URL).hostname}\n`);

  const g = await gather(db, orderId);
  if (!g) {
    console.error(`No order ${orderId}.`);
    process.exit(1);
  }
  if (String(g.order.reference).toUpperCase() !== ref) {
    console.error(`Refusing: order ${orderId} reads ${g.order.reference}, not ${ref}.`);
    process.exit(1);
  }

  report(g);
  const shells = await gatherShells(db, g);
  reportShells(g, shells);

  const no = refusals(g);
  if (WITH_MERGED) {
    for (const s of shells) {
      const p = shellProblems(s, orderId);
      if (p.length) no.push(`merged order #${s.order.id} ${s.order.reference} is not empty: ${p.join(", ")}`);
    }
  }
  if (no.length) {
    console.error(`\nRefusing:\n  - ${no.join("\n  - ")}`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(__dirname, `backup-deleted-order-${orderId}-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify({ ...g, mergedOrders: shells }, null, 2));
  console.log(`\nbackup written: ${backup}`);

  const result = await db.transaction(async (tx) => {
    // Re-read under a row lock: a payment landing between the dry-run read and
    // here would otherwise be deleted without being looked at.
    await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
    const now = await gather(tx, orderId);
    if (now.payments.length !== g.payments.length || now.lines.length !== g.lines.length) {
      throw new Error("the order's payments changed while this was running — aborted, nothing written");
    }
    const stillNo = refusals(now);
    const shellIdsNow = shellIds(now);
    if (shellIdsNow.length) {
      await tx.execute(sql`SELECT id FROM orders WHERE id IN ${sql.raw(`(${shellIdsNow.join(",")})`)} FOR UPDATE`);
    }
    const nowShells = await gatherShells(tx, now);
    for (const s of nowShells) {
      const p = shellProblems(s, orderId);
      if (p.length) stillNo.push(`merged order #${s.order.id} is not empty: ${p.join(", ")}`);
    }
    if (shellIdsNow.join() !== shells.map((s) => s.order.id).join()) {
      stillNo.push("the orders merged into this one changed while this was running");
    }
    if (stillNo.length) throw new Error(`refused under lock: ${stillNo.join("; ")}`);

    // 1. Each payment off the order, its line back to the pool, one audit row each.
    for (const p of now.payments) {
      await orderPaymentService.removePayment({ paymentId: p.id, staffId, reason }, tx);
    }
    // A line can carry matched_order_id with no payment row (wallet-era match).
    const loose = await q(tx, sql`
      UPDATE bank_statement_lines
         SET status = 'UNMATCHED', matched_order_id = NULL, matched_deposit_id = NULL, matched_by = NULL, matched_at = NULL
       WHERE matched_order_id = ${orderId}
       RETURNING id`);

    // 2. The orders merged into this one (--with-merged only; refused above
    //    otherwise). Each is an empty husk, checked under lock; its merge record
    //    and its own pointer are what would block the delete below. The audit
    //    row keeps what it held before the merge, since the merge record goes.
    for (const s of nowShells) {
      const m = now.blockers.merges.find((r) => r.source_order_id === s.order.id);
      await auditLogRepo.record(
        {
          entityType: "order",
          entityId: s.order.id,
          action: "order.deleted",
          actor: { type: "staff", staffId },
          metadata: {
            orderNumber: s.order.order_number,
            reference: s.order.reference,
            status: s.order.status,
            totalAmount: String(s.order.total_amount),
            quantity: s.order.quantity,
            customerId: s.order.customer_id,
            customerName: s.order.customer_name,
            mergedIntoOrderId: orderId,
            mergedIntoReference: now.order.reference,
            mergeReason: m?.reason ?? null,
            mergedAt: m?.created_at ?? null,
            beforeMerge: m?.source_before ?? null,
            reason,
            via: "scripts/delete-order-unmatch-lines.js --with-merged",
          },
        },
        tx
      );
      await tx.execute(sql`DELETE FROM order_merges WHERE source_order_id = ${s.order.id}`);
      await tx.execute(sql`DELETE FROM orders WHERE id = ${s.order.id}`);
    }
    await tx.execute(sql`DELETE FROM order_merges WHERE target_order_id = ${orderId}`);

    // 3. The delete, as DELETE /orders/:id does it (order.controller deleteOrder).
    const o = now.order;
    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.deleted",
        actor: { type: "staff", staffId },
        metadata: {
          orderNumber: o.order_number,
          reference: o.reference,
          status: o.status,
          paymentStatus: o.payment_status,
          totalAmount: String(o.total_amount),
          quantity: o.quantity,
          customerId: o.customer_id,
          customerName: o.customer_name,
          pfiId: o.pfi_id,
          createdAt: o.created_at,
          reason,
          unmatchedLineIds: now.lines.map((l) => l.id),
          removedPaymentIds: now.payments.map((p) => p.id),
          via: "scripts/delete-order-unmatch-lines.js",
        },
      },
      tx
    );

    const allocations = await orderPfiAllocationRepo.findByOrderId(orderId, tx);
    for (const alloc of allocations) {
      await pfiRepo.releaseStock(alloc.pfiId, alloc.quantity, tx);
    }
    await walletService.releaseHold(orderId, tx);

    const counts = {};
    for (const table of ["tickets", "commissions", "wallet_holds"]) {
      counts[table] = (await q(tx, sql`DELETE FROM ${sql.identifier(table)} WHERE order_id = ${orderId} RETURNING id`)).length;
    }
    await tx.execute(sql`DELETE FROM orders WHERE id = ${orderId}`);

    // 4. Check before committing: the order and any merged husks gone, no merge
    //    record left naming them, every line back in the pool.
    const gone = [orderId, ...nowShells.map((s) => s.order.id)].join(",");
    const [left] = await q(tx, sql`SELECT count(*)::int AS n FROM orders WHERE id IN ${sql.raw(`(${gone})`)}`);
    const [mergesLeft] = await q(tx, sql`SELECT count(*)::int AS n FROM order_merges WHERE target_order_id IN ${sql.raw(`(${gone})`)} OR source_order_id IN ${sql.raw(`(${gone})`)}`);
    const ids = now.lines.map((l) => l.id);
    const stuck = ids.length
      ? await q(tx, sql`SELECT id, status FROM bank_statement_lines WHERE id IN ${sql.raw(`(${ids.join(",")})`)} AND (status <> 'UNMATCHED' OR matched_order_id IS NOT NULL)`)
      : [];
    if (left.n !== 0 || mergesLeft.n !== 0 || stuck.length) {
      throw new Error(`check failed — order rows ${left.n}, merge rows ${mergesLeft.n}, lines not unmatched ${stuck.map((s) => s.id).join(",") || "none"}; rolled back`);
    }

    return {
      payments: now.payments.length, lines: ids, loose: loose.map((l) => l.id), counts, releasedPfi: allocations.length,
      merged: nowShells.map((s) => s.order.reference),
    };
  });

  console.log(`\nDONE — ${ref} deleted.`);
  console.log(`  payments removed      ${result.payments}`);
  console.log(`  lines now UNMATCHED   ${result.lines.join(", ") || "none"}`);
  console.log(`  tickets ${result.counts.tickets}, commissions ${result.counts.commissions}, wallet holds ${result.counts.wallet_holds}, PFI allocations released ${result.releasedPfi}`);
  if (result.merged.length) console.log(`  merged orders deleted ${result.merged.join(", ")} (with their merge record)`);
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
