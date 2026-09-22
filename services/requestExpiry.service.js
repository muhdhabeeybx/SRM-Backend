const { db } = require("../config/db");
const {
  dangoteOrderRequestRepo,
  lpgOrderRequestRepo,
  customerRepo,
  lpgStationRepo,
} = require("../repositories");
const dangoteOrderStatus = require("./dangoteOrderStatus.service");
const lpgOrderStatus = require("./lpgOrderStatus.service");
const { sendDangoteOrderExpiredSMS, sendLpgOrderExpiredSMS } = require("./sms.service");
const { notify } = require("../notifications");
const {
  orderExpiryDisabled,
  expiryDeadline,
  hasLapsed,
  sweepCutoff,
} = require("../config/orderExpiry");

/**
 * Has this request lapsed? Only an Approved, unpaid request can — once payment
 * settles it, the request is Paid and never expires. Uses `reviewedAt` as the
 * starting point (when staff approved and set the price), not `createdAt`.
 */
function isRequestExpired(request, now = Date.now()) {
  return (
    !orderExpiryDisabled() &&
    request.status === "Approved" &&
    request.paymentStatus !== "Paid" &&
    request.reviewedAt &&
    // End of the Lagos day it was approved on — the same end-of-day rule the
    // depot orders use, anchored on review rather than creation.
    hasLapsed(request.reviewedAt, now)
  );
}

/**
 * Compute the expiration deadline for a request. Returns an ISO string if the
 * request is Approved and unpaid; null otherwise — and null whenever the
 * expiry mechanism itself is switched off.
 */
function computeRequestExpiresAt(request) {
  if (orderExpiryDisabled()) return null;
  if (request.status !== "Approved" || request.paymentStatus === "Paid" || !request.reviewedAt) return null;
  return expiryDeadline(request.reviewedAt)?.toISOString() ?? null;
}

/**
 * Enrich a request (or array of requests) with a computed `expiresAt` field.
 * For single requests, also checks if the deadline has passed and immediately
 * expires the request before returning it.
 */
async function withRequestExpiresAt(requestOrRequests) {
  if (Array.isArray(requestOrRequests)) {
    const results = [];
    for (const r of requestOrRequests) {
      results.push(await expireAndAttach(r));
    }
    return results;
  }
  return expireAndAttach(requestOrRequests);
}

/**
 * Internal helper: expire a request if past its deadline, then attach expiresAt.
 */
async function expireAndAttach(request) {
  if (!orderExpiryDisabled() && request.status === "Approved" && request.paymentStatus !== "Paid" && request.reviewedAt) {
    if (hasLapsed(request.reviewedAt)) {
      try {
        const expired = await expireRequest(request.id, request._type || detectType(request));
        return { ...expired, expiresAt: null };
      } catch {
        // Already expired or concurrent update — fall through with original
      }
    }
  }
  return { ...request, expiresAt: computeRequestExpiresAt(request) };
}

/**
 * Detect whether a request is Dangote or LPG based on available fields.
 * LPG requests have lpgStationId; Dangote requests have product.
 */
function detectType(request) {
  if (request.lpgStationId || request.stationName || request.cylinderSizeKg) return "lpg";
  return "dangote";
}

/**
 * Expire a single request: drive Approved→Expired (system actor). For LPG
 * requests, also returns reserved cylinder stock.
 */
async function expireRequest(requestId, type, { tx } = {}) {
  if (type === "lpg") {
    return expireLpgRequest(requestId, { tx });
  }
  return expireDangoteRequest(requestId, { tx });
}

/**
 * Expire a single Dangote request.
 */
async function expireDangoteRequest(requestId, { tx } = {}) {
  const run = async (tx) => {
    const { order } = await dangoteOrderStatus.transition(requestId, "Expired", {
      tx,
      actor: { type: "system" },
      action: "dangote_order.expired",
      set: { expiredAt: new Date() },
      // The deadline itself is not repeated here: it is 23:59 on the request's
      // own reviewedAt day, and reviewedAt is on the row this line annotates.
      metadata: { reason: "unpaid at end of day" },
    });
    return order;
  };
  return tx ? run(tx) : db.transaction(run);
}

/**
 * Expire a single LPG request, returning reserved cylinder stock.
 */
async function expireLpgRequest(requestId, { tx } = {}) {
  const run = async (tx) => {
    const { order } = await lpgOrderStatus.transition(requestId, "Expired", {
      tx,
      actor: { type: "system" },
      action: "lpg_order.expired",
      set: { expiredAt: new Date() },
      // The deadline itself is not repeated here: it is 23:59 on the request's
      // own reviewedAt day, and reviewedAt is on the row this line annotates.
      metadata: { reason: "unpaid at end of day" },
    });

    // Return reserved cylinders to station stock (mirrors cancel logic)
    if (order.lpgStationId && order.cylinderSizeKg && order.cylinderQuantity) {
      await lpgStationRepo.incrementCylinderQuantity(
        order.lpgStationId,
        order.cylinderSizeKg,
        order.cylinderQuantity
      );
    }

    return order;
  };
  return tx ? run(tx) : db.transaction(run);
}

/**
 * The expiry sweep for Dangote and LPG requests: lapse every Approved, unpaid
 * request whose review day has ended (23:59 Lagos). Same policy and same
 * nightly run as the depot-order sweep.
 *
 * @returns {{ dangote: number, lpg: number }} how many requests were expired
 */
async function expireStaleRequests() {
  if (orderExpiryDisabled()) return { dangote: 0, lpg: 0 };
  const cutoff = sweepCutoff();

  let dangoteExpired = 0;
  let lpgExpired = 0;

  // Dangote sweep
  // As in expireStaleOrders: the cutoff narrows, hasLapsed decides.
  const staleDangote = (await dangoteOrderRequestRepo.findStaleApproved(cutoff)).filter((row) =>
    hasLapsed(row.reviewedAt)
  );
  for (const row of staleDangote) {
    try {
      const order = await expireDangoteRequest(row.id);
      dangoteExpired += 1;
      await notifyDangoteRequestExpired(order);
    } catch (err) {
      console.error(`[expiry] dangote request ${row.requestNumber} (#${row.id}) skipped:`, err.message);
    }
  }

  // LPG sweep
  const staleLpg = (await lpgOrderRequestRepo.findStaleApproved(cutoff)).filter((row) =>
    hasLapsed(row.reviewedAt)
  );
  for (const row of staleLpg) {
    try {
      const order = await expireLpgRequest(row.id);
      lpgExpired += 1;
      await notifyLpgRequestExpired(order);
    } catch (err) {
      console.error(`[expiry] lpg request ${row.requestNumber} (#${row.id}) skipped:`, err.message);
    }
  }

  console.log(
    `[expiry] considered ${staleDangote.length} stale Dangote request(s) (expired ${dangoteExpired}); ` +
    `considered ${staleLpg.length} stale LPG request(s) (expired ${lpgExpired})`
  );

  return { dangote: dangoteExpired, lpg: lpgExpired };
}

/**
 * Tell the customer their Dangote request lapsed.
 */
async function notifyDangoteRequestExpired(order) {
  try {
    const customer = await customerRepo.findById(order.customerId);
    if (customer?.phone) {
      await sendDangoteOrderExpiredSMS(customer.phone, {
        requestNumber: order.requestNumber,
        customerName: customer.name,
      });
    }
    // The SMS above is unchanged; this adds the inbox row so a customer who
    // opens the app days later still finds out why the request lapsed.
    if (customer) {
      notify("dangote.expired", {
        to: { customer },
        data: {
          requestId: order.id,
          requestNumber: order.requestNumber,
          customerName: customer.name,
        },
      });
    }
  } catch (err) {
    console.error(`[expiry] failed to notify customer for Dangote ${order.requestNumber}:`, err.message);
  }
}

/**
 * Tell the customer their LPG request lapsed.
 */
async function notifyLpgRequestExpired(order) {
  try {
    const customer = await customerRepo.findById(order.customerId);
    if (customer?.phone) {
      await sendLpgOrderExpiredSMS(customer.phone, {
        requestNumber: order.requestNumber,
        customerName: customer.name,
      });
    }
    if (customer) {
      notify("lpg.expired", {
        to: { customer },
        data: {
          requestId: order.id,
          requestNumber: order.requestNumber,
          customerName: customer.name,
        },
      });
    }
  } catch (err) {
    console.error(`[expiry] failed to notify customer for LPG ${order.requestNumber}:`, err.message);
  }
}

/**
 * If a Dangote or LPG request has lapsed, expire it now. Runs before a payment
 * attempt so paying a stale request flags it Expired first and the payment is
 * then refused.
 *
 * @returns {boolean} whether it expired the request
 */
async function expireIfStale({ requestId, type, customerId = null }) {
  if (type === "lpg") {
    return db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(require("../db/schema").lpgOrderRequests)
        .where(require("drizzle-orm").eq(require("../db/schema").lpgOrderRequests.id, requestId))
        .for("update")
        .limit(1);
      if (!order) return false;
      if (customerId != null && order.customerId !== customerId) return false;
      if (!isRequestExpired(order)) return false;
      await expireLpgRequest(requestId, { tx });
      return true;
    });
  }

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(require("../db/schema").dangoteOrderRequests)
      .where(require("drizzle-orm").eq(require("../db/schema").dangoteOrderRequests.id, requestId))
      .for("update")
      .limit(1);
    if (!order) return false;
    if (customerId != null && order.customerId !== customerId) return false;
    if (!isRequestExpired(order)) return false;
    await expireDangoteRequest(requestId, { tx });
    return true;
  });
}

module.exports = {
  isRequestExpired,
  computeRequestExpiresAt,
  withRequestExpiresAt,
  expireRequest,
  expireDangoteRequest,
  expireLpgRequest,
  expireStaleRequests,
  expireIfStale,
};
