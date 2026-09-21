const { v4: uuidv4 } = require("uuid");
const { eq, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { orders, commissions, pfiMovements, pfis } = require("../db/schema");
const {
  orderRepo,
  customerRepo,
  depotRepo,
  productRepo,
  pfiRepo,
  orderTruckRepo,
  orderPfiAllocationRepo,
  auditLogRepo,
  bankAccountRepo,
  commissionRepo,
} = require("../repositories");
const { isWithinScope } = require("../lib/scopeFilter");
const walletService = require("./wallet.service");
// Order payments are the money path (see db/migrations/0021). walletService
// survives above only for the legacy holds that historical orders still carry
// — nothing here places a new one.
const orderPaymentService = require("./orderPayment.service");
// Paystack DVA creation/subaccount-switch and the auto-split transfer are
// disabled — see the "Paystack DVA funding (disabled...)" block below and
// runPostPaymentEffects(). Re-add this import if reinstating either:
// const { createDedicatedAccount, transferToDepotSubaccount, switchCustomerDvaToSubaccount } = require("./payment.service");
const { sendOrderInvoiceEmail } = require("./email.service");
const { sendOrderSummarySMS, sendOrderExpiredSMS } = require("./sms.service");
const { notify } = require("../notifications");
const { findPfiForOrder } = require("./pfi.service");
const { generateTicketForOrder } = require("./ticket.service");
const orderStatus = require("./orderStatus.service");
const commissionService = require("./commission.service");
const { QUEUES, enqueue } = require("../config/queue");

const notifyWhatsAppPaymentConfirmed = (orderId) => {
  if (process.env.WHATSAPP_ENABLED !== "true") return;
  enqueue(QUEUES.WA_EVENTS, { type: "payment_confirmed", orderId }).catch((err) =>
    console.error("[wa] payment-confirmed enqueue failed:", err.message)
  );
};

const { orderExpiryHours, orderExpiryMs, orderExpiryDisabled } = require("../config/orderExpiry");

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Naira, to the kobo. Keeps instalment arithmetic off binary-float drift. */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * The statuses an order can take money in.
 *
 * Pending is the first payment. Paid/Released/Loading are the later instalments
 * of a part-paid order — it has already been through releaseOnPayment, so it is
 * sitting on the ticketing desk with a balance still owing. Completed,
 * Cancelled and Expired are not here on purpose: an order that has finished,
 * been called off, or lapsed must not quietly accept more money.
 */
/**
 * The statuses in which money may still be recorded against an order.
 *
 * `Completed` is here because money does not stop arriving when the last truck
 * leaves, and because the record has to stay correctable after delivery. Two
 * live cases forced it: VG11105 is carried as Paid on a cached figure
 * ₦25,326,000 larger than the payment rows behind it, and the desk could not
 * attach the lines that would close the gap; and an order whose lines were
 * unmatched after delivery (they had been matched to the wrong order) could
 * not then be given the right ones. In both, the money is real and the desk
 * has the statement line in hand — refusing to record it does not make the
 * order more accurate, only less.
 *
 * Cancelled and Expired stay out, and are refused explicitly below: an order
 * nobody is fulfilling should not be quietly funded, and a lapsed one must be
 * re-placed at current prices rather than paid at a stale one.
 */
const PAYABLE_STATUSES = new Set(["Pending", "Paid", "Released", "Loading", "Completed"]);

/**
 * How much of an order may be ticketed, given what has been paid for it.
 *
 * The rule the desk asked for: pay for 50,000 of a 100,000-litre order and you
 * may cut tickets for 50,000 litres, not the whole order. Pay the rest later
 * and the remainder unlocks. Quantity is the unit trucks are loaded in, so the
 * money figure has to be converted back through the order's own unit price.
 *
 * Two rounding decisions, both deliberate:
 *
 *   - Floored to 2dp, never rounded up. order_trucks.quantity is decimal(15,2),
 *     so 2dp is the finest a load can actually be written at, and rounding up
 *     would authorise litres nobody has paid for. A part payment of ₦12,000,000
 *     at ₦241/litre buys 49,792.53 litres, not 49,792.54.
 *
 *   - A fully-paid order returns its quantity EXACTLY, rather than the division.
 *     total_amount is stored, not recomputed, so on an order whose total was
 *     rounded at creation the division can land a hair under the quantity —
 *     which would leave the last few litres of a fully-paid order permanently
 *     unticketable. Nobody would ever find that by reading the number; they
 *     would just find a truck they could not load.
 *
 * Legacy orders are unaffected: migration 0020 backfilled amount_paid =
 * total_amount for everything already Paid, so this returns their full
 * quantity, which is exactly the ceiling that was in force before.
 */
function releasableQuantity(order) {
  const quantity = Number(order.quantity);
  const paid = Number(order.amountPaid ?? 0);
  const total = Number(order.totalAmount);
  const price = Number(order.price);
  /**
   * The authorised-on-credit allowance, ADDED to what the money buys.
   *
   * Added rather than substituted, so the two sources of permission compose:
   * an order that has paid for 20,000 and is trusted for 25,000 may load
   * 45,000, and a later payment widens nothing by itself — the paid share
   * simply grows underneath the same total. Substituting would have made
   * authorising credit on a part-paid order silently REDUCE what it could
   * load, which is the opposite of what the person granting it intended.
   *
   * Zero on every order nobody has authorised, which is all of them until
   * somebody does — so the behaviour below is exactly what it was before.
   */
  const credit = Number(order.creditQty ?? 0);

  /**
   * A settled order releases in full — and that is decided by the order's own
   * declared status FIRST, before any arithmetic on amount_paid.
   *
   * paymentStatus is the older, and still the authoritative, statement that an
   * order has been paid for; amount_paid is a column this change introduced.
   * Reading only the arithmetic meant any writer that marks an order Paid
   * without also setting amount_paid produced a releasable quantity of ZERO —
   * a fully-paid order that could never be ticketed at all. The settlement
   * sweep in payment.service.js was exactly such a writer (now fixed to set
   * both), and every test fixture that inserts a paid order directly is
   * another. Trusting the status closes the whole class: a future writer that
   * forgets amount_paid degrades to today's behaviour instead of silently
   * bricking the ticketing desk.
   */
  if (order.paymentStatus === "Paid" || paid >= total) return quantity;

  /**
   * A priceless order releases only what it was trusted for.
   *
   * The paid share cannot be computed without a unit price, but the credit
   * allowance is a quantity already and needs no conversion — so an order with
   * a broken price still honours an explicit authorisation instead of
   * returning zero and stranding a truck somebody was told to load.
   */
  if (!(price > 0)) return Math.min(quantity, credit);

  const paidFor = Math.floor((paid / price) * 100) / 100;
  return Math.min(quantity, paidFor + credit);
}

/**
 * Has this order lapsed? Only a still-Pending, still-unpaid order can — once a
 * transfer or wallet settles it, the order is Paid and never expires.
 */
function isOrderExpired(order, now = Date.now()) {
  return (
    !orderExpiryDisabled() &&
    order.status === "Pending" &&
    // Only a wholly unfunded order may lapse. Tested as "is Unpaid" rather
    // than "is not Paid" because a Part Paid order HAS been funded — money is
    // held against it and it may already have been ticketed — and lapsing it
    // would strand that payment on an expired order.
    order.paymentStatus === "Unpaid" &&
    now - new Date(order.createdAt).getTime() >= orderExpiryMs()
  );
}

/**
 * Compute the expiration deadline for an order. Returns an ISO string if the
 * order is Pending and unpaid; null otherwise (Paid/Released/Completed orders
 * never expire, Expired/Cancelled orders already have expiredAt) — and null
 * whenever the expiry mechanism itself is switched off, so the frontend stops
 * showing a countdown that will never actually lapse anything.
 */
function computeExpiresAt(order) {
  if (orderExpiryDisabled()) return null;
  // Part Paid counts as funded here, same as Paid: money is held against the
  // order, so there is no countdown left to show.
  if (order.status !== "Pending" || order.paymentStatus !== "Unpaid") return null;
  const created = new Date(order.createdAt).getTime();
  return new Date(created + orderExpiryMs()).toISOString();
}

/**
 * Enrich an order (or array of orders) with a computed `expiresAt` field — the
 * deadline before which the customer must pay. The frontend uses this directly
 * for the countdown badge instead of knowing ORDER_EXPIRY_HOURS.
 *
 * For single orders, also checks if the deadline has passed and immediately
 * expires the order before returning it. This ensures the frontend never sees
 * an order in the "imminent" window (deadline passed but not yet swept).
 */
async function withExpiresAt(orderOrOrders) {
  if (Array.isArray(orderOrOrders)) {
    const results = [];
    for (const o of orderOrOrders) {
      results.push(await expireAndAttach(o));
    }
    return results;
  }
  return expireAndAttach(orderOrOrders);
}

/**
 * Internal helper: expire an order if past its deadline, then attach expiresAt.
 */
async function expireAndAttach(order) {
  // If pending and wholly unfunded, check if deadline has passed. A Part Paid
  // order is funded and must not lapse — see isOrderExpired.
  if (!orderExpiryDisabled() && order.status === "Pending" && order.paymentStatus === "Unpaid") {
    const deadline = new Date(order.createdAt).getTime() + orderExpiryMs();
    if (Date.now() >= deadline) {
      try {
        const expired = await expireOrder(order.id);
        return { ...expired, expiresAt: null };
      } catch {
        // Already expired or concurrent update — fall through with original
      }
    }
  }
  return { ...order, expiresAt: computeExpiresAt(order) };
}

/**
 * Place an order — the ONE creation path, shared by the desk
 * (POST /api/orders) and the customer portal (POST /api/customer/orders).
 *
 * The only thing that differs between the two callers is WHO the customer is:
 * the desk passes a body customer id, the portal passes the authenticated
 * customer's own id. Everything else — server-side pricing, the depot's
 * payment account, the single atomic reserve→debit→create→ledger
 * transaction, the wallet-pays Pending→Paid transition, and the best-effort
 * invoice email/SMS — is identical, so it lives here once.
 *
 * Throws httpError(4xx) for a bad request (unknown depot, no price, no stock,
 * no payment account); the caller's asyncHandler renders it. External work
 * (email, SMS) stays OUTSIDE the DB transaction — a transaction must never be
 * held open across an HTTP call to a third party.
 *
 * @param {object} input
 * @param {number} input.customerId
 * @param {string} input.state
 * @param {number} input.depotId
 * @param {number} input.productId
 * @param {number} input.quantity
 * @param {"delivery"|"pickup"} input.deliveryType
 * @param {string} [input.deliveryAddress]
 *        Delivery only: where the truck goes, in the customer's words.
 *        Ignored for pickup — the depot is the address.
 * @param {Array<{truckNumber?: string, quantity: number, driverName?: string, driverPhone?: string}>} [input.trucks]
 *        Pickup only: the customer's declared trucks and the quantity on each.
 *        Their quantities must sum to the order quantity; each ≤ 60,000 L.
 * @param {{type: "staff"|"customer"|"system", staffId?: number, customerId?: number}} [input.actor]
 *        Who is placing the order — recorded on the order.created audit row.
 * @param {string|null} [input.idempotencyKey]
 *        Dedupe key for redeliverable requests (WhatsApp passes the wamid).
 *        Same key twice → the original order back, alreadyProcessed: true.
 * @returns {{ order: object, payment: object, isPaidWithWallet: boolean, alreadyProcessed?: boolean }}
 */

/** The answer an idempotent replay gets: the original order, not a new one. */
async function replayResult(orderId) {
  const fullOrder = await orderRepo.findByIdFull(orderId);
  return {
    order: fullOrder,
    isPaidWithWallet: fullOrder.paymentStatus === "Paid",
    alreadyProcessed: true,
    payment: {
      accountNumber: fullOrder.virtualAccountNumber,
      bankName: fullOrder.virtualAccountBank,
      accountName: fullOrder.virtualAccountName,
      emailSent: false,
      smsSent: false,
    },
  };
}

/**
 * How long an identical order counts as the same tap rather than a new order.
 *
 * Ninety seconds: long enough to cover a slow network and a customer tapping
 * again because nothing happened, short enough that a real second load placed
 * a couple of minutes later still goes through.
 */
const DUPLICATE_WINDOW_SECONDS = Number(process.env.ORDER_DUPLICATE_WINDOW_SECONDS || 90);

// Only the idempotency-key index counts — an orderNumber collision (or any
// other 23505) must still surface as the error it is.
const isIdempotencyConflict = (err) => {
  const code = err?.code || err?.cause?.code;
  const constraint = err?.constraint_name || err?.cause?.constraint_name || "";
  return code === "23505" && constraint === "orders_idempotency_key_idx";
};

async function placeOrder({
  customerId,
  state,
  depotId,
  productId,
  quantity,
  deliveryType,
  deliveryAddress,
  companyName,
  /**
   * How many trucks the order is expected to take. Stated up front so every
   * count afterwards is against a number somebody gave — see the column note
   * on orders.expectedTrucks. Null is a legitimate answer.
   */
  expectedTrucks,
  trucks,
  actor = { type: "system" },
  // Callers whose requests can be redelivered (the WhatsApp CONFIRM step
  // passes the inbound message's wamid) supply a key; a second call with the
  // same key returns the original order instead of creating a duplicate.
  idempotencyKey = null,
}) {
  if (idempotencyKey) {
    const existing = await orderRepo.findByIdempotencyKey(idempotencyKey);
    if (existing) return replayResult(existing.id);
  }

  /**
   * The same order again, seconds later, is a double-tap — not a second order.
   *
   * An idempotency key only protects a client that sends one AND reuses it on
   * retry. The portal and the app send none at all, so every tap created an
   * order: one customer produced eight identical 10,000-litre orders in 58
   * seconds on 16 September, 14 across the morning, and somebody had to delete
   * them by hand afterwards.
   *
   * Nothing the client sends can be relied on here — a fresh key per tap
   * defeats the check above, and a customer tapping because the first tap
   * showed no feedback is the ordinary case, not an edge one. So the guard is
   * on the FACTS of the order: same customer, same depot, same product, same
   * quantity, same delivery type, inside a short window.
   *
   * It returns the order they already placed rather than an error. An error is
   * what makes somebody tap again — and they are not wrong to think it failed,
   * because from where they are sitting it looks identical to a failure.
   *
   * The window is deliberately short. A customer genuinely buying two
   * identical loads an hour apart is real business and must go through; two
   * within ninety seconds is a finger, not a decision.
   */
  /**
   * Best-effort, and that asymmetry is deliberate.
   *
   * If this check throws — an unexpected delivery type, a database hiccup —
   * the order must still be placed. A duplicate is visible and deletable in a
   * click; an order silently refused because a GUARD broke is money the
   * customer thinks they have spent and nobody has a record of.
   */
  let recent = null;
  try {
    recent = await orderRepo.findRecentDuplicate({
      customerId,
      depotId,
      productId,
      quantity,
      deliveryType,
      withinSeconds: DUPLICATE_WINDOW_SECONDS,
    });
  } catch (err) {
    console.error("[placeOrder] duplicate check failed, placing anyway:", err.message);
  }
  if (recent) {
    console.warn(
      `[placeOrder] duplicate suppressed: customer ${customerId} re-sent the same order `
      + `within ${DUPLICATE_WINDOW_SECONDS}s — returning order ${recent.id}`,
    );
    return { ...(await replayResult(recent.id)), deduplicated: true };
  }

  const customer = await customerRepo.findById(customerId);
  if (!customer) {
    throw httpError(404, "Customer not found");
  }

  const depot = await depotRepo.findById(depotId);
  if (!depot) {
    throw httpError(404, "Depot not found");
  }

  /* --- Paystack DVA funding (disabled — manual deposit only) ---------------
   * Every customer used to get a personal Dedicated Virtual Account (DVA) on
   * first order, immediately split to the depot's Paystack subaccount so
   * funds settled straight there. Wallet funding is manual-deposit-only now
   * (staff record deposits from the admin dashboard against the depot's own
   * bank account, looked up below) — this whole path is parked, not deleted.
   * To reinstate: restore this block, drop the depot-bank-account lookup
   * beneath it, and uncomment the payment.service.js import above.
   *
   * let virtualAccountNumber = customer.virtualAccountNumber || "";
   * let virtualAccountBank = customer.virtualAccountBank || "";
   * let virtualAccountName = customer.virtualAccountName || "";
   *
   * if (!virtualAccountNumber) {
   *   const accountResult = await createDedicatedAccount(customer);
   *   if (accountResult.success) {
   *     virtualAccountNumber = accountResult.data.accountNumber;
   *     virtualAccountBank = accountResult.data.bankName;
   *     virtualAccountName =
   *       accountResult.data.accountName || formatVirtualAccountName(customer.name);
   *     const updateData = { virtualAccountNumber, virtualAccountBank, virtualAccountName };
   *     if (accountResult.data.paystackCustomerId) {
   *       updateData.paystackCustomerId = accountResult.data.paystackCustomerId;
   *     }
   *     await customerRepo.update(customerId, updateData);
   *   } else {
   *     throw httpError(
   *       400,
   *       "Customer has no dedicated payment account and one could not be generated. Please try again or contact support."
   *     );
   *   }
   * } else if (!virtualAccountName) {
   *   virtualAccountName = formatVirtualAccountName(customer.name);
   *   await customerRepo.update(customerId, { virtualAccountName });
   * }
   *
   * // Automatically switch customer DVA to depot Paystack Subaccount
   * const depotSubaccountCode = depot.paystackSubaccountCode || depot.paystack_subaccount_code;
   * if (virtualAccountNumber && depotSubaccountCode) {
   *   try {
   *     await switchCustomerDvaToSubaccount({
   *       accountNumber: virtualAccountNumber,
   *       subaccountCode: depotSubaccountCode,
   *     });
   *     await customerRepo.update(customerId, { dvaSubaccountCode: depotSubaccountCode });
   *   } catch (dvaErr) {
   *     console.error(`[placeOrder] Failed to switch DVA to subaccount for depot ${depotId}:`, dvaErr.message);
   *   }
   * }
   * --------------------------------------------------------------------- */

  // The account the customer pays into is the depot's own bank account, set
  // up by an admin on the dashboard (Bank Accounts, linked to this depot) —
  // not a per-customer virtual account. Every order at this depot shows the
  // same account; the default one wins when more than one is linked.
  const depotBankAccounts = await bankAccountRepo.findAll({ depotId: depot.id, status: "Active" });
  const depotBankAccount = depotBankAccounts.find((a) => a.isDefault) || depotBankAccounts[0];
  if (!depotBankAccount) {
    throw httpError(
      400,
      "No payment account has been set up for this depot yet. Please contact support."
    );
  }
  const virtualAccountNumber = depotBankAccount.accountNumber;
  const virtualAccountBank = depotBankAccount.bankName;
  const virtualAccountName = depotBankAccount.accountName;

  const product = await productRepo.findById(productId);
  if (!product) {
    throw httpError(404, "Product not found");
  }

  // Server-side pricing — the client never supplies price/total.
  const priceEntry = await depotRepo.getProductPrice(depotId, productId);
  if (!priceEntry || Number(priceEntry.currentPrice) <= 0) {
    throw httpError(400, "No price configured for this product at this depot");
  }
  const serverPrice = Number(priceEntry.currentPrice);
  const totalAmount = serverPrice * Number(quantity);

  // Stock no longer gates a sale — a price does (see catalog.service). We
  // still reserve against whatever active PFI stock exists, so PFI accounting
  // stays exact wherever batches ARE being tracked; a depot with none simply
  // reserves nothing and the order carries no PFI. This used to throw
  // "Insufficient stock in depot", which made a freshly priced depot
  // unorderable even though the site offered it.
  const { allocations } = await findPfiForOrder(depotId, productId, quantity);

  // --- Pickup truck declaration ---------------------------------------------
  // A pickup customer brings their own trucks and may split the order across
  // several. Declaring them at order time is optional at every quantity —
  // security still captures each arriving truck at the gate. When a split IS
  // declared it must be coherent: quantities sum to the order, each truck ≤
  // one tanker (60,000 L). The plate is optional (filled or corrected at the
  // gate and at ticketing). Delivery orders never carry trucks at order time
  // — their fleet is allocated at release.
  const declaredTrucks = Array.isArray(trucks) ? trucks : [];
  if (deliveryType === "delivery" && declaredTrucks.length) {
    throw httpError(400, "Delivery trucks are allocated at release, not at order");
  }
  if (deliveryType === "pickup" && declaredTrucks.length) {
    const sum = declaredTrucks.reduce((s, t) => s + Number(t.quantity), 0);
    if (sum !== Number(quantity)) {
      throw httpError(
        400,
        `The truck quantities (${sum.toLocaleString()} L) must sum to the order quantity (${Number(
          quantity
        ).toLocaleString()} L)`
      );
    }
    const tooBig = declaredTrucks.find((t) => Number(t.quantity) > 60000);
    if (tooBig) {
      throw httpError(400, "Each truck can carry at most 60,000 L — split the load across more trucks");
    }
  }

  const orderNumber = `ORD-${uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase()}`;

  // --- Atomic order creation -------------------------------------------------
  // Stock reservation, the order row and the declared pickup loads are ONE
  // unit: a failure anywhere rolls all of it back. Orders
  // are always created Unpaid — payment happens later via a manual "Pay Now"
  // action (staff or customer) that places a wallet hold.
  let order;
  try {
    ({ order } = await db.transaction(async (tx) => {
    // Reserve stock from each PFI in the allocation list. If any PFI runs
    // out concurrently the transaction rolls back — no partial reservations.
    const reservedPfis = [];
    for (const alloc of allocations) {
      const updatedPfi = await pfiRepo.reserveStock(alloc.pfi.id, alloc.quantity, tx);
      if (!updatedPfi) {
        throw httpError(
          400,
          `Insufficient stock in PFI ${alloc.pfi.pfiNumber || alloc.pfi.id} (may have been claimed by another order)`
        );
      }
      await pfiRepo.markFinishedIfComplete(updatedPfi.id, tx);
      reservedPfis.push({ pfiId: updatedPfi.id, quantity: alloc.quantity });
    }

    const created = await orderRepo.create(
      {
        orderNumber,
        customerId,
        state,
        depotId,
        productId,
        // Null when the depot tracks no active PFI. The column is nullable and
        // every reader (release, tickets, queues, reports) already left-joins
        // or guards on it.
        pfiId: reservedPfis[0]?.pfiId ?? null,
        quantity: Number(quantity),
        price: String(serverPrice),
        totalAmount: String(totalAmount),
        deliveryType,
        deliveryAddress:
          deliveryType === "delivery" && typeof deliveryAddress === "string"
            ? deliveryAddress.trim()
            : "",
        companyName: typeof companyName === "string" ? companyName.trim() : "",
        // Only a positive whole number, or nothing. A zero would read as "no
        // trucks needed" on an order that plainly needs some.
        expectedTrucks:
          Number.isFinite(Number(expectedTrucks)) && Number(expectedTrucks) > 0
            ? Math.trunc(Number(expectedTrucks))
            : null,
        status: "Pending",
        paymentStatus: "Unpaid",
        virtualAccountNumber,
        virtualAccountBank,
        virtualAccountName,
        idempotencyKey,
      },
      tx
    );

    // Record per-PFI allocations so cancel/expire can release correctly.
    if (reservedPfis.length > 0) {
      await orderPfiAllocationRepo.create(reservedPfis, created.id, tx);
    }

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: created.id,
        action: "order.created",
        actor,
        metadata: {
          orderNumber,
          deliveryType,
          quantity: Number(quantity),
          totalAmount: String(totalAmount),
        },
      },
      tx
    );

    // Pickup: materialise the customer's declared trucks as pending loads now,
    // one row per truck (plate + its quantity), inside the same transaction.
    // The gate flow later flips each to gated_in → loaded → gated_out, and the
    // plate can be corrected at the gate and at ticketing. Delivery declares no
    // trucks here (allocated at release).
    for (let i = 0; i < declaredTrucks.length; i += 1) {
      const t = declaredTrucks[i];
      const load = await orderTruckRepo.create(
        {
          orderId: created.id,
          truckIndex: i + 1,
          truckId: null,
          truckNumber: t.truckNumber || null,
          quantity: String(t.quantity),
          driverName: t.driverName || null,
          driverPhone: t.driverPhone || null,
          status: "pending",
        },
        tx
      );
      await auditLogRepo.record(
        {
          entityType: "order_truck",
          entityId: load.id,
          action: "order_truck.allocated",
          actor,
          metadata: { orderId: created.id, truckIndex: i + 1, truckNumber: load.truckNumber, quantity: String(t.quantity), via: "pickup-declaration" },
        },
        tx
      );
    }

    return { order: created };
    }));
  } catch (err) {
    if (idempotencyKey && isIdempotencyConflict(err)) {
      const existing = await orderRepo.findByIdempotencyKey(idempotencyKey);
      if (existing) return replayResult(existing.id);
    }
    throw err;
  }

  // CRITICAL: the order is already committed above. Nothing from here on may
  // throw, or the caller sees a failure for an order that actually exists —
  // and the WhatsApp flow, told "no charge", lets the customer re-tap into a
  // SECOND real order (a fresh wamid = a fresh idempotency key). So the
  // post-commit read falls back to the committed row, and the notifications
  // below are each isolated. Everything the caller needs (reference, totals,
  // the deposit account) is present on `order` itself.
  const fullOrder = (await orderRepo.findByIdFull(order.id).catch((err) => {
    console.error("[placeOrder] post-commit findByIdFull failed (order IS created):", err.message);
    return null;
  })) || order;

  // The reference every surface shows — "SO600", not the raw ORD-… column.
  //
  // `orderNumber` in this scope is the opaque internal value minted at line
  // ~305, before the row (and therefore its id) existed. It must never reach a
  // customer: the app, portal, admin dashboard and WhatsApp all render the
  // computed reference, so an invoice or SMS quoting ORD-BB464940706C names an
  // order the customer cannot find on any screen. findByIdFull() applies the
  // same decoration every other read path does.
  const reference = fullOrder.orderNumber;

  if (customer.email) {
    try {
      await sendOrderInvoiceEmail(customer.email, {
        orderNumber: reference,
        orderDate: order.createdAt,
        customerName: customer.name,
        companyName: customer.companyName,
        customerPhone: customer.phone,
        product: fullOrder.productName || "N/A",
        sku: fullOrder.productSku || "",
        quantity: order.quantity,
        unit: fullOrder.productUnit || "Liters",
        price: order.price,
        totalAmount: order.totalAmount,
        deliveryType: order.deliveryType,
        depotName: depot.name,
        depotCode: depot.code,
        state: order.state,
        accountNumber: virtualAccountNumber,
        bankName: virtualAccountBank,
        accountName: virtualAccountName,
      });
    } catch (emailErr) {
      console.error("Failed to send invoice email:", emailErr.message);
    }
  }

  let smsSent = false;
  try {
    const smsResult = await sendOrderSummarySMS(customer.phone, {
      orderNumber: reference,
      customerName: customer.name,
      product: fullOrder.productName || "N/A",
      quantity: order.quantity,
      unit: fullOrder.productUnit || "Liters",
      // The rate the order was struck at. The text used to name a quantity and
      // a total and leave the customer to divide one by the other; it is the
      // first thing he checks, so it is now in the sentence.
      price: order.price,
      totalAmount: order.totalAmount,
      accountNumber: virtualAccountNumber,
      bankName: virtualAccountBank,
      accountName: virtualAccountName,
    });
    smsSent = smsResult.success;
    if (!smsSent) console.error("Failed to send order SMS:", smsResult.message);
  } catch (smsErr) {
    console.error("Failed to send order SMS:", smsErr.message);
  }

  // The invoice email and payment SMS above stay exactly as they are — they
  // are transactional documents whose layout and wording are the point. This
  // adds the inbox row and the push that were missing, so the order also shows
  // up in the app. The catalog entry is APP_ONLY for precisely that reason: it
  // must not re-send what the two calls above already sent.
  //
  // Wrapped: a notify() failure (queue hiccup) must not throw out of a
  // committed placeOrder — see the post-commit note above.
  try {
    notify("order.created", {
      to: { customer },
      data: {
        orderId: order.id,
        orderNumber: reference,
        reference,
        customerName: customer.name,
        product: fullOrder.productName || "",
        quantity: order.quantity,
        unit: fullOrder.productUnit || "Liters",
        price: order.price,
        totalAmount: order.totalAmount,
        depotName: depot.name,
        deliveryType: order.deliveryType,
      },
    });

    // Sales and finance want to see the order land without watching the list.
    notify("staff.order_placed", {
      to: { roles: ["admin", "super_admin", "sales_manager", "finance_manager"] },
      data: {
        orderId: order.id,
        orderNumber: reference,
        reference,
        customerName: customer.name,
        product: fullOrder.productName || "",
        quantity: order.quantity,
        unit: fullOrder.productUnit || "Liters",
        totalAmount: order.totalAmount,
        depotName: depot.name,
      },
    });
  } catch (notifyErr) {
    console.error("[placeOrder] post-commit notify failed (order IS created):", notifyErr.message);
  }

  return {
    order: fullOrder,
    isPaidWithWallet: false,
    payment: {
      accountNumber: virtualAccountNumber,
      bankName: virtualAccountBank,
      accountName: virtualAccountName,
      emailSent: !!customer.email,
      smsSent,
    },
  };
}

/**
 * Release reserved stock, delete truck loads, and release any wallet hold for
 * a cancelled or expired order. Shared by cancelOrder and expireOrder so the
 * restitution logic lives in one place.
 */
async function releaseOrderResources(order, tx) {
  if (order.pfiId) {
    const allocations = await orderPfiAllocationRepo.findByOrderId(order.id, tx);
    if (allocations.length > 0) {
      for (const alloc of allocations) {
        await pfiRepo.releaseStock(alloc.pfiId, alloc.quantity, tx);
      }
      await orderPfiAllocationRepo.deleteByOrderId(order.id, tx);
    } else {
      // Fallback for orders created before multi-PFI
      await pfiRepo.releaseStock(order.pfiId, order.quantity, tx);
    }
  }
  await orderTruckRepo.deleteByOrder(order.id, tx);
  /**
   * Legacy only, and a no-op on anything paid since migration 0021 — those
   * orders have no hold, and releaseHold returns noActiveHold harmlessly.
   *
   * Note what is deliberately NOT done here: a cancelled order KEEPS its
   * payments. The money was genuinely received against this order, and
   * detaching it on cancellation is how it used to vanish back into a wallet
   * with nothing naming where it came from. It stays on the order, visible as
   * surplus, until somebody transfers it to another order or refunds it — on
   * the record, either way.
   */
  await walletService.releaseHold(order.id, tx);
}

// Once an order is finished or dead there is nothing left to correct — with
// one exception, below: which cargo a completed order was lifted from is a
// fact that can be recorded wrongly and has to be correctable afterwards.
const EDIT_LOCKED_STATUSES = new Set(["Completed", "Cancelled", "Expired"]);

/**
 * Quantity backs a physical stock reservation that live tickets are cut
 * against, so it stops being editable the moment release captures a truck
 * allocation. Changing it under a ticket that already names a real gate
 * action desyncs the two.
 *
 * Everything else about the order (customer, date, price, logistics text)
 * stays editable right up to Completed.
 */
const STOCK_EDITABLE_STATUSES = new Set(["Pending", "Paid"]);

/**
 * The PFI is different, and used to share the gate above.
 *
 * Which cargo an order was lifted from is not a plan that expires when the
 * trucks roll — it is a fact about where the product came from, and it is
 * recorded before anyone knows it is wrong. An order gets raised against the
 * wrong batch, loads, completes, and the error is only found when the cargo's
 * sold litres do not match its bank of orders. Until now the answer was that
 * the order could never be corrected: the desk was told "Quantity and PFI can
 * only be changed before an order is released for loading", and the figures
 * stayed wrong on both cargoes permanently.
 *
 * Nothing about the move depends on the order's stage. A PFI's position is one
 * counter — sold litres against starting litres — and moving an order is the
 * same two writes at every stage: give the litres back to the cargo that did
 * not supply them, take them from the one that did. The records that name the
 * PFI travel with it (see the move below), so the new cargo's report gains
 * exactly what the old one loses.
 *
 * Cancelled and Expired are the exception, and stay refused. Those orders gave
 * their litres back when they died — there is no reservation left to move, and
 * "moving" one would consume a second cargo's stock for an order that is never
 * going to lift it.
 */
const PFI_MOVE_LOCKED_STATUSES = new Set(["Cancelled", "Expired"]);

/**
 * Is this patch asking for anything beyond the PFI?
 *
 * A completed order accepts a PFI correction and nothing else, so the blanket
 * edit lock has to distinguish the two. Compared against the order's current
 * values rather than merely being present: a form that posts every field it
 * rendered sends `price` and `quantity` unchanged, and refusing that as "an
 * edit to a completed order" would block the correction the desk came to make.
 */
const CHANGES_BEYOND_PFI = (patch, order) => {
  const same = (a, b) => String(a ?? "") === String(b ?? "");
  const unchanged = {
    customerId: same(patch.customerId, order.customerId),
    quantity: same(patch.quantity, order.quantity),
    price: same(patch.price, order.price),
    totalAmount: same(patch.totalAmount, order.totalAmount),
    companyName: same(patch.companyName, order.companyName),
    expectedTrucks: same(patch.expectedTrucks, order.expectedTrucks),
    deliveryAddress: same(patch.deliveryAddress, order.deliveryAddress),
    createdAt:
      patch.createdAt === undefined ||
      new Date(patch.createdAt).getTime() === new Date(order.createdAt).getTime(),
  };
  return Object.entries(unchanged).some(
    ([field, isSame]) => patch[field] !== undefined && !isSame,
  );
};

/**
 * Edit an order's own fields — reassign it to another customer, move it to a
 * different PFI, correct its date, quantity, price or logistics text. One
 * transaction, one audit row, and every place that denormalizes something
 * about the order (the wallet hold, a commission snapshot, a PFI's stock
 * ledger) is kept in step rather than left to drift.
 *
 * Deliberately excludes `status`/`paymentStatus` — those only ever move
 * through orderStatus.transition (AUDIT H1). This function is for everything
 * else a mistake can leave wrong on an order.
 */
async function updateOrder(orderId, patch, { actor, ipAddress = null, userAgent = null, scopeUser = null } = {}) {
  return db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) throw httpError(404, "Order not found");

    const wantsPfiChange = patch.pfiId !== undefined && (patch.pfiId ?? null) !== order.pfiId;

    if (EDIT_LOCKED_STATUSES.has(order.status)) {
      // A completed order still accepts one correction: the cargo it was
      // lifted from. See PFI_MOVE_LOCKED_STATUSES for why that one and no
      // other, and why a cancelled or expired order accepts none.
      const pfiOnly =
        wantsPfiChange &&
        !PFI_MOVE_LOCKED_STATUSES.has(order.status) &&
        !CHANGES_BEYOND_PFI(patch, order);
      if (!pfiOnly) {
        throw httpError(409, `A ${order.status.toLowerCase()} order can no longer be edited`);
      }
    }

    const changes = {};
    const set = {};

    // ── Customer reassignment ──────────────────────────────────────────
    if (patch.customerId !== undefined && Number(patch.customerId) !== order.customerId) {
      const newCustomerId = Number(patch.customerId);
      const newCustomer = await customerRepo.findById(newCustomerId, tx);
      if (!newCustomer) throw httpError(404, "Destination customer not found");

      const result = await walletService.reassignHold({ orderId, toCustomerId: newCustomerId }, tx);
      if (!result.success) throw httpError(result.insufficient ? 400 : 409, result.message);

      const commission = await commissionRepo.findByOrderId(orderId);
      if (commission) {
        await tx
          .update(commissions)
          .set({ customerId: newCustomerId, updatedAt: new Date() })
          .where(eq(commissions.id, commission.id));
      }

      changes.customerId = [order.customerId, newCustomerId];
      set.customerId = newCustomerId;
    }

    // ── Quantity / PFI reassignment — share the same release/reserve path ──
    const wantsQtyChange = patch.quantity !== undefined && Number(patch.quantity) !== order.quantity;
    if (wantsPfiChange || wantsQtyChange) {
      /**
       * Two gates, because they guard two different things.
       *
       * Quantity is a live reservation that tickets are cut against, so it
       * closes at release. The PFI is a record of which cargo supplied the
       * order, correctable for as long as the order exists — the litres move
       * with it either way, and at every stage that is the same two writes.
       */
      if (wantsQtyChange && !STOCK_EDITABLE_STATUSES.has(order.status)) {
        throw httpError(409, "Quantity can only be changed before an order is released for loading");
      }
      if (wantsPfiChange && PFI_MOVE_LOCKED_STATUSES.has(order.status)) {
        throw httpError(
          409,
          `A ${order.status.toLowerCase()} order gave its litres back to its PFI — move the order it should have been on instead`,
        );
      }

      const newPfiId = patch.pfiId !== undefined ? patch.pfiId : order.pfiId;
      const newQuantity = patch.quantity !== undefined ? Number(patch.quantity) : order.quantity;

      if (newPfiId != null && !isWithinScope(scopeUser, "pfiIds", newPfiId)) {
        throw httpError(403, "You cannot assign orders to this PFI");
      }

      // Give back whatever is currently reserved...
      if (order.pfiId) {
        const allocations = await orderPfiAllocationRepo.findByOrderId(orderId, tx);
        if (allocations.length > 0) {
          for (const alloc of allocations) await pfiRepo.releaseStock(alloc.pfiId, alloc.quantity, tx);
          await orderPfiAllocationRepo.deleteByOrderId(orderId, tx);
        } else {
          // Fallback for orders created before multi-PFI allocations existed.
          await pfiRepo.releaseStock(order.pfiId, order.quantity, tx);
        }
      }

      // ...then reserve the new amount, at the (possibly new) PFI.
      if (newPfiId != null) {
        const reserved = await pfiRepo.reserveStock(newPfiId, newQuantity, tx);
        if (!reserved) {
          throw httpError(400, "That PFI doesn't have enough remaining stock for this quantity, or is not active");
        }
        await orderPfiAllocationRepo.create([{ pfiId: newPfiId, quantity: newQuantity }], orderId, tx);
      }

      /**
       * Everything else that names the old PFI moves with the order.
       *
       * A ticket cut for this order wrote a stock movement against whichever
       * cargo was current at that moment. Leaving those behind is what makes a
       * move half-done: the order would show on the new PFI's report while its
       * litres stayed recorded as lifted from the old one, and neither cargo's
       * figures would be right.
       *
       * With the allocation rewritten above and the movements repointed here,
       * the new PFI gains exactly what the old one loses — the reservation,
       * the sold litres, and every movement row behind them.
       */
      if (wantsPfiChange) {
        if (newPfiId == null) {
          const [{ movements } = { movements: 0 }] = await tx
            .select({ movements: sql`COUNT(*)::int` })
            .from(pfiMovements)
            .where(eq(pfiMovements.orderId, orderId));
          if (movements > 0) {
            throw httpError(
              409,
              "This order has already moved stock, so it cannot be left without a PFI — move it to the PFI that supplied it instead",
            );
          }
        } else {
          await tx.update(pfiMovements).set({ pfiId: newPfiId }).where(eq(pfiMovements.orderId, orderId));
        }

        /**
         * The cargo the order arrived at may now be fully sold, exactly as it
         * would be had the order been raised against it — placeOrder marks it
         * and so does this. The cargo it LEFT is handled inside releaseStock,
         * which reopens a finished PFI that has litres again.
         */
        if (newPfiId != null) await pfiRepo.markFinishedIfComplete(newPfiId, tx);
      }

      if (wantsPfiChange) { changes.pfiId = [order.pfiId, newPfiId]; set.pfiId = newPfiId; }
      if (wantsQtyChange) { changes.quantity = [order.quantity, newQuantity]; set.quantity = newQuantity; }

      if (wantsQtyChange) {
        const commission = await commissionRepo.findByOrderId(orderId);
        if (commission) {
          const rate = Number(commission.commissionRate);
          await tx
            .update(commissions)
            .set({
              quantity: newQuantity,
              commissionAmount: String((newQuantity * rate).toFixed(2)),
              updatedAt: new Date(),
            })
            .where(eq(commissions.id, commission.id));
        }
      }
    }

    // ── Simple field overrides — nothing else references these directly ──
    // price/totalAmount arrive already normalised to a "X.XX" string by the
    // money() schema, matching the numeric(15,2) column's own driver
    // representation, so a plain string compare is enough — no float
    // round-tripping either side of it.
    // expectedTrucks is editable after the fact on purpose: 55 live orders were
    // raised before the column existed, and the haulage on an order genuinely
    // changes. Setting it is how the desk turns "3 ticketed" into "3 of 6".
    for (const field of ["price", "totalAmount", "companyName", "deliveryAddress", "expectedTrucks"]) {
      if (patch[field] === undefined) continue;
      if (String(order[field]) !== String(patch[field])) {
        changes[field] = [order[field], patch[field]];
        set[field] = patch[field];
      }
    }
    if (patch.createdAt !== undefined) {
      const nextDate = new Date(patch.createdAt);
      if (nextDate.getTime() !== new Date(order.createdAt).getTime()) {
        changes.createdAt = [order.createdAt, nextDate];
        set.createdAt = nextDate;
      }
    }

    /**
     * Keep the order's value equal to what it is made of.
     *
     * `price` and `totalAmount` arrive as independent optional fields, so a
     * caller correcting a unit price — which is the common edit, and the reason
     * this exists — would otherwise leave the total at the old price's figure.
     * The two would then disagree on the face of the order, and every downstream
     * total is built on `totalAmount`.
     *
     * Derived only when the caller did NOT state a total explicitly: an
     * explicit total is a deliberate override (a negotiated figure that is not
     * quantity x rate) and must win.
     */
    const priceChanged = set.price !== undefined;
    const qtyChanged = set.quantity !== undefined;
    if ((priceChanged || qtyChanged) && patch.totalAmount === undefined) {
      const nextPrice = Number(set.price ?? order.price);
      const nextQty = Number(set.quantity ?? order.quantity);
      const derived = (nextPrice * nextQty).toFixed(2);
      if (String(order.totalAmount) !== derived) {
        changes.totalAmount = [order.totalAmount, derived];
        set.totalAmount = derived;
      }
    }

    if (!Object.keys(set).length) return order;

    const updated = await orderRepo.update(orderId, set, tx);

    /**
     * A changed value changes whether the order is actually paid.
     *
     * Without this, correcting a 45,000 L order from ₦1,200 to ₦1,265 left it
     * reading "Paid" while ₦2,925,000 short — the finance report computes
     * shortfall from total_amount and showed the gap, but payment_status still
     * said Paid, so the Payable Orders desk would not offer it for the top-up
     * and nobody could settle it.
     *
     * recomputeOrder re-derives amountPaid and paymentStatus from the payment
     * rows against the NEW total, inside this same transaction, so the edit and
     * its consequence commit together.
     */
    let payment = null;
    if (set.totalAmount !== undefined) {
      payment = await orderPaymentService.recomputeOrder(orderId, tx);
      if (payment.paymentStatus !== order.paymentStatus) {
        changes.paymentStatus = [order.paymentStatus, payment.paymentStatus];
      }
    }

    await auditLogRepo.record(
      { entityType: "order", entityId: orderId, action: "order.updated", actor, metadata: { changes }, ipAddress, userAgent },
      tx
    );

    // Re-read: recomputeOrder wrote amountPaid and paymentStatus after
    // orderRepo.update returned, so `updated` is already stale on those two.
    return payment ? orderRepo.findById(orderId, tx) : updated;
  });
}

/**
 * Cancel a live order (any status through Released). One transaction: the
 * state machine locks the row and rejects an illegal or concurrent cancel
 * BEFORE any restitution, then stock release and the hold release run as the
 * same unit. Shared by the staff endpoint and the
 * WhatsApp customer cancel — the actor in the audit row tells them apart.
 */
async function cancelOrder({
  orderId,
  actor,
  reason = null,
  cancelledBy = null,
  ipAddress = null,
  userAgent = null,
}) {
  return db.transaction(async (tx) => {
    const order = await orderStatus.transition(orderId, "Cancelled", {
      tx,
      actor,
      set: {
        cancelledAt: new Date(),
        cancelledBy,
        cancellationReason: reason,
      },
      metadata: { reason, refunded: false },
      ipAddress,
      userAgent,
    });

    await releaseOrderResources(order, tx);

    return order;
  });
}

/**
 * Expire a single order: drive Pending→Expired (system actor) and return its
 * reserved stock, mirroring a cancel minus the human. The
 * state machine only allows Expired from Pending, so a concurrently paid or
 * cancelled order throws 409 here and is skipped by the sweep. Joins an existing
 * transaction when one is passed (the pre-payment guard).
 */
async function expireOrder(orderId, { tx } = {}) {
  const run = async (tx) => {
    const order = await orderStatus.transition(orderId, "Expired", {
      tx,
      actor: { type: "system" },
      action: "order.expired",
      set: { expiredAt: new Date() },
      metadata: { reason: "unpaid past expiry window", expiryHours: orderExpiryHours() },
    });

    await releaseOrderResources(order, tx);

    return order;
  };
  return tx ? run(tx) : db.transaction(run);
}

/**
 * The expiry sweep: lapse every Pending, unpaid order older than the window
 * (ORDER_EXPIRY_HOURS). Run on a schedule (POST /api/order-expiry/run). A row
 * that a concurrent pay/cancel already moved throws inside expireOrder and is
 * skipped — one stale order never fails the whole sweep.
 *
 * @returns {number} how many orders were expired
 */
async function expireStaleOrders() {
  if (orderExpiryDisabled()) return 0;
  const cutoff = new Date(Date.now() - orderExpiryMs());
  const stale = await orderRepo.findStalePending(cutoff);

  let expired = 0;
  for (const row of stale) {
    try {
      const order = await expireOrder(row.id);
      expired += 1;
      await notifyOrderExpired(order);
    } catch (err) {
      console.error(`[expiry] order ${row.orderNumber} (#${row.id}) skipped:`, err.message);
    }
  }

  console.log(`[expiry] considered ${stale.length} stale order(s); expired ${expired}`);
  return expired;
}

/**
 * Tell the customer their order lapsed — best-effort, never fails the sweep. The
 * order got an SMS at placement; this closes the loop so a lapsed order isn't
 * silent. The customer is unpaid, so there's nothing to refund.
 */
async function notifyOrderExpired(order) {
  try {
    const customer = await customerRepo.findById(order.customerId);
    if (customer?.phone) {
      await sendOrderExpiredSMS(customer.phone, {
        orderNumber: order.orderNumber,
        customerName: customer.name,
      });
    }
    // The SMS above is unchanged; this adds the inbox row so a customer who
    // opens the app days later still finds out why the order vanished.
    if (customer) {
      notify("order.expired", {
        to: { customer },
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          reference: order.orderNumber,
          customerName: customer.name,
        },
      });
    }
  } catch (err) {
    console.error(`[expiry] failed to notify customer for ${order.orderNumber}:`, err.message);
  }
}

/**
 * Replace the pickup truck declaration on an existing order (customer portal).
 * Writes to `order_trucks` only — tickets are issued later at load and are
 * never touched here.
 *
 * Editable while the order is Pending / Paid / Released and every existing
 * load is still `pending`. Once a load has been ticketed or gated, the customer
 * can no longer change the declaration (staff corrects at the gate/ticketing).
 *
 * @param {object} input
 * @param {number} input.orderId
 * @param {number} input.customerId — ownership check
 * @param {Array<{truckNumber?: string, quantity: number, driverName?: string, driverPhone?: string}>} input.trucks
 * @param {{type: "customer"|"staff"|"system", customerId?: number, staffId?: number}} input.actor
 * @param {string|null} [input.ipAddress]
 * @param {string|null} [input.userAgent]
 */
async function updatePickupTrucks({
  orderId,
  customerId,
  trucks,
  actor,
  ipAddress = null,
  userAgent = null,
}) {
  const declared = Array.isArray(trucks) ? trucks : [];

  return db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order || order.customerId !== customerId) {
      throw httpError(404, "Order not found");
    }
    if (order.deliveryType !== "pickup") {
      throw httpError(400, "Only pickup orders carry customer-declared trucks");
    }

    const EDITABLE = new Set(["Pending", "Paid", "Released"]);
    if (!EDITABLE.has(order.status)) {
      throw httpError(
        409,
        `Order is ${order.status}; truck details can only be changed before loading starts`
      );
    }

    // Anything past `pending` has been ticketed or gated, and the declaration
    // is no longer the customer's to rewrite — the ticket already names a plate,
    // and deleting the load below would take that ticket with it.
    const existing = await orderTruckRepo.findByOrder(order.id, tx);
    const locked = existing.find((l) => l.status !== "pending");
    if (locked) {
      throw httpError(
        409,
        "A ticket has already been issued for this order — truck details can no longer be changed here"
      );
    }

    const qty = Number(order.quantity);
    // Empty clears the declaration (gate captures trucks later). A non-empty
    // split must still sum to the order and stay within one tanker per truck.
    if (declared.length) {
      const sum = declared.reduce((s, t) => s + Number(t.quantity), 0);
      if (sum !== qty) {
        throw httpError(
          400,
          `The truck quantities (${sum.toLocaleString()} L) must sum to the order quantity (${qty.toLocaleString()} L)`
        );
      }
      const tooBig = declared.find((t) => Number(t.quantity) > 60000);
      if (tooBig) {
        throw httpError(400, "Each truck can carry at most 60,000 L — split the load across more trucks");
      }
    }

    await orderTruckRepo.deleteByOrder(order.id, tx);

    const loads = [];
    for (let i = 0; i < declared.length; i += 1) {
      const t = declared[i];
      const load = await orderTruckRepo.create(
        {
          orderId: order.id,
          truckIndex: i + 1,
          truckId: null,
          truckNumber: t.truckNumber || null,
          quantity: String(t.quantity),
          driverName: t.driverName || null,
          driverPhone: t.driverPhone || null,
          status: "pending",
        },
        tx
      );
      await auditLogRepo.record(
        {
          entityType: "order_truck",
          entityId: load.id,
          action: "order_truck.allocated",
          actor,
          metadata: {
            orderId: order.id,
            truckIndex: i + 1,
            truckNumber: load.truckNumber,
            quantity: String(t.quantity),
            via: "customer-update",
          },
          ipAddress,
          userAgent,
        },
        tx
      );
      loads.push(load);
    }

    await auditLogRepo.record(
      {
        entityType: "order",
        entityId: order.id,
        action: "order.trucks_updated",
        actor,
        metadata: {
          truckCount: loads.length,
          replaced: existing.length,
        },
        ipAddress,
        userAgent,
      },
      tx
    );

    return { order, trucks: loads };
  });
}

/**
 * If the order has lapsed, expire it now in its own committed transaction,
 * scoped to the caller. Runs before a payment attempt so paying a stale order
 * flags it Expired first (that flag survives) and the payment is then refused —
 * rather than settling an order at a price that is no longer current. A foreign
 * order, or one a concurrent action already moved, is left untouched.
 *
 * @returns {boolean} whether it expired the order
 */
async function expireIfStale({ orderId, customerId = null }) {
  return db.transaction(async (tx) => {
    const order = await orderRepo.lockById(orderId, tx);
    if (!order) return false;
    if (customerId != null && order.customerId !== customerId) return false;
    if (!isOrderExpired(order)) return false;
    await expireOrder(orderId, { tx });
    return true;
  });
}

/**
 * The side effects that must follow a confirmed payment: the loading ticket,
 * the commission record, and the WhatsApp payment-confirmed push. Runs
 * post-commit (the money is already durable) and NEVER throws — each failure is
 * logged with a `[post-payment]` marker for alerting.
 *
 * Idempotent: the ticket and commission each no-op if they already exist, so a
 * failed effect can be healed by re-running this — at pay time, or via the
 * finance reconcile endpoint — without duplicating anything.
 *
 * @returns {{ticket: boolean, commission: boolean}} what succeeded this run
 */
async function runPostPaymentEffects(orderId, { notifyWhatsApp = true } = {}) {
  let ticket = false;
  let commission = false;
  let subaccountTransfer = null;

  try {
    await generateTicketForOrder(orderId);
    ticket = true;
  } catch (err) {
    console.error(`[post-payment] ticket failed for order ${orderId}:`, err.message);
  }

  try {
    await commissionService.createForOrder(orderId);
    commission = true;
  } catch (err) {
    console.error(`[post-payment] commission failed for order ${orderId}:`, err.message);
  }

  // Paystack auto-split transfer (disabled — manual deposit only): the
  // customer now pays straight into the depot's own bank account, so there
  // is no merchant-balance share left to push out. Re-add the import at the
  // top of this file to reinstate:
  // try {
  //   const orderForTransfer = await orderRepo.findByIdFull(orderId);
  //   if (orderForTransfer) {
  //     subaccountTransfer = await transferToDepotSubaccount(orderForTransfer);
  //   }
  // } catch (err) {
  //   console.error(`[post-payment] subaccount transfer failed for order ${orderId}:`, err.message);
  // }

  // Skipped when the caller already delivers the confirmation itself — the
  // WhatsApp engine replies "Payment received" synchronously in the same turn,
  // so the async push would be a duplicate.
  if (notifyWhatsApp) notifyWhatsAppPaymentConfirmed(orderId);

  return { ticket, commission, subaccountTransfer };
}

/**
 * Confirm payment on an order from the bank statement lines that paid for it.
 *
 * This replaced `payOrder`, which took money out of the customer's wallet
 * balance. The difference is not cosmetic:
 *
 *   before   the desk credited a customer's wallet from the statement, then
 *            debited the wallet for the order. Which bank row paid for which
 *            order was never written down, so the finance report inferred it
 *            afterwards, oldest-credit-first, and printed the inference as
 *            fact. An order could also be confirmed with no statement behind
 *            it at all, by drawing on a balance from who-knows-where.
 *
 *   now      the payment IS the statement line, recorded against this order.
 *            Nothing can confirm an order except naming the bank rows that
 *            paid for it, and no balance is drawn on to cover a shortfall.
 *
 * Instalments need no special handling. Each call records whatever lines are
 * given, `recomputeOrder` re-derives the order's money columns from every
 * payment row it now has, and the order lands on Part Paid or Paid by
 * arithmetic. Only the FIRST payment moves the order's status — it is what
 * opens the pipeline, because a part-paid order still has to reach the
 * ticketing desk to be any use; a later instalment finds it already Released
 * and only the money columns change.
 *
 * A line larger than what the order owes is NOT trimmed to fit. The surplus
 * lands on the order and shows there, and moving it somewhere useful is an
 * explicit transfer (see orderPayment.service.transferSurplus). That is the
 * whole point: money stays attached to the order it was paid against until
 * somebody says otherwise, on the record.
 *
 * @param {object} opts
 * @param {number} opts.orderId
 * @param {number} opts.bankAccountId  the account the lines belong to
 * @param {number[]} opts.lineIds      UNMATCHED statement lines to claim
 * @param {{ type: string, staffId?: number }} opts.actor
 * @param {string} [opts.note]
 * @returns {object} the updated order
 */
/**
 * PFI types whose orders have no loading desk and no gate.
 *
 * A coastal cargo is trucked out of a depot: tickets are issued, trucks are
 * gated in, they load, they gate out, and the last one out completes the
 * order. Every one of those states is a real event somebody performs.
 *
 * A gantry lifting and a delivery batch have none of them. The product is
 * bought at the gantry or delivered by us; there is no truck for this depot's
 * security to admit and no ticket for its loading desk to issue. So the states
 * existed and nobody was ever going to move them: 1,536 fully-paid gantry
 * orders sat at Released waiting on a desk that does not handle them, and
 * 1,451 of those had no stock movement, which is why their batches read as
 * sold-but-not-loaded.
 */
const DESKLESS_PFI_TYPES = ["gantry", "delivery"];

/**
 * Take a deskless order all the way to Completed the moment it is paid for.
 *
 * Released → Loading → Completed, stepped rather than jumped, so each move
 * writes the audit row and fires the announcement it always has. Nothing here
 * invents a gate event: no truck rows are created, so no truck is recorded as
 * having arrived or departed, and the gate queues stay empty because there is
 * genuinely nothing in them.
 *
 * ── The stock movement is the point ────────────────────────────────────────
 *
 * Stock leaves a PFI when tickets are generated — that is where the RELEASE
 * row is written, and where the "litres loaded" on every report comes from.
 * Skipping ticketing without writing it would complete the order and leave the
 * batch permanently short, which is the exact reporting fault this is meant to
 * end. So the shortcut writes the same row the ticketing desk would have, with
 * a note saying why it did.
 *
 * Only on a FULLY paid order. A part payment releases the order so the balance
 * can be chased; completing it there would say the business is finished with
 * an order still owing money.
 */
async function completeDesklessOrder(order, { tx, actor, pfiType }) {
  if (!DESKLESS_PFI_TYPES.includes(pfiType)) return false;

  const qty = Number(order.quantity) || 0;
  if (order.pfiId && qty > 0) {
    await tx
      .insert(pfiMovements)
      .values({
        pfiId: Number(order.pfiId),
        orderId: order.id,
        action: "RELEASE",
        qtyLitres: qty,
        notes: `${pfiType} order — no loading desk, released on payment`,
        recordedBy: actor?.staffId ?? null,
      })
      // The same one-row-per-(order, RELEASE) guarantee ticket generation
      // relies on, so a re-run cannot deduct the batch twice.
      .onConflictDoUpdate({
        target: [pfiMovements.orderId, pfiMovements.action],
        set: { qtyLitres: qty },
      });
  }

  const shared = { tx, actor, metadata: { trigger: "payment", pfiType, deskless: true } };
  await orderStatus.transition(order.id, "Loading", {
    ...shared,
    set: { loadingStartedAt: new Date() },
  });
  await orderStatus.transition(order.id, "Completed", {
    ...shared,
    set: { completedAt: new Date() },
  });
  return true;
}

async function confirmOrderPayment({
  orderId,
  bankAccountId,
  lineIds,
  actor,
  note = "",
  notifyWhatsApp = true,
}) {
  // Lapsed orders are expired-and-refused, never paid at a stale price. The
  // guard commits the Expired flag first; the transaction below then sees it.
  await expireIfStale({ orderId });

  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update")
      .limit(1);

    if (!order) throw httpError(404, "Order not found");
    /**
     * A fully-paid order still accepts lines.
     *
     * This used to refuse with 409 "Order is already paid", which sounds like a
     * safeguard and worked as a trap: an order is "paid" according to
     * `amount_paid`, a cached figure that the 0021 backfill left overstating
     * the payment rows on 36 orders by ₦1.11bn in total. Every one of those is
     * carried as Paid while the evidence behind it is short, and the guard
     * blocked the desk from attaching the very lines that would reconcile it.
     *
     * Removing it also makes the pair symmetrical: removePayment has never
     * cared what an order's status is, so money could always be taken off an
     * order and not put back. Correcting a mis-match needs both halves.
     *
     * Nothing downstream assumes this is the first payment — `isFirstPayment`
     * below gates the status transition and the release, and
     * runPostPaymentEffects is idempotent by construction. Money beyond the
     * order's value lands as surplus, which the response names and the desk can
     * transfer to the order it belongs to.
     */
    if (order.status === "Expired") {
      throw httpError(409, "This order has expired. Please place a new order at current prices.");
    }
    if (!PAYABLE_STATUSES.has(order.status)) {
      throw httpError(409, `Cannot pay an order in ${order.status} status`);
    }
    if (Number(order.totalAmount) <= 0) throw httpError(400, "Order total is invalid");

    /**
     * Whether there is a status transition to run.
     *
     * The status IS the condition. Paid is only ever legal FROM Pending (see
     * TRANSITIONS in orderStatus.service.js), so an order that has already been
     * released, loaded or delivered is passed over here and simply keeps the
     * fulfilment status it has — which is what recording money against a
     * delivered order should do, and why it no longer throws 409 "An order
     * cannot move from Completed to Paid".
     *
     * This used to also require `amountPaid <= 0` — "first money on the
     * order". That extra condition assumed every route by which money can
     * arrive also drives the state machine, and one does not: a transfer-in
     * from another order (transferSurplus) writes a payment row and leaves the
     * status alone. So a small transfer landing before the real payment spent
     * the "first payment" flag, and the statement lines that followed were
     * recorded with the release silently skipped — leaving an order fully Paid,
     * stuck at Pending, and invisible to a ticketing desk that only sees
     * Released/Loading. Order 11790 sat exactly there: ₦587k in by transfer at
     * 15:57, ₦433.5m of statement lines at 16:03, and no release.
     *
     * isLegal alone is both necessary and sufficient. It cannot double-release
     * a paid order, because the second call finds the status already past
     * Pending.
     */
    const shouldTransition = orderStatus.isLegal(order.status, "Paid");

    const { payments, summary } = await orderPaymentService.recordFromStatementLines(
      { orderId, bankAccountId, lineIds, staffId: actor?.staffId ?? null, note },
      tx,
    );

    if (shouldTransition) {
      await orderStatus.transition(order.id, "Paid", {
        tx,
        actor,
        action: "order.paid",
        // recomputeOrder has already written amountPaid, paymentStatus and
        // paymentConfirmedAt inside this same transaction. Passing them again
        // here would let a stale figure win; the transition only needs to move
        // the status.
        set: {},
        metadata: {
          via: "bank_statement",
          statementLineIds: payments.map((p) => p.statementLineId),
          received: String(summary.received),
          orderTotal: String(summary.orderTotal),
          surplus: String(summary.surplus),
          partial: summary.shortfall > 0,
        },
      });

      // Payment IS the release: the order goes straight onto the ticketing desk
      // rather than waiting for someone to click a button that has no other
      // condition attached to it. A part payment releases it too — capped at
      // the quantity paid for, which generate-tickets enforces.
      await orderStatus.releaseOnPayment(order.id, {
        tx,
        actor,
        metadata: { via: "bank_statement" },
      });

      /**
       * A gantry or delivery order has no desk after this point, so it does
       * not wait at one. See completeDesklessOrder — it writes the stock
       * movement ticketing would have written, then steps the order through
       * to Completed. Only when nothing is still owed.
       */
      if (summary.shortfall <= 0) {
        const [batch] = await tx
          .select({ pfiType: pfis.pfiType })
          .from(pfis)
          .where(eq(pfis.id, order.pfiId ?? 0))
          .limit(1);
        if (batch?.pfiType) {
          await completeDesklessOrder(order, { tx, actor, pfiType: batch.pfiType });
        }
      }
    }
    // A later instalment has no status to move — the order was released by its
    // first one. recordFromStatementLines has already written its own
    // 'order.payment_recorded' audit row, which carries the amount, the lines
    // and the resulting status, so there is nothing further to log here.

    return { orderId: order.id, summary };
  });

  // Tickets, commission and notifications. Run after every payment, exactly as
  // the wallet path did: an instalment unlocks more litres, and these effects
  // are written to be idempotent and best-effort so a re-run settles rather
  // than duplicates.
  await runPostPaymentEffects(result.orderId, { notifyWhatsApp });

  return orderRepo.findByIdFull(result.orderId);
}

module.exports = {
  placeOrder,
  updateOrder,
  cancelOrder,
  updatePickupTrucks,
  confirmOrderPayment,
  completeDesklessOrder,
  DESKLESS_PFI_TYPES,
  releasableQuantity,
  runPostPaymentEffects,
  expireOrder,
  expireIfStale,
  expireStaleOrders,
  isOrderExpired,
  computeExpiresAt,
  withExpiresAt,
  orderExpiryHours,
  httpError,
};
