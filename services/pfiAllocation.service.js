/**
 * Allocating trucks off a cargo, and what approving that allocation makes.
 *
 * ── The flow ───────────────────────────────────────────────────────────────
 *
 *   raise     on a trading cargo: the trucks, what each carries, the day and
 *             the day's price. It takes the family's next letter at once —
 *             PFI/47C off PFI/47 — so everybody reading the request knows the
 *             name it will have. Nothing is deducted, ordered or written yet.
 *
 *   approve   an admin or super admin. In one act:
 *               1. an ORDER on the parent for the whole quantity at the day's
 *                  price, to the house trucking customer, with the trucks on
 *                  it as pending loads. It is an ordinary order from here —
 *                  finance records its payment, payment releases it, the
 *                  ticketing desk cuts its tickets, security gates the trucks
 *                  in and out. Placing it is what takes the litres off the
 *                  parent (reserveStock), the same way every sale does.
 *               2. the lettered trucking PFI, raised not_started and holding
 *                  exactly those litres, with the trucks parked on it as its
 *                  pending batch — so it goes to the same review every other
 *                  PFI does ("Start selling"), where its bank account and its
 *                  officers are named and its trucks reach the inventory.
 *
 *   reject    an admin or super admin, with a reason. The letter is free again.
 *   withdraw  whoever raised it, or an admin, while it is still pending.
 *
 * ── Why the order, and why the litres are not counted twice ────────────────
 *
 * PFI-14B, 19B and 24B were kept from ever having a PFI of their own because
 * their litres were still counted on the parent: a second PFI beside it would
 * have counted them twice. Here the parent SELLS them — its sold figure goes
 * up by the order — and the trucking PFI starts with what the parent no longer
 * has. The same litres are on one PFI's shelf at a time.
 */
const { db } = require("../config/db");
const { pfiRepo, depotRepo, orderRepo, auditLogRepo, pfiExpenseRepo } = require("../repositories");
const allocationRepo = require("../repositories/pfiAllocation.repository");
const { familyOf, memberName, allocationCodeFor, nextLetter, lettersUsed } = require("../lib/pfiFamily");
const { sellableQty } = require("../lib/pfiStock");
const { orderKey } = require("../lib/allocationOrders");
const { notify } = require("../notifications");
const { rolesFor } = require("../notifications/staffChoices");

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** What trucks may be allocated off. A batch of trucks is not a cargo. */
const ALLOCATABLE_TYPES = new Set(["coastal", "gantry", "delivery"]);

/** One tanker, the same ceiling order_trucks enforces. */
const MAX_LOAD = 60000;

const APPROVER_ROLES = ["admin", "super_admin"];
const isApprover = (user) => (user?.roles || []).some((r) => APPROVER_ROLES.includes(r));

const HOUSE_PURPOSE = "trucking";
const HOUSE_CUSTOMER = { name: "Soroman Trucking (internal)", companyName: "Soroman Trucking" };

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(new Date(v).getTime());

/**
 * Why this cargo cannot have trucks allocated off it, or null when it can.
 * Asked before a form is shown as well as when one is sent.
 */
function refusal(parent) {
  if (!parent) return "PFI not found";
  if (!ALLOCATABLE_TYPES.has(parent.pfiType)) return "Trucks are allocated off a cargo, not off a batch of trucks";
  if (parent.status !== "active") return `${parent.pfiNumber} is not trading, so nothing can be allocated off it`;
  if (!parent.locationId) return `${parent.pfiNumber} has no location, so there is nowhere to load the trucks`;
  if (!parent.productId) return `${parent.pfiNumber} has no product`;
  if (!familyOf(parent.pfiNumber)) {
    return `The serial could not be read from "${parent.pfiNumber}", so its trucks cannot be lettered — it should start "PFI/<number>"`;
  }
  return null;
}

/** The family's next letter and the names it gives, or null when B–Z are gone. */
async function nextMember(parent, tx = db) {
  const { serial } = familyOf(parent.pfiNumber);
  const [names, live] = await Promise.all([
    allocationRepo.namesThatHoldLetters(tx),
    allocationRepo.liveSuffixes(serial, tx),
  ]);
  const letter = nextLetter([...lettersUsed(serial, names), ...live]);
  if (!letter) return null;
  return {
    serial,
    letter,
    pfiNumber: memberName(parent.pfiNumber, letter),
    allocationCode: allocationCodeFor(serial, letter),
  };
}

/**
 * Everything the allocation form needs before anything is typed: whether it
 * may be raised at all, the name it will take, how much is left to allocate,
 * and the day's price to start from.
 */
async function preview(parentId) {
  const parent = await pfiRepo.findById(parentId);
  const problem = refusal(parent);
  if (!parent) throw httpError(404, "PFI not found");

  const pendingQty = await allocationRepo.pendingQuantity(parent.id);
  const available = Math.max(0, sellableQty(parent) - pendingQty);
  const next = problem ? null : await nextMember(parent);

  /**
   * The board price, when there is one. Every price goes to zero at 23:59
   * (services/priceReset.service.js), so a morning allocation often finds
   * none — which is an empty box to fill, not a price of ₦0.
   */
  let dayPrice = null;
  if (parent.locationId && parent.productId) {
    const entry = await depotRepo.getProductPrice(parent.locationId, parent.productId).catch(() => null);
    if (entry && Number(entry.currentPrice) > 0) dayPrice = Number(entry.currentPrice);
  }

  return {
    parent: {
      id: parent.id,
      pfiNumber: parent.pfiNumber,
      pfiType: parent.pfiType,
      status: parent.status,
      locationId: parent.locationId,
      locationName: parent.locationName || "",
      productId: parent.productId,
      productName: parent.productName || "",
      productUnit: parent.productUnit || "Litres",
    },
    problem: problem || (next ? null : "Every letter from B to Z is already used in this PFI's family"),
    next,
    sellable: sellableQty(parent),
    pendingQty,
    available,
    dayPrice,
  };
}

/**
 * The trucks as sent, checked and named from the fleet register.
 *
 * Plates and drivers come from the register, not the client, so the order's
 * loads and the trucking PFI's batch name the same vehicles.
 */
async function resolveTrucks(rawTrucks) {
  const list = Array.isArray(rawTrucks) ? rawTrucks : [];
  if (!list.length) throw httpError(400, "Pick at least one truck");

  const ids = list.map((t) => Number(t.truckId));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw httpError(400, "Every truck must be one from the fleet");
  if (new Set(ids).size !== ids.length) throw httpError(400, "A truck is listed twice");

  const fleet = new Map((await allocationRepo.fleetTrucksByIds(ids)).map((t) => [Number(t.id), t]));
  return list.map((t) => {
    const truck = fleet.get(Number(t.truckId));
    if (!truck) throw httpError(400, `Fleet truck ${t.truckId} was not found`);
    const qty = Number(t.loadedQty);
    // Whole units: the order's quantity is a whole number of litres, and a
    // batch that sums to a fraction could never be ordered exactly.
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, `Enter a whole quantity for ${truck.plateNumber}`);
    if (qty > MAX_LOAD) throw httpError(400, `${truck.plateNumber} is over one tanker (${MAX_LOAD.toLocaleString()})`);
    if (truck.maxCapacity && qty > Number(truck.maxCapacity)) {
      throw httpError(400, `${truck.plateNumber} holds ${Number(truck.maxCapacity).toLocaleString()}, not ${qty.toLocaleString()}`);
    }
    return {
      truckId: Number(truck.id),
      plateNumber: truck.plateNumber,
      driverName: truck.driverName || "",
      driverPhone: truck.driverPhone || "",
      loadedQty: qty,
    };
  });
}

async function raise({ parentId, loadingDate, price, trucks, note = "", user }) {
  const parent = await pfiRepo.findById(parentId);
  const problem = refusal(parent);
  if (problem) throw httpError(parent ? 409 : 404, problem);

  if (!isDay(loadingDate)) throw httpError(400, "Enter the day the trucks load");
  const unitPrice = Number(price);
  if (!(unitPrice > 0)) throw httpError(400, "Enter the day's price");

  const resolved = await resolveTrucks(trucks);
  const quantity = resolved.reduce((s, t) => s + t.loadedQty, 0);

  /**
   * Written in a transaction that takes the letter, so the check on what is
   * left and the letter it is given are one decision. The unique index on the
   * live letters is the backstop: two allocations raised in the same instant
   * collide there, and the loser is told to try again rather than both being
   * called 47C.
   */
  let created;
  try {
    created = await db.transaction(async (tx) => {
      const pendingQty = await allocationRepo.pendingQuantity(parent.id, tx);
      const available = sellableQty(parent) - pendingQty;
      if (quantity > available) {
        throw httpError(
          409,
          `${parent.pfiNumber} has ${Math.max(0, available).toLocaleString()} left to allocate` +
            (pendingQty ? ` (${pendingQty.toLocaleString()} is already waiting for approval)` : "") +
            `, not ${quantity.toLocaleString()}`,
        );
      }
      const next = await nextMember(parent, tx);
      if (!next) throw httpError(409, "Every letter from B to Z is already used in this PFI's family");

      const row = await allocationRepo.create({
        parentPfiId: parent.id,
        familySerial: next.serial,
        suffix: next.letter,
        pfiNumber: next.pfiNumber,
        allocationCode: next.allocationCode,
        depotId: parent.locationId,
        productId: parent.productId,
        pricePerUnit: String(unitPrice),
        quantity,
        trucks: resolved,
        loadingDate,
        note: String(note || "").trim(),
        status: "pending",
        raisedBy: user?.id ?? null,
        raisedByName: user?.name || user?.email || "",
      }, tx);

      await auditLogRepo.record({
        entityType: "pfi",
        entityId: parent.id,
        action: "pfi.trucks_allocation_raised",
        actor: { type: "staff", staffId: user?.id ?? null },
        metadata: {
          allocationId: row.id, pfiNumber: next.pfiNumber, quantity, price: unitPrice, trucks: resolved.length,
        },
      }, tx);
      return row;
    });
  } catch (err) {
    if (err?.code === "23505" || err?.cause?.code === "23505") {
      throw httpError(409, "Another allocation off this family took that letter at the same moment — send it again");
    }
    throw err;
  }

  const full = await allocationRepo.findById(created.id);
  try {
    notify("staff.pfi_allocation_raised", {
      to: { roles: rolesFor("pfi_allocations") },
      data: {
        allocationId: full.id,
        parentPfiId: parent.id,
        parentPfiNumber: parent.pfiNumber,
        pfiNumber: full.pfiNumber,
        quantity,
        unit: full.productUnit,
        trucks: resolved.length,
        raisedByName: full.raisedByName,
      },
    });
  } catch (err) {
    console.error("[pfiAllocation.raise] notify failed (allocation IS raised):", err.message);
  }
  return full;
}

/**
 * Approve: the order on the parent, then the trucking PFI.
 *
 * The allocation row is locked for the whole of it, so nothing can refuse or
 * withdraw it half-way. The order is placed by placeOrder in its own
 * transaction — the only path an order is ever made by — under a key derived
 * from this allocation. If anything after it fails, the allocation is still
 * pending and approving again finds that same order rather than placing a
 * second one.
 */
async function approve({ allocationId, user, note = "" }) {
  if (!isApprover(user)) throw httpError(403, "Only an admin or super admin can approve a truck allocation");
  // Required here rather than at the top: order.service requires half the app.
  const { placeOrder } = require("./order.service");

  const outcome = await db.transaction(async (tx) => {
    const locked = await allocationRepo.lockById(allocationId, tx);
    if (!locked) throw httpError(404, "Allocation not found");
    if (locked.status === "approved") return { already: true };
    if (locked.status !== "pending") throw httpError(409, `This allocation was ${locked.status}`);

    const parent = await pfiRepo.findById(locked.parentPfiId);
    const problem = refusal(parent);
    if (problem) throw httpError(409, problem);

    const clash = await pfiRepo.findByNumber(locked.pfiNumber);
    if (clash) {
      throw httpError(409, `${locked.pfiNumber} already exists. Reject this allocation and raise it again — it will take the next letter.`);
    }

    const depot = await depotRepo.findById(locked.depotId || parent.locationId);
    if (!depot) throw httpError(409, "The depot the trucks load at no longer exists");

    const house = await allocationRepo.ensureHouseCustomer(HOUSE_PURPOSE, HOUSE_CUSTOMER);
    const trucks = Array.isArray(locked.trucks) ? locked.trucks : [];
    const price = Number(locked.pricePerUnit);

    const { order } = await placeOrder({
      customerId: house.id,
      state: depot.state || depot.city || "",
      depotId: depot.id,
      productId: locked.productId || parent.productId,
      quantity: locked.quantity,
      deliveryType: "delivery",
      deliveryAddress: `Trucks for ${locked.pfiNumber}`,
      companyName: locked.pfiNumber,
      expectedTrucks: trucks.length,
      trucks: trucks.map((t) => ({
        truckId: t.truckId,
        truckNumber: t.plateNumber,
        quantity: t.loadedQty,
        driverName: t.driverName || null,
        driverPhone: t.driverPhone || null,
      })),
      actor: { type: "staff", staffId: user.id },
      idempotencyKey: orderKey(locked.id),
      pinned: { pfiId: parent.id, price },
      quiet: true,
    });

    const sub = await allocationRepo.insertPfi({
      pfiNumber: locked.pfiNumber,
      pfiType: "trucking",
      status: "not_started",
      parentPfiId: parent.id,
      description: `Trucks allocated from ${parent.pfiNumber}`,
      pfiDate: new Date(`${locked.loadingDate}T00:00:00Z`),
      collectionsOpenFrom: locked.loadingDate,
      locationId: parent.locationId,
      locationName: depot.name || parent.locationName || "",
      productId: parent.productId,
      productName: parent.productName || "",
      productUnit: parent.productUnit || "Litres",
      startingQtyLitres: locked.quantity,
      ticketCount: trucks.length,
      unitPrice: String(price),
      // Raised by whoever allocated the trucks, as if they had typed it on
      // the PFI form — the review that follows is somebody else's act.
      raisedBy: locked.raisedBy,
      raisedAt: locked.raisedAt,
      // The same shape the PFI form parks, so activation writes these trucks
      // to the inventory exactly as it writes any trucking batch's.
      pendingBatch: {
        code: locked.allocationCode,
        depotName: depot.name || "",
        productName: parent.productName || "",
        dateAllocated: locked.loadingDate,
        trucks: trucks.map((t) => ({ truckId: t.truckId, plateNumber: t.plateNumber, loadedQty: t.loadedQty })),
      },
      allocationCode: locked.allocationCode,
    }, tx);

    await allocationRepo.update(locked.id, {
      status: "approved",
      decidedBy: user.id,
      decidedByName: user.name || user.email || "",
      decidedAt: new Date(),
      decisionNote: String(note || "").trim(),
      orderId: order.id,
      subPfiId: sub.id,
    }, tx);

    const actor = { type: "staff", staffId: user.id };
    const metadata = {
      allocationId: locked.id, parentPfiId: parent.id, parentPfiNumber: parent.pfiNumber,
      pfiNumber: sub.pfiNumber, subPfiId: sub.id, orderId: order.id,
      quantity: locked.quantity, price, trucks: trucks.length,
    };
    await auditLogRepo.record({ entityType: "pfi", entityId: parent.id, action: "pfi.trucks_allocation_approved", actor, metadata }, tx);
    await auditLogRepo.record({ entityType: "pfi", entityId: sub.id, action: "pfi.raised_from_allocation", actor, metadata }, tx);
    await auditLogRepo.record({ entityType: "order", entityId: order.id, action: "order.placed_for_allocation", actor, metadata }, tx);

    return { sub, raisedBy: locked.raisedBy, pfiNumber: sub.pfiNumber };
  });

  if (!outcome.already) {
    // Every PFI is an expense category the moment it exists (see createPfi).
    await pfiExpenseRepo.ensureCategoryForPfi(outcome.sub.id, outcome.sub.pfiNumber).catch((err) =>
      console.error("[pfiAllocation.approve] expense category failed (PFI IS raised):", err.message));
    decided(allocationId, "approved");
  }
  return allocationRepo.findById(allocationId);
}

async function reject({ allocationId, user, note }) {
  if (!isApprover(user)) throw httpError(403, "Only an admin or super admin can reject a truck allocation");
  const reason = String(note || "").trim();
  if (!reason) throw httpError(400, "Say why it is rejected");
  await close(allocationId, "rejected", user, reason);
  decided(allocationId, "rejected");
  return allocationRepo.findById(allocationId);
}

async function withdraw({ allocationId, user, note = "" }) {
  const current = await allocationRepo.findById(allocationId);
  if (!current) throw httpError(404, "Allocation not found");
  if (Number(current.raisedBy) !== Number(user?.id) && !isApprover(user)) {
    throw httpError(403, "Only whoever raised it, or an admin, can withdraw it");
  }
  await close(allocationId, "withdrawn", user, String(note || "").trim());
  return allocationRepo.findById(allocationId);
}

/** Refuse or withdraw — the two ways a request ends without making anything. */
async function close(allocationId, status, user, note) {
  await db.transaction(async (tx) => {
    const locked = await allocationRepo.lockById(allocationId, tx);
    if (!locked) throw httpError(404, "Allocation not found");
    if (locked.status !== "pending") throw httpError(409, `This allocation was already ${locked.status}`);
    // An approval that placed its order and then failed leaves the request
    // pending with a real order behind it. Closing it would strand that order.
    const placed = await orderRepo.findByIdempotencyKey(orderKey(locked.id), tx);
    if (placed) {
      throw httpError(409, `Order ${placed.orderNumber} was already placed for this allocation — approve it again to finish.`);
    }
    await allocationRepo.update(locked.id, {
      status,
      decidedBy: user?.id ?? null,
      decidedByName: user?.name || user?.email || "",
      decidedAt: new Date(),
      decisionNote: note,
    }, tx);
    await auditLogRepo.record({
      entityType: "pfi",
      entityId: locked.parentPfiId,
      action: `pfi.trucks_allocation_${status}`,
      actor: { type: "staff", staffId: user?.id ?? null },
      metadata: { allocationId: locked.id, pfiNumber: locked.pfiNumber, note },
    }, tx);
  });
}

/** Tell whoever raised it. Never throws: the decision is already committed. */
async function decided(allocationId, outcome) {
  try {
    const a = await allocationRepo.findById(allocationId);
    if (!a?.raisedBy) return;
    notify("staff.pfi_allocation_decided", {
      to: { staffId: a.raisedBy },
      data: {
        allocationId: a.id,
        outcome,
        pfiNumber: a.pfiNumber,
        parentPfiNumber: a.parentPfiNumber,
        subPfiId: a.subPfiId,
        parentPfiId: a.parentPfiId,
        decidedByName: a.decidedByName,
        note: a.decisionNote,
      },
    });
  } catch (err) {
    console.error("[pfiAllocation] decision notify failed:", err.message);
  }
}

/**
 * The allocations screen for one PFI: its own allocations if it is a cargo,
 * the one that made it if it is a trucking PFI, and the form's preview.
 */
async function forPfi(pfiId) {
  const pfi = await pfiRepo.findById(pfiId);
  if (!pfi) throw httpError(404, "PFI not found");
  const [allocations, madeBy] = await Promise.all([
    allocationRepo.listForParent(pfi.id),
    allocationRepo.findBySubPfi(pfi.id),
  ]);
  const form = ALLOCATABLE_TYPES.has(pfi.pfiType) ? await preview(pfi.id) : null;
  return { allocations, madeBy, form };
}

const list = ({ status, scopeUser }) => allocationRepo.listByStatus({ status, scopeUser });

module.exports = {
  preview,
  raise,
  approve,
  reject,
  withdraw,
  forPfi,
  list,
  isApprover,
  // For tests.
  HOUSE_PURPOSE,
  orderKey,
};
