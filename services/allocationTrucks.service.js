/**
 * A trucking PFI made by an allocation, kept in step with its trucks.
 *
 * Approving an allocation makes two records out of one decision: the order on
 * the parent cargo (services/pfiAllocation.service.js), which is what the
 * orders list, the parent's sold figure and the finance report read, and the
 * lettered trucking PFI, whose trucks sit on the delivery inventory. Trucks
 * added to PFI-47D afterwards went onto the inventory alone — 13 trucks and
 * 635,000 L on 9 October 2026 — so 47D's own quantity, its order on PFI/47,
 * PFI/47's stock and the allocation all went on saying 925,000 L over 19.
 *
 * So the trucks decide, and everything else follows in the same transaction
 * as the write that changed them:
 *
 *   order        quantity, value (quantity × its rate), truck count, and the
 *                credit allowance when the whole order was on credit. A new
 *                truck becomes a pending load, which is what the loading desk
 *                tickets and the gate signs in and out.
 *   parent       the extra litres come off what it has left — refused when it
 *                does not have them — and litres taken off go back.
 *   trucking PFI its quantity, sold figure and truck count.
 *   allocation   its quantity and trucks.
 *
 * ── Compared truck by truck, not row by row ───────────────────────────────
 *
 * A truck's inventory rows and its loads on the order are summed per plate and
 * compared. Rows and loads need not pair one to one — PFI-47C's order carries
 * 34 loads for its 33 trucks, one load split in two at the desk — and a
 * per-truck sum is the same either way.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * Change a load the desk has already ticketed: its ticket names the truck and
 * the litres. Only pending loads grow, shrink or go.
 *
 * Add to an order that is over — Completed, Cancelled, Expired. Its trucks
 * have all left the depot; more trucks off that cargo are a new allocation.
 * Other edits on such a batch are left alone, as they always were.
 *
 * Touch a station's allocation. It has no trucks and no desk, and its order
 * completed on the day it was approved.
 */
const { and, eq, or, asc, inArray, isNotNull, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfis, pfiTruckAllocations, deliveryInventory, orderTrucks } = require("../db/schema");
const { orderRepo, pfiRepo, orderTruckRepo, orderPfiAllocationRepo, auditLogRepo } = require("../repositories");
const allocationRepo = require("../repositories/pfiAllocation.repository");
const orderPaymentService = require("./orderPayment.service");
const { codeOf } = require("../lib/batchPfi");

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** One tanker, the same ceiling order_trucks enforces. */
const MAX_LOAD = 60000;

/** Statuses an order still loads in. Past these its trucks have all left. */
const OPEN = new Set(["Pending", "Paid", "Released", "Loading"]);

/** A plate as both tables might spell it: "BWR 801-XB" and "BWR801XB" are one truck. */
const plateKey = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const truckKey = (plate, truckId) => plateKey(plate) || (truckId != null ? `#${truckId}` : "");

const fmt = (n) => Number(n).toLocaleString("en-NG");

/** quantity_allocated is a float column; the order counts whole litres. */
const litres = (v) => Math.round(Number(v) || 0);

const stationOf = (trucks) => (Array.isArray(trucks) ? trucks : []).find((t) => t?.customerId != null) || null;

/**
 * The trucking PFIs among these ids that an allocation made — the only ones
 * whose trucks have an order to keep in step. Asked before a write, so an
 * ordinary batch's writes go on exactly as they did.
 */
async function allocationPfis(pfiIds, tx = db) {
  const ids = [...new Set(pfiIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const rows = await tx
    .select({ subPfiId: pfiTruckAllocations.subPfiId })
    .from(pfiTruckAllocations)
    .where(and(
      eq(pfiTruckAllocations.status, "approved"),
      inArray(pfiTruckAllocations.subPfiId, ids),
      isNotNull(pfiTruckAllocations.orderId),
    ));
  return rows.map((r) => Number(r.subPfiId));
}

/**
 * Bring one allocation's order, parent, trucking PFI and record into line with
 * the trucking PFI's trucks. Runs inside the caller's transaction, after the
 * caller's write, so a refusal here undoes that write too.
 *
 * `adding` says the write put trucks or litres onto the batch. It is what
 * decides between refusing and standing aside when the order is already over.
 *
 * Returns what changed, or null when nothing did.
 */
async function syncFromTrucks(subPfiId, { tx, actor, adding = false }) {
  // The trucking PFI first, locked: two trucks added at once must not both
  // read the order before either has resized it.
  const [sub] = await tx.select().from(pfis).where(eq(pfis.id, Number(subPfiId))).for("update").limit(1);
  if (!sub || sub.status === "not_started") return null;

  const [alloc] = await tx
    .select()
    .from(pfiTruckAllocations)
    .where(and(eq(pfiTruckAllocations.subPfiId, sub.id), eq(pfiTruckAllocations.status, "approved")))
    .for("update")
    .limit(1);
  if (!alloc?.orderId || stationOf(alloc.trucks)) return null;

  const order = await orderRepo.lockById(alloc.orderId, tx);
  if (!order) return null;

  // ── The trucks, and the loads they should match ──────────────────────
  const code = codeOf(sub.allocationCode);
  const rows = await tx
    .select({
      id: deliveryInventory.id,
      truckId: deliveryInventory.truckId,
      truckNumber: deliveryInventory.truckNumber,
      driverName: deliveryInventory.driverName,
      quantity: deliveryInventory.quantityAllocated,
    })
    .from(deliveryInventory)
    .where(or(
      eq(deliveryInventory.pfiId, sub.id),
      code ? sql`upper(trim(${deliveryInventory.allocationCode})) = ${code}` : sql`false`,
    ))
    .orderBy(asc(deliveryInventory.id));
  const loads = await orderTruckRepo.findByOrder(order.id, tx);

  const trucks = new Map(); // key → { plate, truckId, driverName, inv, loads: [] }
  const entry = (key, plate, truckId) => {
    if (!trucks.has(key)) trucks.set(key, { plate, truckId, driverName: null, inv: 0, loads: [] });
    return trucks.get(key);
  };
  for (const r of rows) {
    const t = entry(truckKey(r.truckNumber, r.truckId), r.truckNumber, r.truckId);
    t.inv += litres(r.quantity);
    if (t.truckId == null && r.truckId != null) t.truckId = r.truckId;
    if (!t.driverName && r.driverName) t.driverName = r.driverName;
  }
  for (const l of loads) entry(truckKey(l.truckNumber, l.truckId), l.truckNumber, l.truckId).loads.push(l);

  const total = rows.reduce((s, r) => s + litres(r.quantity), 0);
  const plan = [];
  for (const t of trucks.values()) {
    const onOrder = t.loads.reduce((s, l) => s + Number(l.quantity), 0);
    if (t.inv !== onOrder) plan.push({ ...t, onOrder, diff: t.inv - onOrder });
  }

  const sameShape =
    !plan.length &&
    Number(order.quantity) === total &&
    Number(order.expectedTrucks ?? 0) === rows.length &&
    Number(sub.startingQtyLitres) === total &&
    Number(sub.ticketCount ?? 0) === rows.length;
  if (sameShape) return null;

  if (!OPEN.has(order.status)) {
    if (!adding) return null;
    throw httpError(
      409,
      `${sub.pfiNumber}'s order ${order.orderNumber} is ${order.status.toLowerCase()} — its trucks have all left. ` +
        `Raise a new allocation for more trucks.`,
    );
  }
  if (total <= 0) {
    throw httpError(409, `${sub.pfiNumber} must keep at least one truck. To undo the allocation, delete the PFI.`);
  }

  // ── The loads ────────────────────────────────────────────────────────
  // Taken off first, so a truck that loses litres can never be refused for a
  // ceiling it only crossed on the way.
  const added = [];
  const removed = [];
  const resized = [];
  for (const t of plan.filter((p) => p.diff < 0)) {
    let over = -t.diff;
    // The newest pending load gives first; a ticketed load gives nothing.
    for (const l of [...t.loads].reverse()) {
      if (over <= 0) break;
      if (l.status !== "pending") continue;
      const qty = Number(l.quantity);
      if (qty <= over) {
        await tx.delete(orderTrucks).where(eq(orderTrucks.id, l.id));
        removed.push({ truckNumber: l.truckNumber, quantity: qty });
        over -= qty;
      } else {
        await orderTruckRepo.update(l.id, { quantity: String(qty - over) }, tx);
        resized.push({ truckNumber: l.truckNumber, from: qty, to: qty - over });
        over = 0;
      }
    }
    if (over > 0) {
      throw httpError(
        409,
        `${t.plate || "A truck"} has already been ticketed on ${order.orderNumber} for ${fmt(t.onOrder)} — ` +
          `those litres can no longer come off ${sub.pfiNumber}.`,
      );
    }
  }

  const growing = plan.filter((p) => p.diff > 0);
  let nextIndex = loads.reduce((m, l) => Math.max(m, Number(l.truckIndex) || 0), 0) + 1;
  const fleet = new Map(
    (await allocationRepo.fleetTrucksByIds(growing.map((t) => Number(t.truckId)).filter(Boolean)))
      .map((f) => [Number(f.id), f]),
  );
  for (const t of growing) {
    let more = t.diff;
    // A pending load on the same truck grows before a second one is made.
    const pending = t.loads.find((l) => l.status === "pending" && Number(l.quantity) + more <= MAX_LOAD);
    if (pending) {
      const from = Number(pending.quantity);
      await orderTruckRepo.update(pending.id, { quantity: String(from + more) }, tx);
      resized.push({ truckNumber: pending.truckNumber, from, to: from + more });
      continue;
    }
    if (more > MAX_LOAD) {
      throw httpError(400, `${t.plate || "A truck"} is over one tanker (${fmt(MAX_LOAD)}).`);
    }
    const f = fleet.get(Number(t.truckId));
    const load = await orderTruckRepo.create({
      orderId: order.id,
      truckIndex: nextIndex++,
      truckId: t.truckId != null ? Number(t.truckId) : null,
      truckNumber: t.plate || f?.plateNumber || null,
      quantity: String(more),
      driverName: t.driverName || f?.driverName || null,
      driverPhone: f?.driverPhone || null,
      status: "pending",
    }, tx);
    await auditLogRepo.record({
      entityType: "order_truck",
      entityId: load.id,
      action: "order_truck.allocated",
      actor,
      metadata: { orderId: order.id, truckIndex: load.truckIndex, truckNumber: load.truckNumber, quantity: String(more), via: "trucking-pfi" },
    }, tx);
    added.push({ truckNumber: load.truckNumber, quantity: more });
  }

  // ── The parent's stock ───────────────────────────────────────────────
  const delta = total - Number(order.quantity);
  if (order.pfiId && delta !== 0) {
    if (delta > 0) {
      const reserved = await pfiRepo.reserveStock(order.pfiId, delta, tx);
      if (!reserved) {
        const [parent] = await tx.select().from(pfis).where(eq(pfis.id, order.pfiId)).limit(1);
        const left = parent
          ? Number(parent.startingQtyLitres) + Number(parent.evacuationSurplusLitres || 0)
            - Number(parent.operationalLossLitres || 0) - Number(parent.soldQtyLitres)
          : 0;
        throw httpError(
          409,
          `${parent?.pfiNumber || "The parent PFI"} has ${fmt(Math.max(left, 0))} left, not the ${fmt(delta)} these trucks need` +
            (parent && parent.status !== "active" ? ` (it is ${parent.status})` : "") + ".",
        );
      }
      await pfiRepo.markFinishedIfComplete(order.pfiId, tx);
    } else {
      await pfiRepo.releaseStock(order.pfiId, -delta, tx);
    }
    await orderPfiAllocationRepo.deleteByOrderId(order.id, tx);
    await orderPfiAllocationRepo.create([{ pfiId: order.pfiId, quantity: total }], order.id, tx);
  }

  // ── The order ────────────────────────────────────────────────────────
  const set = {};
  const changes = {};
  const change = (field, from, to) => {
    if (String(from ?? "") === String(to ?? "")) return;
    changes[field] = [from, to];
    set[field] = to;
  };
  change("quantity", order.quantity, total);
  change("expectedTrucks", order.expectedTrucks, rows.length);
  if (order.pricingStatus !== "pending") {
    change("totalAmount", order.totalAmount, (Number(order.price) * total).toFixed(2));
  }
  // Wholly on credit stays wholly on credit. An allocation that was paid for
  // keeps its allowance, and its new litres wait for payment like any order's.
  if (Number(order.creditQty ?? 0) >= Number(order.quantity)) {
    change("creditQty", order.creditQty, total.toFixed(2));
  }
  if (Object.keys(set).length) await orderRepo.update(order.id, set, tx);
  if (set.totalAmount !== undefined) {
    const payment = await orderPaymentService.recomputeOrder(order.id, tx);
    if (payment.paymentStatus !== order.paymentStatus) {
      changes.paymentStatus = [order.paymentStatus, payment.paymentStatus];
    }
  }

  // ── The trucking PFI and its allocation ─────────────────────────────
  const subDelta = total - Number(sub.startingQtyLitres);
  await tx
    .update(pfis)
    .set({
      startingQtyLitres: total,
      soldQtyLitres: sql`GREATEST(${pfis.soldQtyLitres} + ${subDelta}, 0)`,
      ticketCount: rows.length,
      updatedAt: new Date(),
    })
    .where(eq(pfis.id, sub.id));

  const before = new Map((Array.isArray(alloc.trucks) ? alloc.trucks : []).map((t) => [truckKey(t.plateNumber, t.truckId), t]));
  await allocationRepo.update(alloc.id, {
    quantity: total,
    trucks: rows.map((r) => {
      const was = before.get(truckKey(r.truckNumber, r.truckId)) || {};
      return {
        truckId: r.truckId != null ? Number(r.truckId) : null,
        plateNumber: r.truckNumber || was.plateNumber || "",
        driverName: was.driverName || r.driverName || "",
        driverPhone: was.driverPhone || "",
        loadedQty: litres(r.quantity),
      };
    }),
  }, tx);

  const metadata = {
    via: "trucking-pfi-trucks",
    allocationId: alloc.id,
    subPfiId: sub.id,
    pfiNumber: sub.pfiNumber,
    parentPfiId: order.pfiId,
    quantity: [Number(order.quantity), total],
    trucks: [Number(sub.ticketCount ?? 0), rows.length],
    added, removed, resized,
  };
  await auditLogRepo.record({ entityType: "order", entityId: order.id, action: "order.updated", actor, metadata: { ...metadata, changes } }, tx);
  await auditLogRepo.record({ entityType: "pfi", entityId: sub.id, action: "pfi.allocation_trucks_changed", actor, metadata }, tx);

  return { orderId: order.id, orderNumber: order.orderNumber, pfiNumber: sub.pfiNumber, changes, added, removed, resized };
}

/**
 * Run an inventory write, then keep any allocation it touched in step — one
 * transaction, so a refused sync leaves the write unmade.
 *
 * `pfiIds` are every PFI the write could have touched, before and after. When
 * none of them came from an allocation the write runs exactly as it did.
 */
async function writeInStep({ pfiIds, actor, adding = false }, write) {
  const subs = await allocationPfis(pfiIds);
  if (!subs.length) return write(db);
  return db.transaction(async (tx) => {
    const result = await write(tx);
    for (const id of subs) await syncFromTrucks(id, { tx, actor, adding });
    return result;
  });
}

module.exports = { syncFromTrucks, writeInStep, allocationPfis };
