const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const auditLogRepo = require("../repositories/auditLog.repository");
const { transferSurplus, httpError } = require("./orderPayment.service");
const { realSurplus } = require("./orderRefund.service");
const { mayApprove, approverIds, isSuperAdmin } = require("../lib/transferApprovers");
const { scopedPfiIds } = require("../lib/pfiBankScope");

/**
 * Surplus moved between orders only after somebody else approves it.
 *
 * ── The rule (the owner's, 7 October 2026) ─────────────────────────────────
 *
 * Finance REQUESTS a move: from an order holding more than its value, to any
 * order on the same PFI, for an amount and a reason. Nothing moves. A named
 * approver (lib/transferApprovers) or any super admin — never the person who
 * asked — APPROVES it, and only then do the two payment legs get written, by
 * the same transferSurplus every transfer has always gone through. Undoing an
 * approved transfer is requested and approved the same way, and moves the
 * money back with a transfer of its own: the original stays on the record.
 *
 * ── Holding the money ──────────────────────────────────────────────────────
 *
 * A request holds its amount on the source order until it is decided, and an
 * open refund request holds its amount too. What a new request can reach is
 * the order's real surplus (orderRefund.service realSurplus — the 0021
 * duplicates and wallet-era moves taken off) less everything already held.
 * The same check runs again at approval, under the orders' locks, so money
 * spent in between is caught there rather than taken twice.
 *
 * ── The trail ──────────────────────────────────────────────────────────────
 *
 * The request row keeps who asked, why, who decided, what they said, and both
 * orders' figures as the approver was shown them and as they ended. Each step
 * is an audit row on both orders. The payment legs say which request they came
 * from and who approved it, and the transfer row names the request.
 */

const OPEN = "requested";

const money = (v) => Number(v || 0);
const round2 = (v) => Math.round(money(v) * 100) / 100;
const naira = (v) => `₦${round2(v).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rowsOf = (r) => r?.rows ?? r ?? [];
const actorFor = (staffId) => (staffId ? { type: "staff", staffId } : { type: "system" });

/** Money already promised away from an order: open transfer requests out of it, and an open refund. */
const heldOn = async (orderId, trx, { exceptRequestId = 0 } = {}) => {
  const [row] = rowsOf(await trx.execute(sql`
    SELECT
      COALESCE((SELECT SUM(t.amount) FROM order_transfer_requests t
                 WHERE t.from_order_id = ${Number(orderId)} AND t.status = ${OPEN}
                   AND t.id <> ${Number(exceptRequestId) || 0}), 0)::numeric AS transfers,
      COALESCE((SELECT SUM(r.amount) FROM order_refunds r
                 WHERE r.order_id = ${Number(orderId)} AND r.status = 'requested'
                   AND NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.refund_id = r.id)), 0)::numeric AS refunds`));
  return { transfers: round2(row.transfers), refunds: round2(row.refunds), total: round2(money(row.transfers) + money(row.refunds)) };
};

/** One order as a request shows it, and as the trail keeps it. */
const figuresOf = async (orderId, trx, opts = {}) => {
  const [o] = rowsOf(await trx.execute(sql`
    SELECT o.id, o.order_number AS "orderNumber", o.customer_id AS "customerId",
           COALESCE(NULLIF(c.company_name, ''), c.name) AS "customerName",
           o.pfi_id AS "pfiId", p.pfi_number AS "pfiNumber",
           o.status::text AS status, o.payment_status::text AS "paymentStatus",
           o.pricing_status::text AS "pricingStatus", o.merged_into_order_id AS "mergedInto"
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN pfis p ON p.id = o.pfi_id
     WHERE o.id = ${Number(orderId)}`));
  if (!o) return null;
  const real = await realSurplus(o.id, trx);
  const held = await heldOn(o.id, trx, opts);
  return {
    id: Number(o.id),
    orderNumber: o.orderNumber,
    customerId: Number(o.customerId),
    customerName: o.customerName || "",
    pfiId: o.pfiId == null ? null : Number(o.pfiId),
    pfiNumber: o.pfiNumber || "",
    status: o.status,
    paymentStatus: o.paymentStatus,
    pricingStatus: o.pricingStatus,
    mergedInto: o.mergedInto == null ? null : Number(o.mergedInto),
    total: real.total,
    received: real.received,
    // What the order owes: positive is short, negative is paid past its value.
    balance: round2(real.total - real.received),
    surplus: real.surplus,
    held: held.total,
    available: Math.max(0, round2(real.surplus - held.total)),
  };
};

/** Both orders locked, in id order, so two requests on the same pair cannot deadlock. */
const lockOrders = (trx, ids) => trx.execute(sql`
  SELECT id FROM orders WHERE id IN (${sql.join([...new Set(ids)].sort((a, b) => a - b).map((id) => sql`${id}`), sql`, `)})
   ORDER BY id FOR UPDATE`);

const staffName = async (trx, id) => {
  if (!id) return "";
  const [s] = rowsOf(await trx.execute(sql`SELECT trim(first_name || ' ' || surname) AS name FROM staff WHERE id = ${Number(id)}`));
  return s?.name || "";
};

const auditBoth = async (trx, request, action, staffId, metadata) => {
  for (const [orderId, side] of [[request.from_order_id, "from"], [request.to_order_id, "to"]]) {
    await auditLogRepo.record({
      entityType: "order",
      entityId: Number(orderId),
      action,
      actor: actorFor(staffId),
      metadata: { requestId: Number(request.id), kind: request.kind, side, amount: request.amount, ...metadata },
    }, trx);
  }
};

const loadRequest = async (trx, id, { lock = false } = {}) => {
  const [r] = rowsOf(await trx.execute(lock
    ? sql`SELECT * FROM order_transfer_requests WHERE id = ${Number(id)} FOR UPDATE`
    : sql`SELECT * FROM order_transfer_requests WHERE id = ${Number(id)}`));
  if (!r) throw httpError(404, "Transfer request not found");
  return r;
};

/** May this person see orders on this PFI? Confined staff see only their PFIs' requests. */
const assertInScope = (user, ...pfiIds) => {
  const ids = scopedPfiIds(user);
  if (ids === null) return;
  if (pfiIds.some((p) => p == null || !ids.includes(Number(p)))) throw httpError(404, "Order not found");
};

const cleanText = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

/**
 * An int list as ONE json parameter. drizzle's sql`` spreads an array into
 * separate parameters, which no ::int[] cast survives — the same trick
 * orderMerge.service and peopleMerge.service use.
 */
const intsIn = (ids) => sql`(SELECT (k.v)::int FROM jsonb_array_elements_text(${JSON.stringify((ids || []).map(Number))}::jsonb) k(v))`;

// ── Asking ──────────────────────────────────────────────────────────────────

/**
 * Ask to move surplus from one order to another. Nothing moves until approved.
 */
async function requestTransfer({ fromOrderId, toOrderId, amount, reason, note = "", user }) {
  const value = round2(amount);
  const why = cleanText(reason);
  if (!(value > 0)) throw httpError(400, "The amount must be more than ₦0.");
  if (!why) throw httpError(400, "Say why this money is moving — it is what the approver decides on, and what the record keeps.");
  if (Number(fromOrderId) === Number(toOrderId)) throw httpError(400, "An order cannot move money to itself.");

  const created = await db.transaction(async (trx) => {
    await lockOrders(trx, [Number(fromOrderId), Number(toOrderId)]);
    const from = await figuresOf(fromOrderId, trx);
    const to = await figuresOf(toOrderId, trx);
    if (!from) throw httpError(404, "The order the money is coming from was not found");
    if (!to) throw httpError(404, "The order the money is going to was not found");
    assertInScope(user, from.pfiId, to.pfiId);
    if (from.mergedInto || to.mergedInto) throw httpError(409, "One of these orders has been merged into another. Use the order it was merged into.");
    if (from.pfiId == null || from.pfiId !== to.pfiId) {
      throw httpError(409, `Surplus can only move between orders on the same PFI. ${from.orderNumber} is on ${from.pfiNumber || "no PFI"}, ${to.orderNumber} on ${to.pfiNumber || "no PFI"}.`);
    }
    if (to.status === "Cancelled") throw httpError(409, `${to.orderNumber} is cancelled, so it cannot take money.`);
    if (to.pricingStatus === "pending") throw httpError(409, `${to.orderNumber} has no price yet. Price it first, so what it owes is known.`);
    if (value > from.available + 0.005) {
      const held = from.held > 0.005 ? `, of which ${naira(from.held)} is already held by other requests or a refund` : "";
      throw httpError(400, `${from.orderNumber} holds ${naira(from.surplus)} beyond its value${held}. ${naira(from.available)} can be moved, and ${naira(value)} was asked for.`);
    }

    const [request] = rowsOf(await trx.execute(sql`
      INSERT INTO order_transfer_requests
        (kind, from_order_id, to_order_id, amount, reason, note, requested_by, from_before, to_before)
      VALUES ('transfer', ${from.id}, ${to.id}, ${value.toFixed(2)}, ${why}, ${cleanText(note)},
              ${user?.id ?? null}, ${JSON.stringify(from)}::jsonb, ${JSON.stringify(to)}::jsonb)
      RETURNING *`));
    await auditBoth(trx, request, "order.transfer_requested", user?.id, {
      fromOrder: from.orderNumber, toOrder: to.orderNumber, reason: why, note: cleanText(note),
    });
    return request;
  });
  announce(created.id, "requested");
  return created;
}

/**
 * Ask to undo an approved transfer: the money goes back the way it came, by a
 * transfer of its own. The original stays on the record.
 */
async function requestReversal({ transferId, reason, note = "", user }) {
  const why = cleanText(reason);
  if (!why) throw httpError(400, "Say why this transfer should be undone.");
  const created = await db.transaction(async (trx) => {
    const [t] = rowsOf(await trx.execute(sql`SELECT * FROM order_payment_transfers WHERE id = ${Number(transferId)} FOR UPDATE`));
    if (!t) throw httpError(404, "Transfer not found");
    const [already] = rowsOf(await trx.execute(sql`
      SELECT id, status FROM order_transfer_requests
       WHERE kind = 'reversal' AND reverses_transfer_id = ${Number(t.id)} AND status IN ('requested', 'approved')
       LIMIT 1`));
    if (already) {
      throw httpError(409, already.status === "approved"
        ? "This transfer has already been undone."
        : "There is already a request to undo this transfer, waiting for approval.");
    }
    await lockOrders(trx, [Number(t.from_order_id), Number(t.to_order_id)]);
    // The money goes back: from where it landed, to where it came from.
    const from = await figuresOf(t.to_order_id, trx);
    const to = await figuresOf(t.from_order_id, trx);
    assertInScope(user, from.pfiId, to.pfiId);
    if (from.mergedInto || to.mergedInto) throw httpError(409, "One of these orders has since been merged into another, so there is nothing left to undo here.");
    const value = round2(t.amount);
    if (value > from.available + 0.005) {
      throw httpError(409, `${from.orderNumber} needs this ${naira(value)} to cover its own value now — only ${naira(from.available)} of it could go back. Leave the transfer in place, or record a payment on ${from.orderNumber} first.`);
    }
    const [request] = rowsOf(await trx.execute(sql`
      INSERT INTO order_transfer_requests
        (kind, from_order_id, to_order_id, amount, reason, note, reverses_transfer_id, requested_by, from_before, to_before)
      VALUES ('reversal', ${from.id}, ${to.id}, ${value.toFixed(2)}, ${why}, ${cleanText(note)}, ${Number(t.id)},
              ${user?.id ?? null}, ${JSON.stringify(from)}::jsonb, ${JSON.stringify(to)}::jsonb)
      RETURNING *`));
    await auditBoth(trx, request, "order.transfer_requested", user?.id, {
      fromOrder: from.orderNumber, toOrder: to.orderNumber, reason: why, reversesTransferId: Number(t.id),
    });
    return request;
  });
  announce(created.id, "requested");
  return created;
}

// ── Deciding ────────────────────────────────────────────────────────────────

const assertMayDecide = (user, request) => {
  if (!mayApprove(user)) {
    throw httpError(403, "Only the CFO, a named approver or a super admin can decide transfer requests.");
  }
  if (Number(request.requested_by) === Number(user.id)) {
    throw httpError(403, "You asked for this transfer, so somebody else has to decide it.");
  }
  if (request.status !== OPEN) {
    throw httpError(409, `This request has already been ${request.status}.`);
  }
};

/** Approve: the money moves now, through transferSurplus, or not at all. */
async function approve({ requestId, note = "", user }) {
  const done = await db.transaction(async (trx) => {
    const request = await loadRequest(trx, requestId, { lock: true });
    assertMayDecide(user, request);
    await lockOrders(trx, [Number(request.from_order_id), Number(request.to_order_id)]);
    const from = await figuresOf(request.from_order_id, trx, { exceptRequestId: request.id });
    const to = await figuresOf(request.to_order_id, trx);
    assertInScope(user, from.pfiId, to.pfiId);
    const value = round2(request.amount);
    if (value > from.available + 0.005) {
      throw httpError(409, `${from.orderNumber} can only spare ${naira(from.available)} now — its payments or other requests changed since this was asked for ${naira(value)}. Reject it, and ask again for what is there.`);
    }

    const approver = await staffName(trx, user.id);
    const label = request.kind === "reversal"
      ? `Reversal of transfer #${request.reverses_transfer_id}: ${request.reason} (request #${request.id}, approved by ${approver || "an approver"})`
      : `${request.reason} (request #${request.id}, approved by ${approver || "an approver"})`;
    const result = await transferSurplus({
      fromOrderId: Number(request.from_order_id),
      toOrderId: Number(request.to_order_id),
      amount: value,
      reason: label,
      staffId: user.id,
    }, trx);
    const transferId = Number(result.transfer.id);
    await trx.execute(sql`UPDATE order_payment_transfers SET request_id = ${Number(request.id)} WHERE id = ${transferId}`);

    const fromAfter = await figuresOf(request.from_order_id, trx, { exceptRequestId: request.id });
    const toAfter = await figuresOf(request.to_order_id, trx);
    const [updated] = rowsOf(await trx.execute(sql`
      UPDATE order_transfer_requests
         SET status = 'approved', decided_by = ${user.id}, decided_at = now(), decision_note = ${cleanText(note)},
             transfer_id = ${transferId}, from_after = ${JSON.stringify(fromAfter)}::jsonb,
             to_after = ${JSON.stringify(toAfter)}::jsonb, updated_at = now()
       WHERE id = ${Number(request.id)}
      RETURNING *`));
    await auditBoth(trx, updated, "order.transfer_approved", user.id, {
      transferId, fromOrder: from.orderNumber, toOrder: to.orderNumber, note: cleanText(note),
      reversesTransferId: request.reverses_transfer_id ?? undefined,
    });
    return updated;
  });
  announce(done.id, "approved");
  return done;
}

/** Reject: nothing moves, and the held amount is free again. */
async function reject({ requestId, note, user }) {
  const why = cleanText(note);
  if (!why) throw httpError(400, "Say why it is rejected — the person who asked will be told.");
  const done = await db.transaction(async (trx) => {
    const request = await loadRequest(trx, requestId, { lock: true });
    assertMayDecide(user, request);
    const from = await figuresOf(request.from_order_id, trx);
    const to = await figuresOf(request.to_order_id, trx);
    assertInScope(user, from?.pfiId, to?.pfiId);
    const [updated] = rowsOf(await trx.execute(sql`
      UPDATE order_transfer_requests
         SET status = 'rejected', decided_by = ${user.id}, decided_at = now(), decision_note = ${why},
             from_after = ${JSON.stringify(from)}::jsonb, to_after = ${JSON.stringify(to)}::jsonb, updated_at = now()
       WHERE id = ${Number(request.id)}
      RETURNING *`));
    await auditBoth(trx, updated, "order.transfer_rejected", user.id, { note: why });
    return updated;
  });
  announce(done.id, "rejected");
  return done;
}

/** Withdraw: by whoever asked, or a super admin, while it still waits. */
async function cancel({ requestId, note = "", user }) {
  return db.transaction(async (trx) => {
    const request = await loadRequest(trx, requestId, { lock: true });
    if (request.status !== OPEN) throw httpError(409, `This request has already been ${request.status}.`);
    if (Number(request.requested_by) !== Number(user?.id) && !isSuperAdmin(user)) {
      throw httpError(403, "Only the person who asked, or a super admin, can withdraw this request.");
    }
    const [updated] = rowsOf(await trx.execute(sql`
      UPDATE order_transfer_requests
         SET status = 'cancelled', decided_by = ${user.id}, decided_at = now(),
             decision_note = ${cleanText(note) || "Withdrawn"}, updated_at = now()
       WHERE id = ${Number(request.id)}
      RETURNING *`));
    await auditBoth(trx, updated, "order.transfer_cancelled", user.id, { note: cleanText(note) });
    return updated;
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Every request, newest first, with the names and order numbers a desk reads,
 * and what the source order can spare now — a waiting request larger than
 * that is out of date before anybody approves it.
 */
async function list({ status = "", search = "", pfiId = null, orderId = null, user, limit = 500 } = {}) {
  const scoped = scopedPfiIds(user);
  const term = `%${String(search || "").trim()}%`;
  const rows = rowsOf(await db.execute(sql`
    SELECT r.id, r.kind, r.status, r.amount::text AS amount, r.reason, r.note, r.decision_note AS "decisionNote",
           r.requested_at AS "requestedAt", r.decided_at AS "decidedAt",
           r.requested_by AS "requestedBy", r.decided_by AS "decidedBy",
           r.transfer_id AS "transferId", r.reverses_transfer_id AS "reversesTransferId",
           r.from_before AS "fromBefore", r.to_before AS "toBefore", r.from_after AS "fromAfter", r.to_after AS "toAfter",
           r.from_order_id AS "fromOrderId", fo.order_number AS "fromOrderNumber",
           COALESCE(NULLIF(fc.company_name, ''), fc.name) AS "fromCustomer",
           r.to_order_id AS "toOrderId", tor.order_number AS "toOrderNumber",
           COALESCE(NULLIF(tc.company_name, ''), tc.name) AS "toCustomer",
           fo.pfi_id AS "pfiId", p.pfi_number AS "pfiNumber",
           trim(rq.first_name || ' ' || rq.surname) AS "requestedByName",
           trim(dc.first_name || ' ' || dc.surname) AS "decidedByName",
           EXISTS (SELECT 1 FROM order_transfer_requests x
                    WHERE x.kind = 'reversal' AND x.reverses_transfer_id = r.transfer_id AND x.status = 'approved') AS "reversed",
           EXISTS (SELECT 1 FROM order_transfer_requests x
                    WHERE x.kind = 'reversal' AND x.reverses_transfer_id = r.transfer_id AND x.status = 'requested') AS "reversalPending"
      FROM order_transfer_requests r
      JOIN orders fo ON fo.id = r.from_order_id
      JOIN customers fc ON fc.id = fo.customer_id
      JOIN orders tor ON tor.id = r.to_order_id
      JOIN customers tc ON tc.id = tor.customer_id
      LEFT JOIN pfis p ON p.id = fo.pfi_id
      LEFT JOIN staff rq ON rq.id = r.requested_by
      LEFT JOIN staff dc ON dc.id = r.decided_by
     WHERE (${status || ""} = '' OR r.status = ${status || ""})
       AND (${pfiId == null ? 0 : Number(pfiId)} = 0 OR fo.pfi_id = ${pfiId == null ? 0 : Number(pfiId)})
       AND (${orderId == null ? 0 : Number(orderId)} = 0 OR r.from_order_id = ${orderId == null ? 0 : Number(orderId)} OR r.to_order_id = ${orderId == null ? 0 : Number(orderId)})
       AND (${scoped === null} OR fo.pfi_id IN ${intsIn(scoped)})
       AND (${term} = '%%' OR fo.order_number ILIKE ${term} OR tor.order_number ILIKE ${term}
            OR fc.name ILIKE ${term} OR fc.company_name ILIKE ${term} OR tc.name ILIKE ${term} OR tc.company_name ILIKE ${term}
            OR r.reason ILIKE ${term} OR p.pfi_number ILIKE ${term})
     ORDER BY r.requested_at DESC, r.id DESC
     LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 500))}`));

  // What each waiting request's source can spare now, besides that request.
  const open = rows.filter((r) => r.status === OPEN);
  const spare = new Map();
  for (const r of open) {
    const f = await figuresOf(r.fromOrderId, db, { exceptRequestId: r.id });
    spare.set(r.id, f?.available ?? 0);
  }
  const approver = mayApprove(user);
  return rows.map((r) => {
    const available = spare.get(r.id);
    return {
      ...r,
      id: Number(r.id),
      amount: Number(r.amount),
      availableNow: available == null ? null : available,
      stale: available != null && Number(r.amount) > available + 0.005,
      canDecide: r.status === OPEN && approver && Number(r.requestedBy) !== Number(user?.id),
      canCancel: r.status === OPEN && (Number(r.requestedBy) === Number(user?.id) || isSuperAdmin(user)),
      canReverse: r.status === "approved" && r.kind === "transfer" && !r.reversed && !r.reversalPending,
    };
  });
}

/** What an order can spare, and what is held on it — for the request form. */
async function spareOn(orderId, user) {
  const f = await figuresOf(orderId, db);
  if (!f) throw httpError(404, "Order not found");
  assertInScope(user, f.pfiId);
  return f;
}

// ── Telling people ──────────────────────────────────────────────────────────

/**
 * The approvers hear of a new request; whoever asked hears how it ended.
 * After the commit, and never thrown: a notice that fails must not undo a
 * decision about money.
 */
async function announce(requestId, event) {
  try {
    const { notify } = require("../notifications");
    const [r] = rowsOf(await db.execute(sql`
      SELECT r.id, r.kind, r.status, r.amount::text AS amount, r.reason, r.decision_note, r.requested_by,
             fo.id AS from_id, fo.order_number AS from_number, tor.order_number AS to_number,
             COALESCE(NULLIF(fc.company_name, ''), fc.name) AS from_customer,
             COALESCE(NULLIF(tc.company_name, ''), tc.name) AS to_customer,
             trim(rq.first_name || ' ' || rq.surname) AS requested_by_name,
             trim(dc.first_name || ' ' || dc.surname) AS decided_by_name
        FROM order_transfer_requests r
        JOIN orders fo ON fo.id = r.from_order_id JOIN customers fc ON fc.id = fo.customer_id
        JOIN orders tor ON tor.id = r.to_order_id JOIN customers tc ON tc.id = tor.customer_id
        LEFT JOIN staff rq ON rq.id = r.requested_by LEFT JOIN staff dc ON dc.id = r.decided_by
       WHERE r.id = ${Number(requestId)}`));
    if (!r || r.status !== (event === "requested" ? OPEN : event)) return;
    const data = {
      requestId: Number(r.id), kind: r.kind, orderId: Number(r.from_id), amount: Number(r.amount),
      fromOrder: r.from_number, toOrder: r.to_number, fromCustomer: r.from_customer || "", toCustomer: r.to_customer || "",
      reason: r.reason, requestedByName: r.requested_by_name || "", decidedByName: r.decided_by_name || "",
      decisionNote: r.decision_note || "", outcome: event,
    };
    if (event === "requested") {
      const named = rowsOf(await db.execute(sql`
        SELECT id FROM staff WHERE is_active = true
           AND (id IN ${intsIn(approverIds())} OR 'super_admin' = ANY(roles))
           AND id <> ${Number(r.requested_by) || 0}`)).map((s) => ({ staffId: Number(s.id) }));
      if (named.length) await notify("staff.transfer_requested", { to: named, data });
    } else if (r.requested_by) {
      await notify("staff.transfer_decided", { to: { staffId: Number(r.requested_by) }, data });
    }
  } catch (err) {
    console.error(`[transfers] could not announce request ${requestId} ${event}:`, err.message);
  }
}

module.exports = {
  requestTransfer, requestReversal, approve, reject, cancel, list, spareOn, heldOn, figuresOf,
};
