const pfiBankScope = require("../../lib/pfiBankScope");
const asyncHandler = require("express-async-handler");
const QRCode = require("qrcode");
const {
  orderRepo,
  depotRepo,
  pfiRepo,
  truckRepo,
  orderTruckRepo,
  orderPfiAllocationRepo,
  ticketRepo,
  auditLogRepo,
} = require("../../repositories");
const { isWithinScope } = require("../../lib/scopeFilter");
const { db } = require("../../config/db");
const { sql } = require("drizzle-orm");
const { pfiMovements } = require("../../db/schema");
const walletService = require("../../services/wallet.service");
const { generateTicketForTruck } = require("../../services/ticket.service");
const orderStatus = require("../../services/orderStatus.service");
const truckProgress = require("../../services/truckProgress.service");
const orderService = require("../../services/order.service");
const orderPaymentService = require("../../services/orderPayment.service");
const orderMergeService = require("../../services/orderMerge.service");
const { sendOrderInvoiceEmail } = require("../../services/email.service");
const { sendOrderSummarySMS } = require("../../services/sms.service");
const { placeOrder, withExpiresAt } = orderService;

/** Small helper: an HTTP error the error handler renders with its status. */
function httpErr(status, message) {
  return Object.assign(new Error(message), { status });
}

const getOrders = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, search, status, customer, depot, dateFrom, dateTo, payable } = req.query;

  const result = await orderRepo.findAll({
    payable,
    search,
    status,
    customer,
    depot,
    dateFrom,
    dateTo,
    scopeUser: req.user,
    page,
    limit,
  });

  res.json({ success: true, data: { ...result, orders: await withExpiresAt(result.orders) } });
});

const getOrderById = asyncHandler(async (req, res) => {
  const order = await orderRepo.findByIdFull(req.params.id);

  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  res.json({ success: true, data: { order: await withExpiresAt(order) } });
});

// The desk places an order FOR a customer: the customer id comes from the
// request body. The shared placeOrder service does the real work; this handler
// only supplies who the customer is. See also the customer portal's
// createMyOrder, which passes the authenticated customer's own id.
const createOrder = asyncHandler(async (req, res) => {
  const {
    customer: customerId, state, depot: depotId,
    product: productId, quantity, deliveryType, deliveryAddress, companyName, trucks,
    expectedTrucks,
    /**
     * `{ reason }` to raise this order with no agreed price — the manual
     * ticket case. Also authorises it to load on credit; see placeOrder.
     */
    unpriced,
  } = req.body;

  if (!customerId || !state || !depotId || !productId || !quantity || !deliveryType) {
    return res.status(400).json({
      success: false,
      message: "Please fill in all required fields to place the order",
    });
  }

  if (!isWithinScope(req.user, "depotIds", depotId)) {
    return res.status(403).json({
      success: false,
      message: "You cannot create orders for this location",
    });
  }

  const { order, payment } = await placeOrder({
    customerId, state, depotId, productId, quantity, deliveryType, deliveryAddress, companyName, trucks,
    expectedTrucks,
    unpriced: unpriced || null,
    actor: { type: "staff", staffId: req.user.id },
  });

  res.status(201).json({
    success: true,
    message: "Order placed successfully",
    data: { order: await withExpiresAt(order), payment },
  });
});

// --- Release: Paid → Released ------------------------------------------------
//
// The raw `PUT /orders/:id` status setter (updateOrder) and the manual
// `POST /:id/complete` setter are GONE (AUDIT H1). They let any caller stamp
// any status, skipping the pipeline and leaving no audit row. Every status
// change now flows through orderStatus.transition — the single writer that
// locks the row, enforces the legal move and writes the audit trail atomically.
//
// Release is a staff action ("release" role): it clears a paid order for
// loading. The fleet-truck allocation is captured HERE for a delivery order —
// the plate/driver of each Soroman truck sent to load — and the loads are
// created in the same transaction as the transition, so a bad allocation rolls
// the release back. A pickup order carries no trucks at release: the customer's
// own truck is captured by security at gate-in (see the gate flow).
const releaseOrder = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const trucks = req.body.trucks || [];

  const order = await orderRepo.findById(orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  const isDelivery = order.deliveryType === "delivery";
  if (isDelivery) {
    if (trucks.length === 0) {
      return res.status(400).json({
        success: false,
        message: "A delivery order needs at least one truck allocated at release",
      });
    }
    // The loads must account for exactly the order quantity — no over- or
    // under-allocation. Compared as numbers; the schema already coerced them.
    const allocated = trucks.reduce((sum, t) => sum + Number(t.quantity), 0);
    if (allocated !== Number(order.quantity)) {
      return res.status(400).json({
        success: false,
        message: `Allocated truck quantity (${allocated}) must equal the order quantity (${order.quantity})`,
      });
    }
    // Each truck must carry a positive quantity.
    const zeroTruck = trucks.find((t) => Number(t.quantity) <= 0);
    if (zeroTruck) {
      return res.status(400).json({
        success: false,
        message: "Each truck must carry a positive quantity",
      });
    }
  } else if (trucks.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Pickup trucks are declared by the customer at order, not at release",
    });
  }

  const released = await db.transaction(async (tx) => {
    const current = await orderRepo.lockById(orderId, tx);
    if (!current) throw httpErr(404, "Order not found");

    // Payment releases an order on its own now (orderStatus.releaseOnPayment),
    // so this desk action almost always arrives at an order that is already
    // Released. That is a no-op, not a conflict — the caller came here to
    // allocate trucks, which still runs below.
    //
    // When it is NOT already released, this is the other door into the same
    // room, and it takes the same lock. A full payment releases the order by
    // itself, so an order sitting at Pending here is one that is still owing —
    // releasing it from this screen would be the part-payment release taken
    // out through a side entrance. Credit is the way to clear a balance for
    // loading, and it is a decision with a name on it.
    if (current.status !== "Released" && !orderService.canReleaseForLoading(current)) {
      const owing = Number(current.totalAmount) - Number(current.amountPaid ?? 0);
      throw httpErr(
        409,
        `${current.orderNumber} cannot be released for loading: ₦${owing.toLocaleString()} is still outstanding. ` +
          `Record the balance against it, or have finance authorise credit on the order.`,
      );
    }

    const updated =
      current.status === "Released"
        ? current
        : await orderStatus.transition(orderId, "Released", {
            tx,
            actor: { type: "staff", staffId: req.user.id },
            set: { releasedAt: new Date(), releasedBy: req.user.id },
            metadata: { truckCount: isDelivery ? trucks.length : 0 },
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
          });

    // Allocating again over an order that already carries loads would double
    // them — the second call reports the first allocation instead.
    const already = await orderTruckRepo.findByOrder(orderId, tx);

    if (isDelivery && already.length === 0) {
      let index = 1;
      for (const t of trucks) {
        // A fleet truck contributes its registered plate; the stored plate is
        // still the source of truth, so a later fleet edit never rewrites this
        // historical load.
        let truckNumber = t.truckNumber || null;
        if (t.truckId != null) {
          const fleet = await truckRepo.findById(t.truckId);
          if (!fleet) {
            throw Object.assign(new Error(`Fleet truck ${t.truckId} not found`), { status: 400 });
          }
          truckNumber = truckNumber || fleet.plateNumber;
        }

        const load = await orderTruckRepo.create(
          {
            orderId,
            truckIndex: index++,
            truckId: t.truckId ?? null,
            truckNumber,
            quantity: String(t.quantity),
            compartments: t.compartments ?? null,
            driverName: t.driverName ?? null,
            driverPhone: t.driverPhone ?? null,
            loaderName: t.loaderName ?? null,
            loaderPhone: t.loaderPhone ?? null,
            status: "pending",
          },
          tx
        );
        await auditLogRepo.record(
          {
            entityType: "order_truck",
            entityId: load.id,
            action: "order_truck.allocated",
            actor: { type: "staff", staffId: req.user.id },
            metadata: { orderId, truckIndex: load.truckIndex, truckNumber, truckId: t.truckId ?? null, quantity: String(t.quantity), via: "release" },
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
          },
          tx
        );
      }
    }

    return updated;
  });

  const fullOrder = await orderRepo.findByIdFull(released.id);
  const loads = await orderTruckRepo.findByOrder(orderId);
  res.json({
    success: true,
    message: "Order released for loading",
    data: { order: await withExpiresAt(fullOrder), trucks: loads },
  });
});

// --- Cancel: any live status through Released → Cancelled --------------------
//
// The status change now goes through the state machine FIRST (inside the same
// transaction): it locks the row, rejects an illegal move (Loading/Completed →
// 409) or a concurrent double-cancel (the loser gets 409 before any refund),
// and writes the audit row. Only then do stock release and the refund + its
// ledger row run — all one unit, so a failure anywhere rolls
// the whole cancel back (AUDIT H2/H6), and no order is ever refunded twice.
const cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  await orderService.cancelOrder({
    orderId: Number(req.params.id),
    actor: { type: "staff", staffId: req.user.id },
    reason: reason ?? null,
    cancelledBy: req.user.id,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  const updatedOrder = await orderRepo.findByIdFull(Number(req.params.id));
  res.json({ success: true, message: "Order cancelled successfully", data: { order: await withExpiresAt(updatedOrder) } });
});

// --- The truck gate flow ----------------------------------------------------
//
// A load's life, and where each step happens:
//
//   generate-tickets (ticketing)  →  loaded     ; the ticket IS the loading
//   gate-in   (security_entry)  loaded → gated_in   ; first truck ⇒ Released→Loading
//   gate-out  (security_exit)  gated_in → gated_out ; last truck  ⇒ Loading→Completed
//
// `pending` is the odd one out: it is a fleet allocation captured at release
// before its ticket exists. Ticketing turns it `loaded`; it may also be gated
// in as-is, and the exit stamps the loading it never got.
//
// The separate `load` (ticketing) endpoint is what remains of a third
// checkpoint. Nothing in the flow needs it now — it stays as the correction
// desk for a truck swapped at the gantry, where the plate on the ticket must
// change after the ticket was cut.
//
// Every action locks the ORDER row first (orderRepo.lockById), so concurrent
// trucks on the same order serialise: exactly one sees the "first in" / "last
// out" edge and drives the order transition; the others skip it. Each load's
// own status guard makes an out-of-order or repeated action a clean 409.

/**
 * A caller-supplied gate timestamp, or now.
 *
 * Rejects anything unparseable rather than silently recording the current
 * time — a wrong gate time is worse than a refused one.
 */
function parseWhen(value) {
  if (!value) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw httpErr(400, "Timestamp must be a valid ISO 8601 datetime");
  }
  return d;
}

const GATEABLE = new Set(["Released", "Loading"]);

// security_entry: a truck arrives at the entrance gate to load.
const gateInTruck = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const { loadId, truckNumber, quantity, driverName, driverPhone, compartments } = req.body;
  const actor = { type: "staff", staffId: req.user.id };
  const audit = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

  const load = await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");
    if (!GATEABLE.has(order.status)) {
      throw httpErr(409, `Order is ${order.status}; it is not open for gating`);
    }

    let gated;
    if (loadId != null) {
      // A load already exists — a delivery truck allocated at release, or a
      // pickup truck the customer declared at order. Flip that specific one.
      const existing = await orderTruckRepo.findById(loadId, tx);
      if (!existing || existing.orderId !== orderId) throw httpErr(404, "Truck load not found on this order");
      // A truck may arrive ticketed (`loaded`, the normal case) or merely
      // allocated (`pending`). Anything further along has been here already:
      // idempotent, so a second entry reports the first rather than
      // overwriting the original timestamp.
      if (existing.status !== "pending" && existing.status !== "loaded") {
        return { load: existing, alreadyEntered: true };
      }
      // The truck that actually arrived may differ from the one declared (a
      // pickup swap, or an unknown plate now known). Record the correction.
      // optionalString yields "" for an omitted field — treat that as "not
      // provided" so a blank body never wipes the declared plate/driver.
      const plateChanged = Boolean(truckNumber) && truckNumber !== existing.truckNumber;
      gated = await orderTruckRepo.update(
        loadId,
        {
          status: "gated_in",
          securityEnteredAt: parseWhen(req.body.enteredAt),
          securityEnteredBy: req.user.id,
          ...(truckNumber ? { truckNumber } : {}),
          // The driver observed at the gate is recorded alongside — never over
          // — the one booked at generation. The truck that turns up is not
          // always the one booked, and both facts matter afterwards.
          ...(driverName ? { entryDriverName: driverName } : {}),
          ...(driverPhone ? { entryDriverPhone: driverPhone } : {}),
        },
        tx
      );
      if (plateChanged) {
        await auditLogRepo.record(
          {
            entityType: "order_truck",
            entityId: loadId,
            action: "order_truck.plate_corrected",
            actor,
            metadata: { from: existing.truckNumber, to: truckNumber, at: "gate-in", orderId },
            ...audit,
          },
          tx
        );
      }
    } else if (order.deliveryType === "pickup") {
      // No pre-declared load (customer skipped the optional split): the
      // customer's truck is captured HERE, the first time it is seen.
      if (!truckNumber || quantity == null) {
        throw httpErr(400, "A pickup gate-in needs the truck's plate (truckNumber) and quantity");
      }
      const index = (await orderTruckRepo.countByOrder(orderId, tx)) + 1;
      gated = await orderTruckRepo.create(
        {
          orderId,
          truckIndex: index,
          truckId: null,
          truckNumber,
          quantity: String(quantity),
          compartments: compartments ?? null,
          driverName: driverName ?? null,
          driverPhone: driverPhone ?? null,
          status: "gated_in",
          securityEnteredAt: parseWhen(req.body.enteredAt),
          securityEnteredBy: req.user.id,
        },
        tx
      );
    } else {
      throw httpErr(400, "loadId is required for a delivery order");
    }

    await auditLogRepo.record(
      {
        entityType: "order_truck",
        entityId: gated.id,
        action: "order_truck.gated_in",
        actor,
        metadata: { orderId, truckNumber: gated.truckNumber },
        ...audit,
      },
      tx
    );

    // First truck through the gate opens loading. Under the order lock, only the
    // first caller sees Released; a later truck sees Loading and skips this.
    if (order.status === "Released") {
      await orderStatus.transition(orderId, "Loading", {
        tx,
        actor,
        set: { loadingStartedAt: new Date() },
        metadata: { trigger: "gate-in", loadId: gated.id },
        ...audit,
      });
    }

    return gated;
  });

  res.json({ success: true, message: "Truck gated in", data: { truck: load } });
});

// ticketing: confirm the loading and issue the ticket if the load somehow has
// none. Tickets are now cut at generation, so the flow no longer passes through
// here — what it remains good for is the LAST moment the plate can change.
// Trucks get swapped at the gantry (the declared one broke down, another came)
// and the ticket must name the truck that actually loaded. An optional
// truckNumber/driver here records that actual truck; the change is audited and
// the ticket is generated from the corrected load.
const markTruckLoaded = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const loadId = Number(req.params.loadId);
  const { truckNumber, driverName, driverPhone } = req.body;
  const actor = { type: "staff", staffId: req.user.id };
  const audit = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

  const result = await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");

    const load = await orderTruckRepo.findById(loadId, tx);
    if (!load || load.orderId !== orderId) throw httpErr(404, "Truck load not found on this order");
    if (load.status === "gated_out") {
      throw httpErr(409, "Truck has already left the depot; its ticket can no longer be changed");
    }

    // optionalString yields "" for an omitted field — treat that as "not
    // provided" so loading without an edit keeps the plate already on the load.
    const plateChanged = Boolean(truckNumber) && truckNumber !== load.truckNumber;
    const updated = await orderTruckRepo.update(
      loadId,
      {
        // A truck already through the entrance gate keeps that state — being
        // marked loaded afterwards must not send it back outside.
        ...(load.status === "gated_in" ? {} : { status: "loaded" }),
        loadedAt: new Date(),
        loadedBy: req.user.id,
        ...(truckNumber ? { truckNumber } : {}),
        ...(driverName ? { driverName } : {}),
        ...(driverPhone ? { driverPhone } : {}),
      },
      tx
    );
    if (plateChanged) {
      await auditLogRepo.record(
        {
          entityType: "order_truck",
          entityId: loadId,
          action: "order_truck.truck_swapped",
          actor,
          metadata: { from: load.truckNumber, to: truckNumber, at: "loading", orderId },
          ...audit,
        },
        tx
      );
    }
    await auditLogRepo.record(
      {
        entityType: "order_truck",
        entityId: loadId,
        action: "order_truck.loaded",
        actor,
        metadata: { orderId, truckNumber: updated.truckNumber },
        ...audit,
      },
      tx
    );
    const ticket = await generateTicketForTruck(order, updated, tx);
    return { truck: updated, ticket };
  });

  res.json({ success: true, message: "Truck loaded and ticket issued", data: result });
});

// Correct a load's own details after the fact — quantity, plate, driver.
// Deliberately separate from markTruckLoaded: that endpoint is the ticketing
// desk's "confirm loaded" action and has side effects (status, a fresh
// ticket); this one only ever touches the four columns on the load itself.
const updateTruckLoad = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const loadId = Number(req.params.loadId);
  const { truckNumber, quantity, driverName, driverPhone } = req.body;

  const updated = await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");

    const load = await orderTruckRepo.findById(loadId, tx);
    if (!load || load.orderId !== orderId) throw httpErr(404, "Truck load not found on this order");
    if (load.status === "gated_out") {
      throw httpErr(409, "Truck has already left the depot; its ticket can no longer be changed");
    }

    if (quantity !== undefined) {
      const others = await orderTruckRepo.findByOrder(orderId, tx);
      const otherTotal = others
        .filter((l) => l.id !== loadId)
        .reduce((s, l) => s + Number(l.quantity), 0);
      if (otherTotal + quantity > Number(order.quantity)) {
        throw httpErr(
          400,
          `That puts total ticketed quantity at ${otherTotal + quantity}, above the order's ${order.quantity}`
        );
      }
    }

    const row = await orderTruckRepo.update(
      loadId,
      {
        ...(quantity !== undefined ? { quantity: String(quantity) } : {}),
        ...(truckNumber ? { truckNumber } : {}),
        ...(driverName ? { driverName } : {}),
        ...(driverPhone ? { driverPhone } : {}),
      },
      tx
    );

    await auditLogRepo.record(
      {
        entityType: "order_truck",
        entityId: loadId,
        action: "order_truck.details_corrected",
        actor: { type: "staff", staffId: req.user.id },
        metadata: {
          orderId,
          from: { truckNumber: load.truckNumber, quantity: load.quantity, driverName: load.driverName, driverPhone: load.driverPhone },
          to: { truckNumber: row.truckNumber, quantity: row.quantity, driverName: row.driverName, driverPhone: row.driverPhone },
        },
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      tx
    );

    return row;
  });

  res.json({ success: true, message: "Truck details updated", data: { truck: updated } });
});

// security_exit: the loaded truck leaves the depot.
const gateOutTruck = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const loadId = Number(req.params.loadId);
  const actor = { type: "staff", staffId: req.user.id };
  const audit = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

  const result = await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");

    const load = await orderTruckRepo.findById(loadId, tx);
    if (!load || load.orderId !== orderId) throw httpErr(404, "Truck load not found on this order");
    // Idempotent: a second exit reports the first rather than overwriting it.
    if (load.status === "gated_out") {
      return { load, alreadyExited: true };
    }
    // The one ordering rule left: a truck that never arrived cannot leave.
    if (load.status !== "gated_in") {
      throw httpErr(409, "Truck must be marked as entered before it can exit");
    }

    // A load with no loading stamped is one security captured at the gate
    // itself — a pickup truck the customer brought without a ticket. The exit
    // stands in for the loading it never had: stamp it, issue the ticket, and
    // audit it as a loading recorded at the gate.
    const loadedHere = !load.loadedAt;
    const exitedAt = parseWhen(req.body.exitedAt);

    const updated = await orderTruckRepo.update(
      loadId,
      {
        status: "gated_out",
        securityExitedAt: exitedAt,
        securityExitedBy: req.user.id,
        ...(loadedHere ? { loadedAt: exitedAt, loadedBy: req.user.id } : {}),
        // Gantry the truck loaded from and the loader on duty, per the
        // security handover record.
        ...(req.body.gantry ? { gantry: String(req.body.gantry).trim() } : {}),
        ...(req.body.loaderName ? { loaderName: String(req.body.loaderName).trim() } : {}),
      },
      tx
    );

    if (loadedHere) {
      await generateTicketForTruck(order, updated, tx);
      await auditLogRepo.record(
        {
          entityType: "order_truck",
          entityId: loadId,
          action: "order_truck.loaded",
          actor,
          metadata: { orderId, truckNumber: updated.truckNumber, via: "gate-out" },
          ...audit,
        },
        tx
      );
    }

    await auditLogRepo.record(
      {
        entityType: "order_truck",
        entityId: loadId,
        action: "order_truck.gated_out",
        actor,
        metadata: { orderId, truckNumber: updated.truckNumber },
        ...audit,
      },
      tx
    );

    // Last truck out completes the order — but only once the order's full
    // quantity has actually been ticketed. "No load remains in a non-terminal
    // state" alone isn't enough: if trucks were added in batches and only the
    // first batch has gated out so far, that also reads as "none remaining"
    // even though real litres are still unticketed. Under the order lock this
    // is race-free.
    let completed = false;
    const remaining = await orderTruckRepo.countRemainingByOrder(orderId, tx);
    const ticketedQty = await orderTruckRepo.sumQuantityByOrder(orderId, tx);
    if (remaining === 0 && ticketedQty >= Number(order.quantity) && order.status === "Loading") {
      await orderStatus.transition(orderId, "Completed", {
        tx,
        actor,
        set: { completedAt: new Date() },
        metadata: { trigger: "gate-out", loadId: updated.id },
        ...audit,
      });
      // The order is fulfilled — convert the wallet hold into a booked debit
      // ledger row (the spend is recorded only now, not at order time). An order
      // with no active hold (never wallet-funded) is a no-op.
      await walletService.convertHold(
        orderId,
        `Payment for Order ${order.orderNumber} (Wallet Balance)`,
        tx
      );
      completed = true;
    }

    return { truck: updated, orderCompleted: completed };
  });

  res.json({
    success: true,
    message: result.orderCompleted ? "Truck gated out; order completed" : "Truck gated out",
    data: result,
  });
});

/**
 * Erase an order and everything hanging off it.
 *
 * This is a hard delete, including for paid orders — asked for deliberately so
 * a mistaken order can be removed rather than left cancelled in the register.
 *
 * Three relations are ON DELETE RESTRICT and would block the statement, so
 * they are removed explicitly first: tickets, commissions and wallet holds.
 * order_trucks, pfi_movements and pfi allocations cascade on their own;
 * delivery notes and WhatsApp sessions null their reference.
 *
 * The cascade drops the allocation rows but not what they reserved: a PFI's
 * `sold_qty_litres` is only ever incremented by reserveStock and decremented
 * by releaseStock, and neither runs just because a row disappeared. Every
 * allocation is released explicitly, before the cascade, or the litres stay
 * claimed on a PFI forever against an order that no longer exists.
 *
 * The audit row is written BEFORE the delete and survives it — audit_logs has
 * no foreign key to orders — so a deleted order still leaves a record of what
 * was destroyed, by whom, and what it was worth. That is the only trace left,
 * which is why this is restricted to super_admin: removing a paid order also
 * removes its payment trail, and any wallet debit behind it becomes
 * unreconcilable.
 */
const deleteOrder = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await orderRepo.findByIdFull(orderId);
  if (!order) throw httpErr(404, "Order not found");

  const removed = await db.transaction(async (tx) => {
    // Snapshot first: once the row is gone this is all that is left.
    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.deleted",
        actor: { type: "staff", staffId: req.user.id },
        metadata: {
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          totalAmount: String(order.totalAmount),
          quantity: order.quantity,
          customerId: order.customerId,
          customerName: order.customerName,
          depotName: order.depotName,
          productName: order.productName,
          pfiId: order.pfiId,
          createdAt: order.createdAt,
        },
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      tx
    );

    // Give back whatever this order still had reserved, before the cascade
    // takes the allocation rows with it and there is nothing left to read.
    const allocations = await orderPfiAllocationRepo.findByOrderId(orderId, tx);
    for (const alloc of allocations) {
      await pfiRepo.releaseStock(alloc.pfiId, alloc.quantity, tx);
    }

    /**
     * Hand the customer's money back before the hold row is destroyed.
     *
     * placeHold() takes the money out of customers.balance and the hold row is
     * the only record that it is owed back. Deleting that row outright — which
     * is what this did — left the balance permanently short with nothing on
     * the ledger to show why.
     *
     * Order PU11486 is how it surfaced: ₦103,700,000, Paid, deleted on
     * 2026-08-26. Its customer was left holding three unspent credits totalling
     * exactly that and a balance of zero, so the money could not be put toward
     * the replacement order and the credits looked lost.
     *
     * releaseHold does the whole reversal — credits the balance, marks the hold
     * released, and returns each deposit's remainingAmount so the credits can
     * fund something else. It is a no-op on a hold already converted, which is
     * correct: that money genuinely left, and its debit row says so.
     */
    const released = await walletService.releaseHold(orderId, tx);

    // The three RESTRICT relations, which would otherwise block the delete.
    const counts = {};
    for (const table of ["tickets", "commissions", "wallet_holds"]) {
      const rows = await tx.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE order_id = ${orderId} RETURNING id`
      );
      counts[table] = rows.length ?? rows.rowCount ?? 0;
    }
    counts.walletReleased = released?.success ? Number(order.totalAmount) : 0;

    // Everything else cascades or nulls out via its own constraint.
    await tx.execute(sql`DELETE FROM orders WHERE id = ${orderId}`);
    return counts;
  });

  res.json({
    success: true,
    message: `Order ${order.orderNumber} and all its records were deleted`,
    data: { deleted: removed },
  });
});

const getPayableOrders = asyncHandler(async (req, res) => {
  const orders = await orderRepo.findPayableOrders(req.user);
  res.json({ success: true, data: { orders: await withExpiresAt(orders) } });
});

/**
 * Confirm payment on an order from the bank statement lines that paid for it.
 *
 * Replaces the old "pay from wallet" endpoint. The desk names bank rows; it
 * does not name an amount, and there is no balance to draw on.
 */
const confirmOrderPayment = asyncHandler(async (req, res) => {
  /**
   * An order with no price cannot take a payment.
   *
   * Its total is zero, so any statement line attached to it lands entirely as
   * SURPLUS — the money would read as an overpayment on a free order, and the
   * order would settle as Paid having been invoiced for nothing. Pricing first
   * is not a formality; it is what makes the arithmetic mean anything.
   */
  const target = await orderRepo.findById(Number(req.params.id));
  // Scope before anything else is said about the order — even "it has no
  // price yet" tells somebody outside its PFI that it exists.
  if (target) pfiBankScope.assertOrderInScope(req.user, target);
  if (target?.pricingStatus === "pending") {
    throw httpErr(
      409,
      "This order has no price yet. Set the price first — otherwise the payment lands as surplus on a zero-value order.",
    );
  }

  const order = await orderService.confirmOrderPayment({
    orderId: Number(req.params.id),
    bankAccountId: Number(req.body.bankAccountId),
    lineIds: req.body.lineIds.map(Number),
    note: req.body.note || "",
    actor: { type: "staff", staffId: req.user.id },
    scopeUser: req.user,
  });

  const summary = await orderPaymentService.summarizeOrder(order.id);
  const partPaid = order.paymentStatus === "Part Paid";
  // Whether this payment actually opened the gate. A short payment is recorded
  // and reconciled but leaves the order at Pending — see the release gate in
  // order.service.js — so the desk is told that plainly rather than being left
  // to infer it from a status field on the next screen.
  const released = TICKETABLE.has(order.status);

  res.json({
    success: true,
    message: partPaid
      ? `Part payment recorded for ${order.orderNumber}: ₦${summary.received.toLocaleString()} received, ₦${summary.shortfall.toLocaleString()} still outstanding. It stays Pending and cannot be loaded until it is paid in full, or finance authorises credit on it.`
      : summary.surplus > 0
        ? `${order.orderNumber} paid. ₦${summary.surplus.toLocaleString()} was received beyond the order value and is held against this order — transfer it to another order if it was meant for one.`
        : `${order.orderNumber} paid — ₦${summary.received.toLocaleString()} matched to the bank statement.`,
    data: {
      order: await withExpiresAt(order),
      // What the desk needs next, without a second round trip to work it out.
      payment: {
        ...summary,
        // The ticketing cap if the order is open at all. It can be positive on
        // an order that is NOT released — a part-paid order buys litres it may
        // not load — so read it with `released`, never on its own.
        releasableQuantity: orderService.releasableQuantity(order),
        fullyPaid: !partPaid,
        released,
      },
    },
  });
});

/** Every payment recorded against one order, with its bank details. */
const getOrderPayments = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const [payments, summary] = await Promise.all([
    orderPaymentService.listForOrder(orderId),
    orderPaymentService.summarizeOrder(orderId),
  ]);
  res.json({ success: true, data: { payments, summary } });
});

/**
 * Take a payment back off an order — it was matched to the wrong one.
 *
 * The statement line returns to the unmatched pool so it can be recorded
 * against the order it really belongs to.
 */
const removeOrderPayment = asyncHandler(async (req, res) => {
  const { removed, summary } = await orderPaymentService.removePayment({
    paymentId: Number(req.params.paymentId),
    staffId: req.user.id,
    reason: req.body.reason,
  });

  res.json({
    success: true,
    message: removed.statementLineId
      ? `Payment of ₦${Number(removed.amount).toLocaleString()} removed. Its bank statement line is back in the unmatched pool.`
      : `Payment of ₦${Number(removed.amount).toLocaleString()} removed.`,
    data: { summary },
  });
});

/**
 * Move surplus from this order to another one.
 *
 * Live alongside refunds, deliberately. Surplus has two honest destinations —
 * back to the customer, or onto another order they are buying — and which one
 * applies is a decision the desk makes per case, not one the system should
 * make for them.
 *
 * The two cannot both claim the same money: a transfer moves it off this
 * order, so the refundable figure falls with it, and a refund takes it out of
 * what a transfer could move. Both are computed from the same payment rows.
 */
/**
 * The cargoes whose orders may move surplus between each other. Nothing else.
 *
 * Transfers were switched off on the finance report (the owner's call — the
 * report is audited) and are back for one cargo only: PFI 39/26/PMS/MT
 * STELLAR/LIQUID BULK (#42). BOTH ends must be on a listed PFI, so money can
 * move between that cargo's orders but never onto or off another cargo. Keyed
 * by id rather than by name: the number is typed by hand and has already been
 * written two ways ("PFI 39/26" and "PFI/39/26").
 *
 * Checked here, at the route, rather than in transferSurplus — the service is
 * also driven directly by scripts and tests that are not the desk.
 */
const SURPLUS_TRANSFER_PFI_IDS = new Set([42]);

const transferOrderPayment = asyncHandler(async (req, res) => {
  const ends = await db.execute(sql`
    SELECT o.id, o.pfi_id AS "pfiId" FROM orders o
     WHERE o.id IN (${Number(req.params.id)}, ${Number(req.body.toOrderId)})`);
  const outside = (ends.rows ?? ends).filter((o) => !SURPLUS_TRANSFER_PFI_IDS.has(Number(o.pfiId)));
  if (outside.length) {
    return res.status(409).json({
      success: false,
      message: "Moving surplus between orders is only open for PFI 39/26 (MT STELLAR), and both orders must be on it. Refund the overpayment instead.",
    });
  }

  const result = await orderPaymentService.transferSurplus({
    fromOrderId: Number(req.params.id),
    toOrderId: Number(req.body.toOrderId),
    amount: Number(req.body.amount),
    reason: req.body.reason,
    staffId: req.user.id,
  });

  res.json({
    success: true,
    message: `₦${Number(req.body.amount).toLocaleString()} moved to the destination order. Both orders now show the movement.`,
    data: result,
  });
});

/** Undo a transfer, both legs together. */
const reverseOrderPaymentTransfer = asyncHandler(async (req, res) => {
  const result = await orderPaymentService.reverseTransfer({
    transferId: Number(req.params.transferId),
    staffId: req.user.id,
    reason: req.body?.reason || "",
  });
  res.json({ success: true, message: "Transfer reversed on both orders.", data: result });
});

/**
 * Vouch for a payment the system attributed on its own.
 *
 * No money moves. Reversal was the first instinct and the data ruled it out —
 * none of these can be undone without dropping an already-ticketed order below
 * its own value — so what this fixes is the record, not the arithmetic: an
 * anonymous attribution becomes one with a name and a reason against it.
 */
const reviewOrderPayment = asyncHandler(async (req, res) => {
  const payment = await orderPaymentService.ratifyPayment({
    paymentId: Number(req.params.paymentId),
    staffId: req.user.id,
    note: req.body.note,
  });

  res.json({
    success: true,
    message: `₦${Number(payment.amount).toLocaleString()} on this order is now vouched for. The report still records that the system made the original attribution.`,
    data: { payment },
  });
});

/** Vouch for a movement between orders — both legs together. */
const reviewOrderPaymentTransfer = asyncHandler(async (req, res) => {
  const transfer = await orderPaymentService.ratifyTransfer({
    transferId: Number(req.params.transferId),
    staffId: req.user.id,
    note: req.body.note,
  });

  res.json({
    success: true,
    message: `Movement of ₦${Number(transfer.amount).toLocaleString()} is now vouched for on both orders.`,
    data: { transfer },
  });
});

/** What is left to review, by class — the queue, and how fast it is shrinking. */
const getPaymentReviewQueue = asyncHandler(async (req, res) => {
  const queue = await orderPaymentService.reviewQueue();
  res.json({ success: true, data: { queue } });
});

/** Orders currently holding money beyond their own value. */
const getOrdersWithSurplus = asyncHandler(async (req, res) => {
  const rows = await orderPaymentService.findOrdersWithSurplus({
    limit: req.query.limit,
    customerId: req.query.customerId,
  });
  res.json({ success: true, data: { orders: rows } });
});

/** Per-truck ceiling, matching the limit order.service enforces at creation. */
const MAX_TRUCK_LITRES = 60000;
/** Tickets may only be generated once the order has been released. */
const TICKETABLE = new Set(["Released", "Loading"]);

/**
 * POST /:id/generate-tickets
 *
 * Appends truck loads to a released order and issues a ticket for each.
 *
 * Everything runs inside one transaction against a locked order row, so two
 * people generating at the same moment cannot interleave: the second waits,
 * then recomputes its starting truck number against what the first committed.
 * That closes both the half-written-batch and duplicate-truck-number races.
 *
 * The whole trucks array is validated before anything is written, so a
 * malformed sixth truck rejects the request rather than half-creating five.
 */
const generateOrderTickets = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const trucks = Array.isArray(req.body.trucks) ? req.body.trucks : [];

  if (trucks.length === 0) {
    throw httpErr(400, "Provide at least one truck");
  }

  const result = await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");
    if (!TICKETABLE.has(order.status)) {
      throw httpErr(409, `Order is ${order.status}; tickets are generated after release`);
    }

    // ── Validate the whole batch first — all or nothing ────────────────────
    trucks.forEach((t, i) => {
      const where = `Truck ${i + 1}`;
      const qty = Number(t.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw httpErr(400, `${where}: quantity must be greater than zero`);
      }
      if (qty > MAX_TRUCK_LITRES) {
        throw httpErr(
          400,
          `${where}: ${qty.toLocaleString()} exceeds the ${MAX_TRUCK_LITRES.toLocaleString()} per-truck limit`,
        );
      }
      if (!String(t.driverName || "").trim()) throw httpErr(400, `${where}: driver name is required`);
      if (!String(t.driverPhone || "").trim()) throw httpErr(400, `${where}: driver phone is required`);
      if (!String(t.truckNumber || "").trim()) throw httpErr(400, `${where}: truck number is required`);
    });

    // ── Quantity ceiling ──────────────────────────────────────────────────
    // Only what has been PAID for may be ticketed. On a fully-paid order that
    // is the order quantity, exactly as before; on a part-paid one it is the
    // quantity the money received covers, so a customer who has paid for
    // 50,000 of a 100,000-litre order can load 50,000 and no more. Paying the
    // balance lifts the ceiling with no other action needed.
    const existing = await orderTruckRepo.findByOrder(orderId, tx);
    const alreadyTicketed = existing.reduce((s, l) => s + Number(l.quantity || 0), 0);
    const incoming = trucks.reduce((s, t) => s + Number(t.quantity), 0);
    const capacity = orderService.releasableQuantity(order);
    const partPaid = capacity < Number(order.quantity);

    if (alreadyTicketed + incoming > capacity) {
      // Two different problems, and telling them apart is the whole point of
      // the message: an over-ordered batch is the depot's mistake to fix, an
      // unpaid balance is finance's. Saying "exceeds order quantity" for the
      // second would send the desk hunting for a truck that isn't the issue.
      if (partPaid) {
        /**
         * Say which allowance ran out, because they are different people's to
         * fix. "Paid for" was the only source of permission when this was
         * written; with a credit allowance in the ceiling too, telling the desk
         * a credit-released order "exceeds the quantity paid for" would send
         * them chasing a payment nobody expected yet — and on an unpriced order
         * the "₦ still outstanding" figure is a placeholder zero.
         */
        const credit = Number(order.creditQty ?? 0);
        const requested = (alreadyTicketed + incoming).toLocaleString();
        const ordered = Number(order.quantity).toLocaleString();
        const ticketedNote = `${alreadyTicketed.toLocaleString()} already ticketed`;
        const balance = Number(order.totalAmount) - Number(order.amountPaid ?? 0);

        if (order.pricingStatus === "pending") {
          throw httpErr(
            400,
            `Exceeds what this unpriced order was released for: ${requested} requested against ${capacity.toLocaleString()} authorised of ${ordered} ordered (${ticketedNote}). Finance can raise the allowance on the order page.`,
          );
        }
        if (credit > 0) {
          throw httpErr(
            400,
            `Exceeds what is paid for plus the credit allowed: ${requested} requested against ${capacity.toLocaleString()} releasable of ${ordered} ordered — ${credit.toLocaleString()} of it on credit (${ticketedNote}). ₦${balance.toLocaleString()} is still outstanding.`,
          );
        }
        throw httpErr(
          400,
          `Exceeds the quantity paid for: ${requested} requested against ${capacity.toLocaleString()} paid for of ${ordered} ordered (${ticketedNote}). ₦${balance.toLocaleString()} is still outstanding.`,
        );
      }
      throw httpErr(400, `Exceeds order quantity: ${(alreadyTicketed + incoming).toLocaleString()} requested against ${capacity.toLocaleString()} ordered (${alreadyTicketed.toLocaleString()} already ticketed)`);
    }

    // ── Append, continuing the numbering ──────────────────────────────────
    // Read under the row lock, so a concurrent call cannot pick the same start.
    const startIndex = existing.reduce((max, l) => Math.max(max, Number(l.truckIndex || 0)), 0);

    // The ticket IS the loading authority: a load leaves this desk already
    // `loaded`, so security can take it straight in and out with no separate
    // "mark loaded" step in between. `pending` is now only what a release-time
    // fleet allocation looks like before its ticket is cut.
    const loadedNow = { status: "loaded", loadedAt: new Date(), loadedBy: req.user.id };

    // Two paths through this batch. A dup — a resubmission of a plate+quantity
    // already on the order — is rare and handled per-row exactly as before.
    // A genuinely new truck is the common case, and every new truck used to
    // cost ~5 sequential round trips (create, find-existing-ticket, create
    // ticket, QR write-back, audit row); batched below, the whole request
    // costs a small constant number of round trips regardless of how many
    // trucks are in it. `created` is filled by original index so the response
    // still lists trucks in the order they were submitted.
    const created = new Array(trucks.length);
    const newRows = [];

    for (let i = 0; i < trucks.length; i++) {
      const t = trucks[i];
      const plate = String(t.truckNumber).trim();

      // Idempotency: skip trucks that already exist on this order (same plate,
      // quantity and driver). A retry or impatient double-submit won't create
      // duplicate loads. If the driver changed, update the existing load so the
      // ticket names the correct person.
      const driverName = String(t.driverName).trim();
      const driverPhone = String(t.driverPhone).trim();
      const dup = existing.find(
        (l) => l.truckNumber === plate && String(l.quantity) === String(t.quantity)
      );
      if (dup) {
        const patch = {};
        if (dup.driverName !== driverName || dup.driverPhone !== driverPhone) {
          Object.assign(patch, { driverName, driverPhone });
        }
        // A paper ticket number supplied on a resubmission fills one that was
        // missing, but never overwrites one already recorded — the first entry
        // is the one taken off the physical ticket.
        const paper = String(t.manualTicketNumber ?? "").trim();
        if (paper && !dup.manualTicketNumber) Object.assign(patch, { manualTicketNumber: paper });
        // An allocation made at release is still `pending`; ticketing it now is
        // what makes it loaded. A truck already at the gate keeps its own state.
        if (dup.status === "pending") Object.assign(patch, loadedNow);
        if (Object.keys(patch).length) {
          Object.assign(dup, await orderTruckRepo.update(dup.id, patch, tx));
        }
        const ticket = await generateTicketForTruck(order, dup, tx);
        created[i] = { load: dup, ticket, alreadyExisted: true };
        continue;
      }

      newRows.push({
        index: i,
        quantity: String(t.quantity),
        data: {
          orderId,
          truckIndex: startIndex + i + 1,
          truckId: t.truckId ?? null,
          truckNumber: plate,
          quantity: String(t.quantity),
          compartments: t.compartments ?? null,
          driverName,
          driverPhone,
          loaderName: t.loaderName ?? null,
          loaderPhone: t.loaderPhone ?? null,
          // The number on the paper ticket the driver is already carrying,
          // where the depot wrote one before this system saw the order. Blank
          // on every load ticketed here first, which is most of them.
          manualTicketNumber: String(t.manualTicketNumber ?? "").trim(),
          ...loadedNow,
        },
      });
    }

    if (newRows.length) {
      // One round trip for every new load, instead of one per truck.
      const newLoads = await orderTruckRepo.createMany(newRows.map((r) => r.data), tx);

      // One round trip for every placeholder ticket — skips the per-truck
      // "does this load already have a ticket" check, which can only ever be
      // false for a load this same call just created.
      const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
      const placeholderTickets = await ticketRepo.createMany(
        newLoads.map((load) => ({
          ticketNumber: `TCK-${order.id}-${load.truckIndex}`,
          orderId: order.id,
          orderTruckId: load.id,
          status: "Active",
          qrCodeDataUrl: "placeholder",
        })),
        tx,
      );

      // QR encoding is CPU-only, not a database call — run every truck's
      // concurrently rather than serialising them behind awaits.
      const qrCodeDataUrls = await Promise.all(
        placeholderTickets.map((tk) =>
          QRCode.toDataURL(`${clientUrl}/ticket/details?id=${tk.id}`, { margin: 1, width: 300 }),
        ),
      );

      // One round trip to write every ticket's QR code back.
      await ticketRepo.updateManyQrCodes(
        placeholderTickets.map((tk, idx) => ({ id: tk.id, qrCodeDataUrl: qrCodeDataUrls[idx] })),
        tx,
      );
      const finishedTickets = placeholderTickets.map((tk, idx) => ({
        ...tk,
        qrCodeDataUrl: qrCodeDataUrls[idx],
      }));

      // One round trip for every audit row.
      await auditLogRepo.recordMany(
        newLoads.map((load, idx) => ({
          entityType: "order_truck",
          entityId: load.id,
          action: "order_truck.ticket_generated",
          actor: { type: "staff", staffId: req.user.id },
          metadata: {
            orderId,
            truckIndex: load.truckIndex,
            truckNumber: load.truckNumber,
            quantity: newRows[idx].quantity,
            via: "generate-tickets",
          },
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        })),
        tx,
      );

      newRows.forEach((r, idx) => {
        created[r.index] = { load: newLoads[idx], ticket: finishedTickets[idx] };
      });
    }

    // First generation moves the order onto the loading floor. Routed through
    // the state machine so the transition is audited and row-locked.
    if (order.status === "Released") {
      await orderStatus.transition(orderId, "Loading", {
        tx,
        actor: { type: "staff", staffId: req.user.id },
        set: { loadingStartedAt: new Date() },
        metadata: { trigger: "generate-tickets", truckCount: created.length },
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }

    // ── Deduct PFI stock ───────────────────────────────────────────────────
    // Stock moves at ticket generation, not at payment or release: a ticket is
    // what lets product physically leave, so this is the moment it stops being
    // available to sell.
    //
    // One row per (order, RELEASE), enforced by a unique index. Re-running
    // generation therefore cannot deduct the same order twice — the second
    // call updates the existing row rather than inserting beside it.
    //
    // The quantity written is the cumulative ticketed total, not this batch's
    // increment. That keeps the deduction honest when trucks are added over
    // several sittings while still leaving exactly one row to reverse.
    const ticketedTotal = alreadyTicketed + incoming;
    if (order.pfiId) {
      await tx
        .insert(pfiMovements)
        .values({
          pfiId: Number(order.pfiId),
          orderId,
          action: "RELEASE",
          qtyLitres: ticketedTotal,
          notes: `Ticket generation — ${created.length} truck(s)`,
          recordedBy: req.user?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [pfiMovements.orderId, pfiMovements.action],
          // Only the quantity moves; the original note records when the batch
          // first left.
          set: { qtyLitres: ticketedTotal },
        });
    }

    return {
      generated: created.length,
      startedAt: startIndex + 1,
      totalTicketed: alreadyTicketed + incoming,
      orderQuantity: capacity,
      remaining: capacity - (alreadyTicketed + incoming),
      trucks: created.map((c) => c.load),
    };
  });

  res.json({
    success: true,
    message: `${result.generated} ticket${result.generated === 1 ? "" : "s"} generated`,
    data: result,
  });
});

/**
 * GET /:id/trucks/:loadId/print
 *
 * Flattened print payload for one truck ticket — everything the printable
 * slip needs in one object, so the frontend renders rather than assembles.
 * Amount is this truck's share, not the order total.
 */
const getTruckTicketPrintData = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const loadId = Number(req.params.loadId);

  // findByIdFull joins customer, depot and product — the bare row has none.
  const order = await orderRepo.findByIdFull(orderId);
  if (!order) throw httpErr(404, "Order not found");

  const loads = await orderTruckRepo.findByOrder(orderId);
  const load = loads.find((l) => l.id === loadId);
  if (!load) throw httpErr(404, "Truck load not found on this order");

  const unitPrice = Number(order.price);
  const litres = Number(load.quantity);

    res.json({
    success: true,
    data: {
      reference: order.orderNumber,
      company: order.companyName || order.customerCompanyName || "",
      customerName: order.customerName || "",
      customerPhone: order.customerPhone || "",
      product: order.productName || "",
      productUnit: order.productUnit || "Litres",
      location: order.depotName || order.state || "",
      truckNumber: load.truckIndex,
      plateNumber: load.truckNumber,
      litres,
      unitPrice,
      // This truck's share of the order, not the order total.
      amount: litres * unitPrice,
      // Booked at generation, then as observed at the gate.
      driverName: load.driverName || "",
      driverPhone: load.driverPhone || "",
      entryDriverName: load.entryDriverName || "",
      entryDriverPhone: load.entryDriverPhone || "",
      gantry: load.gantry || "",
      loaderName: load.loaderName || "",
      loadingAt: load.loadedAt || load.securityEnteredAt || null,
      enteredAt: load.securityEnteredAt || null,
      exitedAt: load.securityExitedAt || null,
      status: load.status,
      totalTrucks: loads.length,
    },
  });
});

/** GET /:id/trucks — the loads on an order, for the ticketing desk. */
const getOrderTrucks = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await orderRepo.findById(orderId);
  if (!order) throw httpErr(404, "Order not found");
  const trucks = await orderTruckRepo.findByOrder(orderId);
  /**
   * The counts beside the rows, so the page never has to derive them.
   *
   * "4 of 6 ticketed, 2 of 6 loaded" is the sentence the loading desk and the
   * gate both work from, and it is the one thing the old order-level view
   * could not say — two truck rows looked the same whether the order needed
   * two or six.
   */
  const progress = await truckProgress.forOrder(orderId);
  res.json({ success: true, data: { trucks, progress } });
});

/**
 * POST /:id/reconcile — re-run the post-payment side effects (loading ticket,
 * commission, WhatsApp confirmation) for a paid order whose effects failed the
 * first time. runPostPaymentEffects is idempotent — it no-ops anything that
 * already exists — so this only fills the gaps and never duplicates. Finance-
 * gated at the route.
 */
const reconcileOrderEffects = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await orderRepo.findById(orderId);
  if (!order) throw httpErr(404, "Order not found");
  // Part Paid included: it has taken money, so it has a ticket and a commission
  // to reconcile just as a fully-paid order does.
  if (order.paymentStatus === "Unpaid") {
    throw httpErr(409, "Only a paid order can have its post-payment effects reconciled");
  }

  const result = await orderService.runPostPaymentEffects(orderId);

  res.json({
    success: true,
    message: "Post-payment effects reconciled",
    data: { orderId, ...result },
  });
});

// Edit anything about an order short of its status — reassign it to another
// customer, move it to a different PFI, correct its date, quantity, price or
// logistics text. See orderService.updateOrder for why status/paymentStatus
// stay out of this (AUDIT H1) and how the wallet hold, commission snapshot
// and PFI stock ledger are all kept in step with whatever changes.
const updateOrder = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);

  const updated = await orderService.updateOrder(orderId, req.body, {
    actor: { type: "staff", staffId: req.user.id },
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
    scopeUser: req.user,
  });

  res.json({
    success: true,
    message: "Order updated",
    data: { order: await withExpiresAt(await orderRepo.findByIdFull(updated.id)) },
  });
});

/**
 * The whole life of one order, oldest first.
 *
 * Reads back what the system has been writing all along. Every desk already
 * records what it does — a release, a payment matched or unmatched, a plate
 * corrected at the gate, each truck in and out — but until now nothing ever
 * read audit_logs, so the record existed and no one could see it. This is the
 * read side of that trail, and nothing new is written to produce it.
 *
 * Returned raw rather than pre-rendered into sentences: the phrasing belongs to
 * the page, and a label baked in here would be one the UI could not change.
 * `truckNumber` is non-null exactly on the truck events, which is how a caller
 * groups the stream by truck without parsing `action`.
 */
const getOrderTimeline = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await orderRepo.findById(orderId);
  if (!order) throw httpErr(404, "Order not found");

  const events = await auditLogRepo.findOrderTimeline(orderId);
  res.json({ success: true, data: { events } });
});

/**
 * Everything that has gone out and not been paid for.
 *
 * The compensating control for credit releases — see the repository note. A
 * plain read, gated on being signed-in staff like every other read here: an
 * exposure list nobody can open is not a control.
 */
const getReceivables = asyncHandler(async (req, res) => {
  const data = await orderRepo.findReceivables({
    search: req.query.search || "",
    minDays: Number(req.query.minDays) || 0,
  });
  res.json({ success: true, data });
});

/**
 * Put a price on an order that was raised without one.
 *
 * The other half of the manual ticket. The truck left days ago on a handwritten
 * ticket with no figure on it; this is the moment the figure is agreed and the
 * invoice becomes possible.
 *
 * ── Why the price is taken from the caller here, and nowhere else ──────────
 *
 * placeOrder deliberately refuses a client-supplied price — it reads the
 * depot's configured price server-side so nobody can sell at a number they
 * typed. That rule is right at order time and wrong here: the whole reason this
 * order has no price is that the figure was NOT the standing one, it was
 * negotiated. Falling back to today's depot price would quietly invent an
 * agreement nobody made.
 *
 * So the number is accepted, and the protections move to where they belong: it
 * is finance-gated, it demands a reason, the before-and-after is written to the
 * audit log, and it can only ever be done once — a priced order is not
 * repriced here.
 */
const setOrderPrice = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const price = Number(req.body.price);
  const reason = String(req.body.reason || "").trim();
  const actor = { type: "staff", staffId: req.user.id };
  const audit = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

  await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");

    if (order.pricingStatus !== "pending") {
      throw httpErr(
        409,
        "This order already has a price. Editing a priced order's figures is a different act, with its own trail.",
      );
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw httpErr(400, "The price must be greater than zero");
    }
    if (!reason) throw httpErr(400, "A reason is required — say what this price was agreed against");

    const quantity = Number(order.quantity);
    const totalAmount = price * quantity;

    /**
     * The credit allowance is left exactly as it is.
     *
     * Tempting to clear it — the order has a price now, so the "unknown amount"
     * part is over. But the other part is not: the product left before payment,
     * and it is still unpaid. Clearing the allowance would drop the order off
     * the receivables list at the very moment it finally became chaseable.
     * It leaves when the money arrives, not when the number does.
     */
    await orderRepo.update(
      orderId,
      {
        price: String(price),
        totalAmount: String(totalAmount),
        pricingStatus: "priced",
        pricedAt: new Date(),
        pricedBy: req.user.id,
      },
      tx,
    );

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.priced",
        actor,
        metadata: {
          price,
          quantity,
          totalAmount,
          reason,
          // How long it sat without one. The number worth watching: a day is
          // ordinary, a month means the invoice was never going to be raised.
          daysUnpriced: Math.max(
            0,
            Math.round((Date.now() - new Date(order.createdAt).getTime()) / 86400000),
          ),
        },
        ...audit,
      },
      tx,
    );
  });

  const order = await orderRepo.findByIdFull(orderId);

  /**
   * NOW the invoice goes out — the one placeOrder deliberately held back.
   *
   * An unpriced order sends the customer nothing at creation, because every
   * figure on the invoice would have been a placeholder zero. This is the
   * moment those figures become real, so this is where the same email and SMS
   * an ordinary order sends at checkout are sent instead.
   *
   * After the commit and never inside it: a slow mail or SMS provider must not
   * hold the order's row lock, and a failed send must not roll back a price
   * finance has already agreed. Both are reported back so the desk knows
   * whether the customer actually received it.
   */
  let emailSent = false;
  let smsSent = false;
  const invoice = {
    orderNumber: order.orderNumber,
    orderDate: order.createdAt,
    customerName: order.customerName,
    companyName: order.companyName || order.customerCompanyName || "",
    customerPhone: order.customerPhone,
    product: order.productName || "N/A",
    sku: order.productSku || "",
    quantity: order.quantity,
    unit: order.productUnit || "Liters",
    price: order.price,
    totalAmount: order.totalAmount,
    deliveryType: order.deliveryType,
    depotName: order.depotName,
    depotCode: order.depotCode,
    state: order.state,
    accountNumber: order.virtualAccountNumber,
    bankName: order.virtualAccountBank,
    accountName: order.virtualAccountName,
  };

  if (order.customerEmail) {
    try {
      await sendOrderInvoiceEmail(order.customerEmail, invoice);
      emailSent = true;
    } catch (err) {
      console.error("[setOrderPrice] invoice email failed (order IS priced):", err.message);
    }
  }
  if (order.customerPhone) {
    try {
      const sms = await sendOrderSummarySMS(order.customerPhone, invoice);
      smsSent = Boolean(sms?.success);
    } catch (err) {
      console.error("[setOrderPrice] invoice SMS failed (order IS priced):", err.message);
    }
  }

  const sentTo = [emailSent && "email", smsSent && "SMS"].filter(Boolean).join(" and ");
  res.json({
    success: true,
    message: `Priced at ₦${price.toLocaleString()} — ₦${Number(order.totalAmount).toLocaleString()} ${
      sentTo ? `invoiced by ${sentTo}` : "now invoiceable (the customer could not be messaged)"
    }`,
    data: { order, invoice: { emailSent, smsSent } },
  });
});

/** Credit may be authorised while an order can still take product out. */
const CREDITABLE = new Set(["Pending", "Paid", "Released", "Loading"]);

/**
 * Trust this order for a quantity it has not paid for.
 *
 * The depot writes tickets by hand before payment — a customer arrives, a paper
 * ticket is written, the truck loads and goes, and the money follows. The system
 * could not express that: releasableQuantity() returns what the RECEIVED money
 * covers, so an unpaid order could be ticketed for nothing.
 *
 * This does not relax that. It records an explicit, named, reasoned allowance
 * beside it, which releasableQuantity then ADDS to the paid share. The
 * difference matters: an order nobody has authorised behaves exactly as it
 * always did, and every litre released ahead of payment has a person's name
 * against it and a sentence saying why.
 *
 * Finance-gated rather than ticketing-gated on purpose. Cutting a ticket is the
 * loading desk's act; deciding this customer may owe us for a truckload is not,
 * and the desk standing in front of the customer is the worst-placed person to
 * be making it.
 *
 * Idempotent in the useful sense: calling it again REPLACES the allowance
 * rather than adding to it, so a figure typed wrong is corrected by sending the
 * right one, not by working out the difference.
 */
const authoriseCreditRelease = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const quantity = Number(req.body.quantity);
  const reason = String(req.body.reason || "").trim();
  const actor = { type: "staff", staffId: req.user.id };
  const audit = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

  const result = await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");
    if (!CREDITABLE.has(order.status)) {
      throw httpErr(409, `Order is ${order.status}; credit cannot be authorised on it`);
    }
    if (!reason) throw httpErr(400, "A reason is required to release on credit");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw httpErr(400, "The quantity to trust must be greater than zero");
    }
    if (quantity > Number(order.quantity)) {
      throw httpErr(
        400,
        `Cannot trust ${quantity.toLocaleString()} on an order of ${Number(order.quantity).toLocaleString()}`,
      );
    }

    const previous = Number(order.creditQty ?? 0);
    const updated = await orderRepo.update(
      orderId,
      {
        creditQty: String(quantity),
        creditReason: reason,
        creditAuthorisedBy: req.user.id,
        creditAuthorisedAt: new Date(),
      },
      tx,
    );

    /**
     * A Pending order has to reach Released to be ticketed at all (TICKETABLE),
     * and that is the whole point of authorising it. An order already past
     * Pending is left where it is — this grants an allowance, it does not move
     * an order backwards or forwards through its own lifecycle.
     */
    let releasedNow = false;
    if (order.status === "Pending") {
      await orderStatus.transition(orderId, "Released", {
        tx,
        actor,
        set: { releasedAt: new Date(), releasedBy: req.user.id },
        metadata: { trigger: "credit", quantity, reason },
        ...audit,
      });
      releasedNow = true;
    }

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.credit_authorised",
        actor,
        metadata: {
          quantity,
          previous,
          reason,
          orderQuantity: Number(order.quantity),
          outstanding: Number(order.totalAmount) - Number(order.amountPaid ?? 0),
          releasedNow,
        },
        ...audit,
      },
      tx,
    );

    return { order: updated, releasedNow };
  });

  const order = await orderRepo.findByIdFull(orderId);
  res.json({
    success: true,
    message: `Trusted for ${quantity.toLocaleString()} ${result.releasedNow ? "— order released for loading" : ""}`.trim(),
    data: { order, releasableQuantity: orderService.releasableQuantity(order) },
  });
});

/**
 * Withdraw the allowance.
 *
 * Refused once trucks have been ticketed against it, and that refusal is the
 * important part: revoking below what has already been authorised on paper
 * would leave loads on the order that the order itself says were never allowed
 * — a contradiction nothing downstream could resolve. Pay the order down or
 * cancel the loads first.
 */
const revokeCreditRelease = asyncHandler(async (req, res) => {
  const orderId = Number(req.params.id);
  const reason = String(req.body.reason || "").trim();
  const actor = { type: "staff", staffId: req.user.id };
  const audit = { ipAddress: req.ip, userAgent: req.headers["user-agent"] };

  await db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpErr(404, "Order not found");

    const previous = Number(order.creditQty ?? 0);
    if (previous <= 0) throw httpErr(409, "This order carries no credit allowance");
    if (!reason) throw httpErr(400, "A reason is required to withdraw credit");

    // What the money alone would permit, once the allowance is gone.
    const withoutCredit = orderService.releasableQuantity({ ...order, creditQty: 0 });
    const loads = await orderTruckRepo.findByOrder(orderId, tx);
    const ticketed = loads.reduce((sum, l) => sum + Number(l.quantity || 0), 0);

    if (ticketed > withoutCredit) {
      throw httpErr(
        409,
        `${ticketed.toLocaleString()} is already ticketed on this order and only ${withoutCredit.toLocaleString()} is paid for. Settle the balance or remove those loads before withdrawing the credit.`,
      );
    }

    await orderRepo.update(
      orderId,
      { creditQty: "0", creditReason: "", creditAuthorisedBy: null, creditAuthorisedAt: null },
      tx,
    );

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: orderId,
        action: "order.credit_revoked",
        actor,
        metadata: { previous, reason, ticketed },
        ...audit,
      },
      tx,
    );
  });

  const order = await orderRepo.findByIdFull(orderId);
  res.json({
    success: true,
    message: "Credit withdrawn",
    data: { order, releasableQuantity: orderService.releasableQuantity(order) },
  });
});

/**
 * GET /orders/:id/merges — what this order was merged from or into, and which
 * of the customer's other orders could be folded into it. Read-only.
 */
const getOrderMerges = asyncHandler(async (req, res) => {
  const data = await orderMergeService.mergeOverview(Number(req.params.id));
  res.json({ success: true, data });
});

/**
 * POST /orders/:id/merge/preview — what folding these orders into this one
 * would do, from the same code the merge runs. Nothing is written.
 */
const previewOrderMerge = asyncHandler(async (req, res) => {
  const data = await orderMergeService.previewMerge({
    targetOrderId: Number(req.params.id),
    sourceOrderIds: req.body.sourceOrderIds,
  });
  res.json({ success: true, data });
});

/**
 * POST /orders/:id/merge — fold the given orders into this one.
 *
 * Finance-gated like every other route that moves payment rows between
 * orders: this one moves all of them.
 */
const mergeOrders = asyncHandler(async (req, res) => {
  const result = await orderMergeService.mergeOrders({
    targetOrderId: Number(req.params.id),
    sourceOrderIds: req.body.sourceOrderIds,
    reason: req.body.reason,
    staffId: req.user.id,
  });
  const n = result.merged.length;
  res.json({
    success: true,
    message: `${n} order${n === 1 ? "" : "s"} merged into ${result.target.reference}. Their payments, trucks and tickets are now on it.`,
    data: result,
  });
});

module.exports = {
  getOrderMerges,
  previewOrderMerge,
  mergeOrders,
  getReceivables,
  setOrderPrice,
  authoriseCreditRelease,
  revokeCreditRelease,
  getOrders,
  getOrderById,
  createOrder,
  updateOrder,
  releaseOrder,
  cancelOrder,
  generateOrderTickets,
  getTruckTicketPrintData,
  getOrderTrucks,
  gateInTruck,
  markTruckLoaded,
  updateTruckLoad,
  gateOutTruck,
  getPayableOrders,
  deleteOrder,
  confirmOrderPayment,
  getOrderPayments,
  getOrderTimeline,
  removeOrderPayment,
  transferOrderPayment,
  reverseOrderPaymentTransfer,
  reviewOrderPayment,
  reviewOrderPaymentTransfer,
  getPaymentReviewQueue,
  getOrdersWithSurplus,
  reconcileOrderEffects,
};
