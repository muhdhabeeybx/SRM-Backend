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
 *                  it as pending loads — placed ON CREDIT, authorised by the
 *                  approver: the company selling to itself is not paid for
 *                  like a customer's order. It is born Released, so the
 *                  ticketing desk cuts its tickets at once and security gates
 *                  the trucks in and out; off a PFI with no loading desk it
 *                  completes there and then. Placing it is what takes the
 *                  litres off the parent (reserveStock), the same way every
 *                  sale does.
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
 *
 * ── To a station, with no trucks ───────────────────────────────────────────
 *
 * Off a batch with no loading desk (gantry, delivery) litres can instead go
 * straight to one of our own stations or plants: the station and how much,
 * nothing else. Dangote loads it, so there is no fleet truck to name and no
 * Soroman desk that would ever see one. The allocation then carries ONE load,
 * named DANGOTE DELIVERY wherever a truck, a driver or a company is asked for,
 * already assigned to the station. Everything else is the same request:
 * approval places the order on the parent and raises the lettered PFI, and
 * "Start selling" writes the load to the inventory and the sales ledger under
 * that PFI's code, assigned to the station (repositories/pfi.repository.js).
 *
 * ── An order already placed ────────────────────────────────────────────────
 *
 * The company sometimes buys off a cargo the ordinary way first — an order
 * placed on the desk like a customer's (ST12632, "SOROMAN TRUCKS", 765,000 L
 * on PFI 53, 26 Oct 2026) — and only then names the trucks. The request can
 * name that order instead of a price: the trucks must carry exactly its
 * litres, and its rate is the trucking PFI's cost. Nothing is asked of the
 * cargo's stock, since the order took it when it was placed. While the request
 * waits, the order does not lapse.
 *
 * Approval then makes that order the allocation's (linkOrder) rather than
 * placing one: it moves to the SOROMAN TRUCKING house account with the
 * allocation's company name, takes the allocation's key — so every rule for
 * an allocation's order holds for it from then on — and gets the trucks as its
 * loads (allocationTrucks.syncFromTrucks). Its payment is left as it was: it
 * waits for its money like any order, and is not put on credit (the user,
 * 2026-10-26). Orders on the audited finance report are never linked.
 */
const { db } = require("../config/db");
const { pfiRepo, depotRepo, orderRepo, auditLogRepo, pfiExpenseRepo } = require("../repositories");
const allocationRepo = require("../repositories/pfiAllocation.repository");
const { familyOf, memberName, allocationCodeFor, nextLetter, lettersUsed } = require("../lib/pfiFamily");
const { sellableQty } = require("../lib/pfiStock");
const { isStationType } = require("../lib/customerTypes");
const { orderKey, isAllocationOrder } = require("../lib/allocationOrders");
const { generateOrderReference } = require("../utils/helpers");
const { notify } = require("../notifications");
const { rolesFor } = require("../notifications/staffChoices");

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** What trucks may be allocated off. A batch of trucks is not a cargo. */
const ALLOCATABLE_TYPES = new Set(["coastal", "gantry", "delivery"]);

/** One tanker, the same ceiling order_trucks enforces. */
const MAX_LOAD = 60000;

/**
 * Where litres may go to a station with no truck named: off a batch nobody
 * loads at a Soroman desk. A coastal cargo is loaded by the ticketing desk
 * onto real trucks, which an allocation of no trucks would leave it unable to.
 */
const STATION_PARENT_TYPES = new Set(["gantry", "delivery"]);

/** What a station's load is called where a truck, a driver or a company is asked for. */
const STATION_LOAD = { plateNumber: "DANGOTE DELIVERY", name: "Dangote Delivery" };

/** The station an allocation's litres go to, or null when it is a list of trucks. */
const stationOf = (trucks) => (Array.isArray(trucks) ? trucks : []).find((t) => t?.customerId != null) || null;

const APPROVER_ROLES = ["admin", "super_admin"];
const isApprover = (user) => (user?.roles || []).some((r) => APPROVER_ROLES.includes(r));

/**
 * The account allocation orders are placed on. Orders approved from 20 Oct
 * 2026 read SOROMAN TRUCKING; the ones before stay on the first house account
 * ('trucking', "Soroman Trucking (internal)") exactly as they were placed.
 */
const HOUSE_PURPOSE = "soroman_trucking";
const HOUSE_CUSTOMER = { name: "SOROMAN TRUCKING", companyName: "SOROMAN NIGERIA LIMITED", phone: "SOROMAN TRUCKING" };

/** A truck allocation order's company: "SOROMAN NIGERIA LIMITED (PFI 47D)". */
const allocationCompany = (pfiNumber) => {
  const fam = familyOf(pfiNumber);
  return `${HOUSE_CUSTOMER.companyName} (${fam ? `PFI ${fam.serial}${fam.letter}` : pfiNumber})`;
};

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(new Date(v).getTime());

const fmt = (n) => Number(n).toLocaleString("en-NG", { maximumFractionDigits: 3 });

/**
 * Why this order cannot become a trucking PFI's, or null when it can. `o` is
 * a row from allocationRepo.ordersToLink. At approval the request's own
 * pending link is not a reason (`allocationId`).
 */
function linkProblem(o, parent, { allocationId = null } = {}) {
  if (!o) return "Order not found";
  const ref = o.reference;
  if (o.pfiId !== Number(parent.id)) return `${ref} is not on ${parent.pfiNumber}`;
  if (["Cancelled", "Expired"].includes(o.status)) return `${ref} was ${o.status.toLowerCase()}`;
  if (isAllocationOrder(o)) return `${ref} is already a trucking PFI's order`;
  if (o.placedOn <= allocationRepo.AUDITED_THROUGH) {
    return `${ref} is on the audited finance report (orders up to 10 Sep 2026), so it cannot move to ${HOUSE_CUSTOMER.name}`;
  }
  if (o.pricingStatus === "pending") return `${ref} has no agreed price yet`;
  if (!Number.isInteger(o.quantity)) return `${ref} is for ${fmt(o.quantity)}, and trucks are loaded in whole units`;
  if (o.pendingLinkId != null && o.pendingLinkId !== Number(allocationId)) {
    return `${ref} is already waiting to become ${o.pendingLink}'s order`;
  }
  if (o.loadsTicketed > 0 && o.status !== "Completed") {
    return `${ref} has trucks ticketed already. Link it before its trucks are ticketed, or once it has completed.`;
  }
  if (o.commissionPaid) return `${ref}'s commission has been paid out, so it cannot move to ${HOUSE_CUSTOMER.name}`;
  if (o.refundOpen) return `${ref} has a refund waiting. Settle the refund first.`;
  return null;
}

/** An order on the cargo as the form offers it: what it is, and whether it may be linked. */
const linkChoice = (o, parent, next) => ({
  id: o.id,
  reference: o.reference,
  placedOn: o.placedOn,
  status: o.status,
  paymentStatus: o.paymentStatus,
  quantity: o.quantity,
  price: o.price,
  totalAmount: o.totalAmount,
  amountPaid: o.amountPaid,
  customerName: o.customerName || "",
  companyName: o.companyName || "",
  loads: o.loads,
  problem: linkProblem(o, parent),
  /** The reference it reads by once linked: the initials follow the company name. */
  referenceAfter: next ? generateOrderReference(allocationCompany(next.pfiNumber), o.id) : null,
});

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

  const stationAllowed = !problem && STATION_PARENT_TYPES.has(parent.pfiType);
  const orders = problem || !next ? [] : await allocationRepo.ordersToLink({ pfiId: parent.id });

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
    stationAllowed,
    stations: stationAllowed ? await allocationRepo.activeStations() : [],
    /** Orders already on the cargo that trucks could be linked to instead of a new order. */
    orders: orders.map((o) => linkChoice(o, parent, next)),
    houseName: HOUSE_CUSTOMER.name,
    houseCompany: next ? allocationCompany(next.pfiNumber) : null,
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

/**
 * A station's litres as the one load the allocation carries: no fleet truck,
 * DANGOTE DELIVERY for its plate and driver, and the station it is assigned to.
 */
async function resolveStation(raw) {
  const customerId = Number(raw?.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) throw httpError(400, "Pick the station");
  const station = await allocationRepo.stationById(customerId);
  if (!station || !isStationType(station.customerType)) throw httpError(400, "That is not one of our stations or plants");
  if (station.status !== "active") throw httpError(400, `${station.name} is not active`);
  const qty = Number(raw?.quantity);
  // Whole units, for the same reason as a truck's: the order is.
  if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, `Enter a whole quantity for ${station.name}`);
  return [{
    truckId: null,
    plateNumber: STATION_LOAD.plateNumber,
    driverName: STATION_LOAD.name,
    driverPhone: "",
    loadedQty: qty,
    customerId: station.id,
    customerName: station.name,
  }];
}

async function raise({ parentId, loadingDate, price, trucks, station, orderId = null, note = "", user }) {
  const parent = await pfiRepo.findById(parentId);
  const problem = refusal(parent);
  if (problem) throw httpError(parent ? 409 : 404, problem);
  if (station && !STATION_PARENT_TYPES.has(parent.pfiType)) {
    throw httpError(409, `${parent.pfiNumber} is loaded by the ticketing desk, so allocate the trucks that carry it`);
  }
  if (station && orderId != null) throw httpError(400, "An order already placed is linked to trucks, not to a station");

  /** The order already placed that these trucks carry, when one is named. */
  let linked = null;
  if (orderId != null) {
    [linked] = await allocationRepo.ordersToLink({ orderId });
    const why = linkProblem(linked, parent);
    if (why) throw httpError(linked ? 409 : 404, why);
  }

  if (!isDay(loadingDate)) throw httpError(400, station ? "Enter the day it loaded" : "Enter the day the trucks load");
  // A linked order's rate is the trucking PFI's cost; nothing is typed.
  const unitPrice = linked ? linked.price : Number(price);
  if (!(unitPrice > 0)) throw httpError(400, linked ? `${linked.reference} has no price` : "Enter the day's price");

  const resolved = station ? await resolveStation(station) : await resolveTrucks(trucks);
  const quantity = resolved.reduce((s, t) => s + t.loadedQty, 0);
  if (linked && quantity !== linked.quantity) {
    throw httpError(
      400,
      `The trucks carry ${fmt(quantity)} and ${linked.reference} is for ${fmt(linked.quantity)}. They must be the same.`,
    );
  }

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
      if (linked) {
        // Locked, so two requests naming the same order cannot both be raised.
        await orderRepo.lockById(linked.id, tx);
        const held = await allocationRepo.pendingLinkForOrder(linked.id, tx);
        if (held) throw httpError(409, `${linked.reference} is already waiting to become ${held.pfiNumber}'s order`);
      }
      const pendingQty = await allocationRepo.pendingQuantity(parent.id, tx);
      const available = sellableQty(parent) - pendingQty;
      // A linked order's litres already left the cargo when it was placed.
      if (!linked && quantity > available) {
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
        // Set while pending only on a link: the order approval will make the
        // allocation's (see pendingQuantity, pendingLinkForOrder).
        orderId: linked ? linked.id : null,
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
          ...(station ? { stationId: resolved[0].customerId, stationName: resolved[0].customerName } : {}),
          ...(linked ? { orderId: linked.id, orderReference: linked.reference } : {}),
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
    // "PFI 38B" off "PFI 38": the full names run long in a text.
    const fam = familyOf(full.pfiNumber);
    // Never to the one who raised it, on the bell or by text.
    const except = user?.id ? [user.id] : [];
    const data = {
      allocationId: full.id,
      parentPfiId: parent.id,
      parentPfiNumber: parent.pfiNumber,
      pfiNumber: full.pfiNumber,
      pfiShort: fam ? `PFI ${fam.serial}${fam.letter}` : full.pfiNumber,
      parentShort: fam ? `PFI ${fam.serial}` : parent.pfiNumber,
      quantity,
      unit: full.productUnit,
      trucks: resolved.length,
      value: quantity * unitPrice,
      ...(station ? { stationName: resolved[0].customerName } : {}),
      ...(linked ? { orderReference: linked.reference } : {}),
      raisedByName: full.raisedByName,
    };
    // The bell to every approver; the text to whoever is ticked for it.
    notify("staff.pfi_allocation_raised", { to: { roles: rolesFor("pfi_allocations"), exceptStaffIds: except }, data });
    notify("staff.pfi_allocation_raised_sms", { to: { roles: rolesFor("pfi_allocations_text"), exceptStaffIds: except }, data });
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
    const station = stationOf(trucks);

    // An order already on the cargo becomes the allocation's; otherwise one is placed.
    const linking = locked.orderId != null;
    const { order } = linking ? { order: await linkOrder({ tx, locked, parent, house, user }) } : await placeOrder({
      customerId: house.id,
      state: depot.state || depot.city || "",
      depotId: depot.id,
      productId: locked.productId || parent.productId,
      quantity: locked.quantity,
      deliveryType: "delivery",
      deliveryAddress: station ? `${station.customerName} — ${locked.pfiNumber}` : `Trucks for ${locked.pfiNumber}`,
      companyName: station ? STATION_LOAD.name : allocationCompany(locked.pfiNumber),
      // A station's litres name no truck. The parent has no loading desk, so
      // the order completes on payment and never waits for one.
      expectedTrucks: station ? null : trucks.length,
      trucks: station ? [] : trucks.map((t) => ({
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
      // Never waits for payment: released to ticketing now (or completed, off
      // a PFI with no desk), on credit the approver gives by approving.
      onCredit: { reason: `Truck allocation ${locked.pfiNumber} off ${parent.pfiNumber}` },
    });

    const sub = await allocationRepo.insertPfi({
      pfiNumber: locked.pfiNumber,
      pfiType: "trucking",
      status: "not_started",
      parentPfiId: parent.id,
      description: station
        ? `Allocated to ${station.customerName} from ${parent.pfiNumber}`
        : linking
          ? `Trucks for order ${generateOrderReference(order.companyName, order.id)} off ${parent.pfiNumber}`
          : `Trucks allocated from ${parent.pfiNumber}`,
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
        // A station's load keeps its station, so activation writes it
        // already assigned — on the inventory and the sales ledger both.
        trucks: trucks.map((t) => ({
          truckId: t.truckId,
          plateNumber: t.plateNumber,
          loadedQty: t.loadedQty,
          ...(t.customerId != null ? { customerId: t.customerId, customerName: t.customerName || "" } : {}),
        })),
      },
      allocationCode: locked.allocationCode,
    }, tx);

    // Its trucks go on Delivery Inventory now — Costing, the AGO ledger and
    // the Sales Ledger see them before anyone starts selling. Its stock,
    // officers and the drivers' texts still wait for Start selling.
    await pfiRepo.writePendingBatch(sub.id, { tx, enteredByName: user?.name || user?.email || "" });

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
    /**
     * A linked order gets the trucks as its loads the way any allocation's
     * order follows its trucking PFI's trucks: a pending load per truck, or
     * one already signed out on an order that has completed. Its litres and
     * value are the trucks' already (raise and linkOrder checked), so the
     * cargo's stock does not move.
     */
    if (linking) {
      // Required here: allocationTrucks.service requires orderPayment, which requires half the app.
      const { syncFromTrucks } = require("./allocationTrucks.service");
      await syncFromTrucks(sub.id, { tx, actor, adding: true });
    }

    const metadata = {
      allocationId: locked.id, parentPfiId: parent.id, parentPfiNumber: parent.pfiNumber,
      pfiNumber: sub.pfiNumber, subPfiId: sub.id, orderId: order.id,
      quantity: locked.quantity, price, trucks: trucks.length,
      ...(station ? { stationId: station.customerId, stationName: station.customerName } : {}),
      ...(linking ? { linkedOrder: true } : {}),
    };
    await auditLogRepo.record({ entityType: "pfi", entityId: parent.id, action: "pfi.trucks_allocation_approved", actor, metadata }, tx);
    await auditLogRepo.record({ entityType: "pfi", entityId: sub.id, action: "pfi.raised_from_allocation", actor, metadata }, tx);
    if (!linking) {
      await auditLogRepo.record({ entityType: "order", entityId: order.id, action: "order.placed_for_allocation", actor, metadata }, tx);
    }

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

/**
 * Make an order already on the cargo the allocation's, inside the approval's
 * transaction. Checked again here: the order may have been paid, cancelled,
 * merged or resized since the request was raised.
 *
 * It moves to the house account under the allocation's company name — which
 * changes its reference's initials (ST12632 → SN12632); the number, which is
 * what an old reference is looked up by, stays — and takes the allocation's
 * key. Its price, total, payments and status are left as they are.
 */
async function linkOrder({ tx, locked, parent, house, user }) {
  const order = await orderRepo.lockById(locked.orderId, tx);
  const [facts] = await allocationRepo.ordersToLink({ orderId: locked.orderId }, tx);
  const why = linkProblem(facts, parent, { allocationId: locked.id });
  if (why) throw httpError(409, why);
  if (facts.quantity !== Number(locked.quantity) || facts.price !== Number(locked.pricePerUnit)) {
    throw httpError(
      409,
      `${facts.reference} is now ${fmt(facts.quantity)} at ₦${fmt(facts.price)}, not the ${fmt(locked.quantity)} at ` +
        `₦${fmt(locked.pricePerUnit)} this request was raised for. Withdraw it and link the order again.`,
    );
  }

  const companyName = allocationCompany(locked.pfiNumber);
  const from = {
    customerId: order.customerId,
    customerName: facts.customerName,
    companyName: facts.companyName,
    reference: facts.reference,
    idempotencyKey: order.idempotencyKey ?? null,
  };
  const updated = await orderRepo.update(order.id, {
    customerId: house.id,
    companyName,
    idempotencyKey: orderKey(locked.id),
  }, tx);
  await allocationRepo.moveOrderPapers(order.id, house.id, tx);
  await auditLogRepo.record({
    entityType: "order",
    entityId: order.id,
    action: "order.linked_for_allocation",
    actor: { type: "staff", staffId: user.id },
    metadata: {
      allocationId: locked.id,
      pfiNumber: locked.pfiNumber,
      parentPfiId: parent.id,
      from,
      to: { customerId: house.id, customerName: house.name, companyName, reference: generateOrderReference(companyName, order.id) },
    },
  }, tx);
  return updated;
}

async function reject({ allocationId, user, note }) {
  if (!isApprover(user)) throw httpError(403, "Only an admin or super admin can reject a truck allocation");
  const reason = String(note || "").trim();
  if (!reason) throw httpError(400, "Say why it is rejected");
  await close(allocationId, "rejected", user, reason);
  decided(allocationId, "rejected");
  return allocationRepo.findById(allocationId);
}

/**
 * Withdrawn means deleted (the user, 2026-10-21). A request taken back before
 * anybody decided it leaves nothing behind: not the request, not its lines in
 * the activity log, not the "waiting for approval" notices. Its letter is free
 * again at once. Texts already sent stay in the message ledger — that is what
 * they cost, not a record of the request.
 *
 * Only a pending request can be withdrawn; an approved or rejected one is a
 * decision, and stays.
 */
async function withdraw({ allocationId, user }) {
  const current = await allocationRepo.findById(allocationId);
  if (!current) throw httpError(404, "Allocation not found");
  if (Number(current.raisedBy) !== Number(user?.id) && !isApprover(user)) {
    throw httpError(403, "Only whoever raised it, or an admin, can withdraw it");
  }
  return db.transaction(async (tx) => {
    const locked = await allocationRepo.lockById(allocationId, tx);
    if (!locked) throw httpError(404, "Allocation not found");
    if (locked.status !== "pending") throw httpError(409, `This allocation was already ${locked.status}`);
    // An approval that placed its order and then failed leaves the request
    // pending with a real order behind it. Deleting it would strand that order.
    const placed = await orderRepo.findByIdempotencyKey(orderKey(locked.id), tx);
    if (placed) {
      throw httpError(409, `Order ${placed.orderNumber} was already placed for this allocation — approve it again to finish.`);
    }
    await allocationRepo.deleteWithTraces(locked.id, tx);
    return { id: locked.id, pfiNumber: locked.pfiNumber, parentPfiId: locked.parentPfiId };
  });
}

/** Refuse a request — it ends without making anything, and stays on record. */
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
  linkProblem,
  HOUSE_PURPOSE,
  STATION_LOAD,
  orderKey,
};
