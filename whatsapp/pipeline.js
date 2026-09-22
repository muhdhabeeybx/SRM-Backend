const { reduce } = require("./engine");
const { normalizeInbound } = require("./normalize");
const { loadContext } = require("./context");
const { EFFECTS, INBOUND, REPLY } = require("./constants");
const { customerRepo, orderRepo, waMessageRepo, waSessionRepo } = require("../repositories");
const { toE164 } = require("../utils/phone");
const { placeOrder, cancelOrder, computeExpiresAt } = require("../services/order.service");
const { noteExpectedPayments } = require("../services/expectedPayment.service");
const { sendReply, sendTypingIndicator } = require("./client");
const { QUEUES, enqueue } = require("../config/queue");
const copy = require("./copy");

/**
 * One conversation turn, end to end: load → reduce → perform effects →
 * re-enter → persist → queue replies. The engine stays pure; every side
 * effect lives here, and every step is idempotent so a pg-boss retry of a
 * half-finished turn cannot double-order (placeOrder gets the wamid as its
 * idempotency key) or double-create a customer (find-or-create by phone).
 */

// A conversational reply older than this is dropped as stale rather than
// delivered late. Matches the inbound guard's window.
const STALE_OUTBOUND_MS = 10 * 60 * 1000;

// An effect's outcome re-enters the engine as a new inbound. Bounded: no
// engine path emits chains longer than this, so more means a logic bug.
const MAX_TURNS = 4;

/** Record + send one outbound immediately (await Cloud API). Used when a
 * message must land before an effect that can enqueue competing pushes. */
const sendNow = async ({ waPhone, sessionId = null, customerId = null, payload, inReplyTo = null }) => {
  const outbound = await waMessageRepo.createOutbound({
    waPhone,
    sessionId,
    customerId,
    payload,
    inReplyTo,
  });
  try {
    const result = await sendReply(waPhone, outbound.payload);
    if (result.skipped) {
      await waMessageRepo.markSkipped(outbound.id, result.reason);
      return outbound;
    }
    await waMessageRepo.markSent(outbound.id, result.wamid);
  } catch (err) {
    await waMessageRepo.markFailed(outbound.id, err.message);
    // Still return — the ledger row exists; caller decides whether to proceed.
  }
  return outbound;
};

/** Perform one engine effect; return the inbound that re-enters the loop. */
const performEffect = async (effect, { wamid, waPhone, inboundMessageId = null }) => {
  switch (effect.type) {
    case EFFECTS.CREATE_CUSTOMER: {
      // Find-or-create: a pg-boss retry (or a very fast double text) may have
      // created the customer already — the phone's unique index decides.
      let customer = await customerRepo.findByPhone(waPhone);
      if (!customer) {
        try {
          customer = await customerRepo.create({
            name: effect.payload.name,
            phone: waPhone,
            status: "Active",
            createdVia: "whatsapp",
            // The WhatsApp message itself proves phone control — Meta
            // verified the number. No OTP, by decision.
            phoneVerifiedAt: new Date(),
          });
        } catch (err) {
          customer = await customerRepo.findByPhone(waPhone); // lost a race — fine
          if (!customer) throw err;
        }
      }
      return { type: INBOUND.CUSTOMER_CREATED, customer };
    }

    case EFFECTS.CREATE_ORDER: {
      try {
        const result = await placeOrder({
          ...effect.payload,
          actor: { type: "customer", customerId: effect.payload.customerId },
          idempotencyKey: wamid,
        });
        const order = {
          ...result.order,
          expiresAt: computeExpiresAt(result.order),
        };
        return { type: INBOUND.ORDER_CREATED, order };
      } catch (err) {
        console.error("[wa-pipeline] CREATE_ORDER failed:", err.message);
        if (/stock/i.test(err.message || "")) {
          // Let the engine re-ask with the truthful figure; a fresh context
          // is loaded on re-entry, so stock: 0 simply means "re-pick".
          return { type: INBOUND.ORDER_FAILED, reason: "stock", stock: 0 };
        }
        return { type: INBOUND.ORDER_FAILED, reason: "generic" };
      }
    }

    case EFFECTS.CANCEL_ORDER: {
      try {
        const order = await cancelOrder({
          orderId: effect.payload.orderId,
          actor: { type: "customer", customerId: effect.payload.customerId },
          reason: "Cancelled by customer via WhatsApp",
        });
        return { type: INBOUND.ORDER_CANCELLED, order };
      } catch (err) {
        // Already Paid/Released past cancellation, or a concurrent cancel —
        // the engine tells the customer to call rather than pretending.
        console.error("[wa-pipeline] CANCEL_ORDER failed:", err.message);
        return { type: INBOUND.ORDER_FAILED, reason: "cancel" };
      }
    }

    case EFFECTS.NOTE_EXPECTED_PAYMENTS: {
      // Advisory rows only — they name what to look for on the statement and
      // move no money. So a failure here must not cost the customer their
      // reply: the engine has already moved to AWAIT_PAYMENT and said thank
      // you, and the order stands either way. Log it and carry on.
      try {
        await noteExpectedPayments({
          orderId: effect.payload.orderId,
          customerId: effect.payload.customerId,
          entries: effect.payload.entries,
          // No staff member typed these — the customer did, over WhatsApp.
          createdBy: null,
        });
      } catch (err) {
        console.error("[wa-pipeline] NOTE_EXPECTED_PAYMENTS failed:", err.message);
      }
      return null; // nothing re-enters the engine
    }

    default:
      console.error(`[wa-pipeline] unknown effect "${effect.type}" ignored`);
      return null;
  }
};

/**
 * Process one recorded inbound message. Job handler for the wa-inbound
 * queue; also the janitor's re-entry point, so it must tolerate re-runs.
 */
const processInbound = async ({ waMessageId }) => {
  const message = await waMessageRepo.findById(waMessageId);
  if (!message || message.direction !== "inbound") return;
  if (message.status !== "received") return; // finished, or already skipped

  // A message that sat unprocessed past this is answered by SILENCE, not a
  // late reply. The janitor resurrects rows stranded by crashes or dead
  // workers — but replaying an old "hi" against the CURRENT session yanks a
  // mid-order customer back to the menu (observed in UAT). Stale inputs are
  // marked skipped: visible in the ledger, never applied to the conversation.
  const STALE_INBOUND_MS = 10 * 60 * 1000;
  if (Date.now() - new Date(message.createdAt).getTime() > STALE_INBOUND_MS) {
    await waMessageRepo.markSkipped(message.id, "stale — recovered too late to answer");
    return;
  }

  // Turn-retry guard: if a previous run of THIS turn already produced its
  // replies but crashed before the final bookkeeping (the classic window:
  // replies queued, markProcessed lost to a dropped connection), do NOT run
  // the engine again — that would answer the customer twice. Re-arm any
  // reply that never reached a send attempt, finish the bookkeeping, done.
  const priorReplies = await waMessageRepo.findRepliesTo(message.id);
  if (priorReplies.length > 0) {
    const queuedIds = priorReplies.filter((r) => r.status === "queued").map((r) => r.id);
    if (queuedIds.length > 0) {
      await enqueue(QUEUES.WA_SEND, { waMessageIds: queuedIds });
    }
    await waMessageRepo.markProcessed(message.id, {
      sessionId: priorReplies[0].sessionId,
      customerId: priorReplies[0].customerId,
    });
    return;
  }

  // Blue-tick + "typing…" immediately, in parallel with the real work — the
  // customer sees "we've heard you" while context loads and the engine runs.
  // Best-effort, but not silent: a failure logs its reason, so "too fast to
  // render" and "actually failing" are distinguishable in the console.
  sendTypingIndicator(message.wamid).then((r) => {
    if (r && r.ok === false) console.warn("[wa] typing indicator failed:", r.error);
  });

  const waPhone = message.waPhone;
  const stored = await waSessionRepo.findByPhone(waPhone);
  let customer = await customerRepo.findByPhone(waPhone);

  let session = {
    waPhone,
    customerId: customer?.id ?? stored?.customerId,
    state: stored?.state,
    cart: stored?.cart || {},
    lastOrderId: stored?.lastOrderId,
    failureCount: stored?.failureCount || 0,
    expired: waSessionRepo.isExpired(stored),
  };

  let inbound = normalizeInbound(message.payload);
  const replies = [];

  for (let turn = 0; turn < MAX_TURNS && inbound; turn += 1) {
    const context = await loadContext({ waPhone, customer, session });
    const result = reduce(session, inbound, context);
    session = result.session;
    replies.push(...result.replies);

    inbound = null;
    for (const effect of result.effects) {
      inbound = await performEffect(effect, {
        wamid: message.wamid,
        waPhone,
        inboundMessageId: message.id,
      });
      if (inbound?.type === INBOUND.CUSTOMER_CREATED) {
        customer = inbound.customer; // the next context load must know them
      }
    }
  }

  const saved = await waSessionRepo.save(waPhone, session);
  await dispatchReplies(waPhone, saved.id, customer?.id ?? null, replies, message.id);

  await waMessageRepo.markProcessed(message.id, {
    sessionId: saved.id,
    customerId: customer?.id ?? null,
  });
};

/**
 * Record first, send later: each reply is a queued wa_messages row before any
 * network attempt, so the kill switch or a Cloud API outage leaves a visible
 * trail instead of silence. `inReplyTo` links conversational replies to the
 * inbound that caused them — the retry guard and the send-side staleness rule
 * both key off it; event pushes pass null and stay durable.
 *
 * One WA_SEND job carries the whole batch and processSend delivers them in
 * array order, awaiting each Cloud API call. Separate jobs per reply let
 * concurrent workers (or multi-instance deploys) deliver out of order —
 * "Test mode" before "order created", etc.
 */
const dispatchReplies = async (waPhone, sessionId, customerId, replies, inReplyTo = null) => {
  if (!replies.length) return;
  const waMessageIds = [];
  for (const reply of replies) {
    const outbound = await waMessageRepo.createOutbound({
      waPhone,
      sessionId,
      customerId,
      payload: reply,
      inReplyTo,
    });
    waMessageIds.push(outbound.id);
  }
  await enqueue(QUEUES.WA_SEND, { waMessageIds });
};

/**
 * A business event entering the conversation from OUTSIDE — the settlement
 * sweep confirming payment. Job handler for the wa-events queue. Customers
 * who never used WhatsApp simply have no session and are skipped; telling
 * them by SMS/email is the notification engine's job, not this one's.
 */
const processEvent = async ({ type, orderId }) => {
  if (type !== "payment_confirmed") return;

  const order = await orderRepo.findByIdFull(orderId);
  if (!order) return;
  const customer = await customerRepo.findById(order.customerId);
  if (!customer?.phone) return;

  const waPhone = toE164(customer.phone) || customer.phone;
  const stored = await waSessionRepo.findByPhone(waPhone);
  if (!stored) return; // not a WhatsApp conversation — nothing to re-enter

  let session = {
    waPhone,
    customerId: customer.id,
    state: stored.state,
    cart: stored.cart || {},
    lastOrderId: stored.lastOrderId,
    failureCount: stored.failureCount || 0,
  };

  const context = await loadContext({ waPhone, customer, session });
  const result = reduce(session, { type: INBOUND.PAYMENT_CONFIRMED, order }, context);

  const saved = await waSessionRepo.save(waPhone, result.session);
  await dispatchReplies(waPhone, saved.id, customer.id, result.replies);
};

/** Send one queued outbound row; shared by single-id and batch jobs. */
const sendOne = async (waMessageId) => {
  const row = await waMessageRepo.findById(waMessageId);
  if (!row || row.direction !== "outbound") return;
  if (!["queued", "failed"].includes(row.status)) return; // sent already — a stale retry

  // Conversational replies are perishable: "what's your name?" delivered 25
  // minutes late (after an outage's retry backoff finally succeeds) is noise
  // that derails whatever the customer is doing NOW. Same rule the inbound
  // side already applies — silence beats a late answer. Event pushes
  // (in_reply_to null: payment received, cancellations) stay valuable at any
  // age and are exempt.
  if (row.inReplyTo != null && Date.now() - new Date(row.createdAt).getTime() > STALE_OUTBOUND_MS) {
    await waMessageRepo.markSkipped(row.id, "stale — conversational reply expired undelivered");
    return;
  }

  try {
    const result = await sendReply(row.waPhone, row.payload);
    if (result.skipped) {
      await waMessageRepo.markSkipped(row.id, result.reason);
      return;
    }
    await waMessageRepo.markSent(row.id, result.wamid);
  } catch (err) {
    await waMessageRepo.markFailed(row.id, err.message);
    throw err; // pg-boss owns the retry/backoff/dead-letter from here
  }
};

/**
 * Send queued outbound row(s). Job handler for the wa-send queue. Accepts a
 * batch (`waMessageIds`) so a turn's replies stay in order, or a legacy
 * single `waMessageId`. Failed rows stay retryable — pg-boss backs off and
 * eventually dead-letters, and every outcome lands on the row.
 */
const processSend = async (data) => {
  const ids =
    Array.isArray(data.waMessageIds) && data.waMessageIds.length
      ? data.waMessageIds
      : data.waMessageId != null
        ? [data.waMessageId]
        : [];
  for (const waMessageId of ids) {
    await sendOne(waMessageId);
  }
};

module.exports = { processInbound, processSend, processEvent, performEffect, MAX_TURNS };
