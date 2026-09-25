const { sql } = require("drizzle-orm");
const { randomUUID } = require("crypto");
const { db } = require("../config/db");
const auditLogRepo = require("../repositories/auditLog.repository");
const { generateOrderReference } = require("../utils/helpers");
const { DUPLICATE_LEGACY_IDS_SQL } = require("../repositories/cfoReport.repository");
const { RESURRECTED_PAYMENT_IDS_SQL } = require("./orderRefund.service");
const { recomputeOrder, httpError } = require("./orderPayment.service");
// Lazily, like orderPayment.service does: orderStatus reaches the notification
// engine, and order.service reaches almost everything.
const orderStatus = () => require("./orderStatus.service");
const orderService = () => require("./order.service");

/**
 * Several orders at one unit price, folded into one.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A customer buying the same product from the same depot at the same price
 * ends up with three orders where there should be one — placed on three
 * calls, or split by the desk, or raised twice by mistake. Each carries part
 * of the money, part of the trucks and part of the stock, and every figure
 * about the customer has to be added up by hand across them.
 *
 * ── What "the same order" has to mean ──────────────────────────────────────
 *
 * The user's rule is the unit price. The rest below is what the data model
 * requires for one order row to honestly hold them all: an order names ONE
 * customer, ONE product, ONE depot, ONE PFI and one delivery type, so orders
 * that differ in any of those cannot become one row without one of the
 * differences being silently thrown away.
 *
 * ── The rule everything here follows ───────────────────────────────────────
 *
 * Nothing is destroyed. One order survives. Every payment, truck, ticket,
 * refund and stock row the others carry is re-pointed at it; its quantity and
 * value become the sums of theirs; and the others stay behind as empty,
 * Cancelled orders that name where they went (orders.merged_into_order_id),
 * because their references are already on bank narrations and paper tickets.
 *
 * Money totals do not move. A payment row changes which order it sits on and
 * nothing else — its amount, its bank line and its date stay exactly as they
 * were — so the customer's total received, and the report's total, are the
 * same after a merge as before it. What does change is the per-order rows of
 * the finance report, which is audited; the user accepted that on condition
 * every merge is recorded with its before and after figures (order_merges).
 *
 * ── Why it is one transaction ──────────────────────────────────────────────
 *
 * Half a merge is a payment on one order and the trucks it paid for on
 * another. Everything below runs in one transaction, every order involved is
 * locked first (in id order, so two merges cannot deadlock each other), and a
 * failure anywhere leaves the book exactly as it was.
 */

/** Merging is a desk decision about a handful of orders, not a bulk job. */
const MAX_SOURCES = 20;

/** Orders that still describe a real sale. Cancelled and Expired do not. */
const LIVE_STATUSES = ["Pending", "Paid", "Released", "Loading", "Completed"];
const STAGE_RANK = { Pending: 0, Paid: 1, Released: 2, Loading: 3, Completed: 4 };

/**
 * The last day of the audited finance report. Orders whose first payment is
 * on or before it appear on the signed-off figures, and a merge changes their
 * rows there — the preview says so before anybody presses the button.
 */
const AUDIT_SIGNED_OFF_THROUGH = "2026-09-10";

const money = (value) => Number(value || 0);
const kobo = (value) => Math.round(money(value) * 100);
const round2 = (value) => Math.round(money(value) * 100) / 100;
const naira = (value) =>
  `₦${money(value).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rowsOf = (result) => result?.rows ?? result ?? [];
const actorFor = (staffId) => (staffId ? { type: "staff", staffId } : { type: "system" });

/** An int list as ONE json parameter — the same trick peopleMerge.service uses. */
const idList = (ids) =>
  sql`(SELECT (k.v)::int FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) k(v))`;

const referenceOf = (order) =>
  generateOrderReference(order.companyName || order.customerCompany || "", order.id);

/** Distinct positive ids, in the order given, with the survivor removed. */
const cleanSources = (sourceOrderIds, targetId) => {
  const seen = new Set([targetId]);
  const out = [];
  for (const raw of sourceOrderIds || []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

// ── Reading the orders ──────────────────────────────────────────────────────

const ORDER_COLUMNS = sql`
  o.id, o.customer_id AS "customerId", o.product_id AS "productId", o.depot_id AS "depotId",
  o.pfi_id AS "pfiId", o.delivery_type::text AS "deliveryType",
  o.delivery_address AS "deliveryAddress", o.company_name AS "companyName",
  c.company_name AS "customerCompany", c.name AS "customerName",
  pr.name AS "productName", pr.unit AS "productUnit", d.name AS "depotName",
  o.quantity, o.price::text AS price, o.total_amount::text AS "totalAmount",
  o.amount_paid::text AS "amountPaid", o.payment_status::text AS "paymentStatus",
  o.status::text AS status, o.pricing_status::text AS "pricingStatus",
  o.credit_qty::text AS "creditQty", o.credit_reason AS "creditReason",
  o.credit_authorised_by AS "creditAuthorisedBy", o.credit_authorised_at AS "creditAuthorisedAt",
  o.expected_trucks AS "expectedTrucks", o.payment_confirmed_at AS "paymentConfirmedAt",
  o.released_at AS "releasedAt", o.released_by AS "releasedBy",
  o.loading_started_at AS "loadingStartedAt", o.completed_at AS "completedAt",
  o.created_at AS "createdAt", o.merged_into_order_id AS "mergedIntoOrderId"`;

const ORDER_FROM = sql`
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN products pr ON pr.id = o.product_id
  LEFT JOIN depots d ON d.id = o.depot_id`;

const shape = (row) => ({
  ...row,
  id: Number(row.id),
  quantity: Number(row.quantity),
  reference: referenceOf(row),
});

/**
 * The orders, keyed by id. With `lock`, every row is taken FOR UPDATE in id
 * order — the order the lock is requested in is what keeps two overlapping
 * merges from deadlocking.
 */
const loadOrders = async (ids, tx, { lock = false } = {}) => {
  if (!ids.length) return new Map();
  const result = await tx.execute(sql`
    SELECT ${ORDER_COLUMNS}
    ${ORDER_FROM}
    WHERE o.id IN ${idList(ids)}
    ORDER BY o.id
    ${lock ? sql`FOR UPDATE OF o` : sql``}
  `);
  return new Map(rowsOf(result).map((row) => [Number(row.id), shape(row)]));
};

/**
 * What each order is carrying, counted in one statement.
 *
 * `phantoms` is the one that decides anything on its own. Two rules elsewhere
 * recognise payment rows that are not money — the migration-0021 duplicate
 * (DUPLICATE_LEGACY_IDS_SQL) and the backfilled row that came back after a
 * person removed it (RESURRECTED_PAYMENT_IDS_SQL) — and BOTH are keyed on the
 * order the row sits on: the first on that order's total, the second on audit
 * rows naming that order. Move such a row to another order and neither rule
 * recognises it any more, so it would start counting as real overpayment and
 * become refundable cash. Those orders are refused until somebody settles the
 * row where it is.
 */
const loadFacts = async (ids, tx) => {
  if (!ids.length) return new Map();
  const dup = sql.raw(DUPLICATE_LEGACY_IDS_SQL);
  const back = sql.raw(RESURRECTED_PAYMENT_IDS_SQL);
  const result = await tx.execute(sql`
    SELECT o.id,
      (SELECT COUNT(*) FROM order_payments p WHERE p.order_id = o.id)::int AS payments,
      (SELECT COUNT(*) FROM order_trucks t WHERE t.order_id = o.id)::int AS trucks,
      (SELECT COUNT(*) FROM tickets k WHERE k.order_id = o.id)::int AS tickets,
      (SELECT COUNT(*) FROM order_refunds r WHERE r.order_id = o.id)::int AS refunds,
      (SELECT COUNT(*) FROM order_refunds r
        WHERE r.order_id = o.id AND r.status = 'requested')::int AS "openRefunds",
      (SELECT COUNT(*) FROM wallet_holds h WHERE h.order_id = o.id)::int AS "walletHolds",
      (SELECT COUNT(*) FROM commissions cm
        WHERE cm.order_id = o.id AND cm.status = 'paid')::int AS "paidCommissions",
      (SELECT COUNT(*) FROM order_payments p
        WHERE p.order_id = o.id AND (p.id IN (${dup}) OR p.id IN (${back})))::int AS phantoms
    FROM orders o
    WHERE o.id IN ${idList(ids)}
  `);
  return new Map(rowsOf(result).map((row) => [Number(row.id), row]));
};

/** Stock rows that disagree about which cargo they came from, by action. */
const mixedMovements = async (ids, tx) => {
  const result = await tx.execute(sql`
    SELECT action FROM pfi_movements
     WHERE order_id IN ${idList(ids)}
     GROUP BY action
    HAVING COUNT(DISTINCT pfi_id) > 1
  `);
  return rowsOf(result).map((row) => row.action);
};

// ── The rules ───────────────────────────────────────────────────────────────

/**
 * Why this one order cannot take part in any merge, whatever it is merged
 * with. Separate from the pairwise rules so the candidate list can show, per
 * order, the reason it is greyed out.
 */
const ownBlockers = (order, facts) => {
  const out = [];
  const ref = order.reference;
  if (order.mergedIntoOrderId) {
    out.push(`${ref} has already been merged into another order.`);
    return out;
  }
  if (!LIVE_STATUSES.includes(order.status)) {
    out.push(`${ref} is ${order.status.toLowerCase()} — only live orders can be merged.`);
    return out;
  }
  if (order.pricingStatus === "pending") {
    out.push(`${ref} has no price yet, so there is no unit price to match. Price it first.`);
  }
  if (orderService().isOrderExpired(order)) {
    out.push(`${ref} has passed its payment deadline and is about to lapse.`);
  }
  if (facts?.phantoms > 0) {
    out.push(
      `${ref} carries a payment row that is not real money (a migration-0021 duplicate, or one that came back after being removed). Moved to another order it would read as a refundable overpayment. Settle it on ${ref} first.`,
    );
  }
  if (facts?.openRefunds > 0) {
    out.push(
      `${ref} has a refund request waiting to be paid. Pay or cancel it first — the merged order's overpayment will be a different figure.`,
    );
  }
  return out;
};

/** Why `source` cannot be folded into `target` specifically. */
const pairBlockers = (target, source) => {
  const out = [];
  const ref = source.reference;
  if (source.customerId !== target.customerId) {
    out.push(`${ref} belongs to ${source.customerName}, not ${target.customerName}.`);
  }
  if (source.productId !== target.productId) {
    out.push(`${ref} is for ${source.productName}, not ${target.productName}.`);
  }
  if (source.depotId !== target.depotId) {
    out.push(`${ref} loads at ${source.depotName}, not ${target.depotName}.`);
  }
  if (source.deliveryType !== target.deliveryType) {
    out.push(`${ref} is a ${source.deliveryType} order and ${target.reference} is a ${target.deliveryType} order.`);
  }
  if ((source.pfiId ?? null) !== (target.pfiId ?? null)) {
    out.push(`${ref} is drawn from a different PFI.`);
  }
  if (kobo(source.price) !== kobo(target.price)) {
    out.push(`${ref} is priced at ${naira(source.price)} per unit, not ${naira(target.price)}.`);
  }
  return out;
};

/**
 * The stage the merged order is at.
 *
 * All Completed stays Completed. Anything that has had a truck through the
 * gate — Loading, or a Completed order merged with one that has not finished —
 * is Loading: trucks have gone and there are more to come, which is exactly
 * what Loading means. Otherwise the furthest-along of Pending/Paid/Released,
 * since a merge must not take away a release somebody already gave.
 */
const combinedStatus = (orders) => {
  const statuses = orders.map((o) => o.status);
  if (statuses.every((s) => s === "Completed")) return "Completed";
  if (statuses.some((s) => s === "Loading" || s === "Completed")) return "Loading";
  return statuses.reduce((best, s) => (STAGE_RANK[s] > STAGE_RANK[best] ? s : best), "Pending");
};

const earliest = (values) => {
  const times = values.filter(Boolean).map((v) => new Date(v).getTime());
  return times.length ? new Date(Math.min(...times)) : null;
};
const latest = (values) => {
  const times = values.filter(Boolean).map((v) => new Date(v).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

/** The surviving order's own columns after the merge. Pure — the preview shows it. */
const combine = (target, sources) => {
  const all = [target, ...sources];
  const status = combinedStatus(all);

  const withCredit = all.filter((o) => money(o.creditQty) > 0);
  const creditQty = round2(withCredit.reduce((sum, o) => sum + money(o.creditQty), 0));
  // The most recent authorisation stands for the whole allowance: somebody
  // signed for credit on these orders, and the CHECK in 0048 needs one name.
  // Every reason survives, so nothing anybody wrote is lost.
  const lastGrant = withCredit
    .slice()
    .sort((a, b) => new Date(b.creditAuthorisedAt || 0) - new Date(a.creditAuthorisedAt || 0))[0];
  const reasons = [...new Set(withCredit.map((o) => (o.creditReason || "").trim()).filter(Boolean))];

  const trucksKnown = all.filter((o) => o.expectedTrucks != null);
  const firstRelease = all
    .filter((o) => o.releasedAt)
    .sort((a, b) => new Date(a.releasedAt) - new Date(b.releasedAt))[0];

  return {
    status,
    quantity: all.reduce((sum, o) => sum + Number(o.quantity), 0),
    totalAmount: round2(all.reduce((sum, o) => sum + money(o.totalAmount), 0)),
    received: round2(all.reduce((sum, o) => sum + money(o.amountPaid), 0)),
    creditQty,
    creditReason: creditQty > 0 ? reasons.join(" · ") : target.creditReason || "",
    creditAuthorisedBy: creditQty > 0 ? lastGrant.creditAuthorisedBy : null,
    creditAuthorisedAt: creditQty > 0 ? lastGrant.creditAuthorisedAt : null,
    expectedTrucks: trucksKnown.length
      ? trucksKnown.reduce((sum, o) => sum + Number(o.expectedTrucks), 0)
      : null,
    paymentConfirmedAt: earliest(all.map((o) => o.paymentConfirmedAt)),
    releasedAt: firstRelease?.releasedAt ?? null,
    releasedBy: firstRelease?.releasedBy ?? null,
    loadingStartedAt: earliest(all.map((o) => o.loadingStartedAt)),
    completedAt: status === "Completed" ? latest(all.map((o) => o.completedAt)) : null,
  };
};

/** The figures an auditor reconciles against — before, and after. */
const snapshot = (order) => ({
  id: order.id,
  reference: order.reference,
  status: order.status,
  quantity: Number(order.quantity),
  price: order.price,
  totalAmount: order.totalAmount,
  amountPaid: order.amountPaid,
  paymentStatus: order.paymentStatus,
  paymentConfirmedAt: order.paymentConfirmedAt,
  creditQty: order.creditQty,
  companyName: order.companyName || order.customerCompany || "",
  createdAt: order.createdAt,
});

/**
 * Everything the merge would do, and everything stopping it — shared by the
 * preview and the merge itself, so the two cannot tell different stories.
 */
const assess = async ({ targetId, sourceIds, tx, lock }) => {
  if (!sourceIds.length) throw httpError(400, "Choose at least one other order to merge into this one.");
  if (sourceIds.length > MAX_SOURCES) {
    throw httpError(400, `At most ${MAX_SOURCES} orders can be merged at once.`);
  }

  const ids = [targetId, ...sourceIds];
  const orders = await loadOrders(ids, tx, { lock });
  const target = orders.get(targetId);
  if (!target) throw httpError(404, "Order not found");
  const missing = sourceIds.filter((id) => !orders.has(id));
  if (missing.length) throw httpError(404, `Order${missing.length === 1 ? "" : "s"} not found: #${missing.join(", #")}`);
  const sources = sourceIds.map((id) => orders.get(id));

  const facts = await loadFacts(ids, tx);
  const problems = [];
  for (const order of [target, ...sources]) problems.push(...ownBlockers(order, facts.get(order.id)));
  for (const source of sources) problems.push(...pairBlockers(target, source));

  // wallet_holds allows one row per order, and a merge cannot sum two holds
  // into one without inventing a figure the old wallet never recorded.
  const holders = [target, ...sources].filter((o) => facts.get(o.id)?.walletHolds > 0);
  if (holders.length > 1) {
    problems.push(
      `${holders.map((o) => o.reference).join(" and ")} each carry a hold from the old wallet system. Resolve all but one first.`,
    );
  }

  const mixed = await mixedMovements(ids, tx);
  if (mixed.length) {
    problems.push(
      `These orders have recorded stock leaving from different PFIs (${mixed.join(", ")}). Correct the PFI on the order that is wrong first.`,
    );
  }

  const warnings = [];
  const company = (o) => (o.companyName || o.customerCompany || "").trim();
  const otherCompanies = sources.filter((s) => company(s).toLowerCase() !== company(target).toLowerCase());
  if (otherCompanies.length) {
    warnings.push(
      `The merged order is for ${company(target) || "the customer's own company"}. ${otherCompanies
        .map((s) => `${s.reference} was for ${company(s) || "the customer's own company"}`)
        .join("; ")}.`,
    );
  }
  if (target.deliveryType === "delivery") {
    const elsewhere = sources.filter(
      (s) => (s.deliveryAddress || "").trim() && (s.deliveryAddress || "").trim() !== (target.deliveryAddress || "").trim(),
    );
    if (elsewhere.length) {
      warnings.push(
        `The merged order delivers to ${target.deliveryAddress || "no stated address"}. ${elsewhere
          .map((s) => `${s.reference} was going to ${s.deliveryAddress}`)
          .join("; ")}.`,
      );
    }
  }
  const audited = [target, ...sources].filter(
    (o) => o.paymentConfirmedAt && new Date(o.paymentConfirmedAt) < new Date(`${AUDIT_SIGNED_OFF_THROUGH}T23:00:00Z`),
  );
  if (audited.length) {
    warnings.push(
      `${audited.map((o) => o.reference).join(", ")} ${audited.length === 1 ? "is" : "are"} on the audited finance report. Their rows there will change. Totals do not move, and this merge is recorded with every order's figures before and after.`,
    );
  }
  const paidCommission = sources.filter((s) => facts.get(s.id)?.paidCommissions > 0);
  if (paidCommission.length) {
    warnings.push(
      `Commission on ${paidCommission.map((s) => s.reference).join(", ")} has already been paid out. It moves across as it stands and is not recalculated.`,
    );
  }

  const sum = (key) => [target, ...sources].reduce((n, o) => n + Number(facts.get(o.id)?.[key] || 0), 0);
  const moving = (key) => sources.reduce((n, s) => n + Number(facts.get(s.id)?.[key] || 0), 0);

  return {
    target,
    sources,
    problems,
    warnings,
    result: combine(target, sources),
    moving: {
      payments: moving("payments"),
      trucks: moving("trucks"),
      tickets: moving("tickets"),
      refunds: moving("refunds"),
    },
    totals: { payments: sum("payments"), trucks: sum("trucks"), tickets: sum("tickets") },
  };
};

const outward = ({ target, sources, problems, warnings, result, moving, totals }) => ({
  ok: problems.length === 0,
  target: snapshot(target),
  sources: sources.map(snapshot),
  problems,
  warnings,
  result: {
    ...result,
    reference: target.reference,
    unitPrice: target.price,
    unit: target.productUnit || "Liters",
  },
  moving,
  totals,
});

// ── Reading ─────────────────────────────────────────────────────────────────

/** POST /orders/:id/merge/preview — nothing is written. */
const previewMerge = async ({ targetOrderId, sourceOrderIds }) => {
  const targetId = Number(targetOrderId);
  const sourceIds = cleanSources(sourceOrderIds, targetId);
  return outward(await assess({ targetId, sourceIds, tx: db, lock: false }));
};

/**
 * GET /orders/:id/merges — this order's merge history, and which of the
 * customer's other orders could be folded into it.
 *
 * Candidates are found by the pairwise rules (same customer, product, depot,
 * PFI, delivery type and unit price); each still carries its own blockers, so
 * the screen can show a matching order greyed out with the reason rather than
 * leave the desk wondering why it is missing.
 */
const mergeOverview = async (orderId) => {
  const id = Number(orderId);
  const orders = await loadOrders([id], db);
  const order = orders.get(id);
  if (!order) throw httpError(404, "Order not found");

  const history = rowsOf(
    await db.execute(sql`
      SELECT m.source_order_id AS "orderId", m.target_order_id AS "targetOrderId",
             m.source_before AS before, m.reason, m.created_at AS "mergedAt",
             TRIM(CONCAT(s.first_name, ' ', s.surname)) AS "mergedBy"
        FROM order_merges m
        LEFT JOIN staff s ON s.id = m.merged_by
       WHERE m.target_order_id = ${id} OR m.source_order_id = ${id}
       ORDER BY m.created_at, m.source_order_id
    `),
  );
  const mergedFrom = history
    .filter((h) => Number(h.targetOrderId) === id)
    .map((h) => ({
      orderId: Number(h.orderId),
      reference: h.before?.reference ?? `#${h.orderId}`,
      quantity: h.before?.quantity ?? null,
      totalAmount: h.before?.totalAmount ?? null,
      amountPaid: h.before?.amountPaid ?? null,
      reason: h.reason,
      mergedAt: h.mergedAt,
      mergedBy: h.mergedBy || null,
    }));

  let mergedInto = null;
  if (order.mergedIntoOrderId) {
    const into = (await loadOrders([Number(order.mergedIntoOrderId)], db)).get(Number(order.mergedIntoOrderId));
    const own = history.find((h) => Number(h.orderId) === id);
    mergedInto = {
      orderId: Number(order.mergedIntoOrderId),
      reference: into?.reference ?? `#${order.mergedIntoOrderId}`,
      reason: own?.reason ?? "",
      mergedAt: own?.mergedAt ?? null,
      mergedBy: own?.mergedBy ?? null,
    };
  }

  const facts = await loadFacts([id], db);
  const blockers = ownBlockers(order, facts.get(id));

  let candidates = [];
  if (!blockers.length) {
    const found = rowsOf(
      await db.execute(sql`
        SELECT ${ORDER_COLUMNS}
        ${ORDER_FROM}
        WHERE o.customer_id = ${order.customerId}
          AND o.product_id = ${order.productId}
          AND o.depot_id = ${order.depotId}
          AND o.delivery_type::text = ${order.deliveryType}
          AND o.pfi_id IS NOT DISTINCT FROM ${order.pfiId ?? null}::int
          AND o.price = ${order.price}::numeric
          AND o.status::text IN ${idListText(LIVE_STATUSES)}
          AND o.merged_into_order_id IS NULL
          AND o.id <> ${id}
        ORDER BY o.created_at
        LIMIT 100
      `),
    ).map(shape);
    const candidateFacts = await loadFacts(found.map((o) => o.id), db);
    candidates = found.map((o) => ({
      ...snapshot(o),
      blockers: ownBlockers(o, candidateFacts.get(o.id)),
    }));
  }

  return { reference: order.reference, mergedInto, mergedFrom, blockers, candidates };
};

/** A text list as one json parameter, for `IN`. */
const idListText = (values) =>
  sql`(SELECT k.v FROM jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) k(v))`;

// ── The merge ───────────────────────────────────────────────────────────────

/**
 * Re-point everything the merged-away orders own at the survivor.
 *
 * Written table by table, because the tables do not all move the same way:
 *
 *   - Most simply change their order id.
 *   - Trucks are renumbered after the survivor's own, so "truck 1" stays
 *     unambiguous on the merged order.
 *   - The one-row-per-order tables (PFI allocations per cargo, stock
 *     movements per action, wallet allocations per deposit) are SUMMED into
 *     the survivor's row, so the stock the orders reserved and released is
 *     exactly what it was — just held on one order.
 *   - Transfers between two orders that are merging stay as history: both
 *     legs land on the survivor and cancel out, and rewriting the transfer to
 *     run from the survivor to itself would be a row that means nothing (the
 *     table forbids it). Transfers to or from any other order are re-pointed.
 *   - Commission that has not been paid is dropped and recomputed on the
 *     merged order afterwards; paid commission is history and moves as is.
 *   - A decision not to refund an overpayment (a skip) was a judgement about
 *     that order's surplus at that time. The merged order's surplus is a
 *     different figure, so the skip is lifted — the order comes back onto the
 *     refunds list for somebody to judge afresh, which is what lifting a skip
 *     already means.
 */
const repoint = async ({ tx, targetId, sourceIds, allIds, staffId, targetRef }) => {
  const S = idList(sourceIds);
  const ALL = idList(allIds);

  await tx.execute(sql`UPDATE order_payments SET order_id = ${targetId}, updated_at = now() WHERE order_id IN ${S}`);

  await tx.execute(sql`
    UPDATE order_payment_transfers SET from_order_id = ${targetId}
     WHERE from_order_id IN ${S} AND to_order_id NOT IN ${ALL}`);
  await tx.execute(sql`
    UPDATE order_payment_transfers SET to_order_id = ${targetId}
     WHERE to_order_id IN ${S} AND from_order_id NOT IN ${ALL}`);

  await tx.execute(sql`
    WITH base AS (
      SELECT COALESCE(MAX(truck_index), 0) AS n FROM order_trucks WHERE order_id = ${targetId}
    ), moved AS (
      SELECT t.id, ROW_NUMBER() OVER (ORDER BY t.order_id, t.truck_index, t.id) AS rn
        FROM order_trucks t WHERE t.order_id IN ${S}
    )
    UPDATE order_trucks ot
       SET order_id = ${targetId}, truck_index = (SELECT n FROM base) + moved.rn, updated_at = now()
      FROM moved
     WHERE ot.id = moved.id`);
  await tx.execute(sql`UPDATE tickets SET order_id = ${targetId}, updated_at = now() WHERE order_id IN ${S}`);

  // An order from before multi-PFI allocations holds its reservation
  // implicitly — pfi_id and quantity, no allocation row (see
  // releaseOrderResources' fallback). Written out first, so the sum below
  // counts it; otherwise the survivor would come out holding less stock than
  // the orders did between them.
  await tx.execute(sql`
    INSERT INTO order_pfi_allocations (order_id, pfi_id, quantity)
    SELECT o.id, o.pfi_id, o.quantity FROM orders o
     WHERE o.id IN ${ALL} AND o.pfi_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM order_pfi_allocations a WHERE a.order_id = o.id)`);
  await tx.execute(sql`
    INSERT INTO order_pfi_allocations (order_id, pfi_id, quantity)
    SELECT ${targetId}::int, pfi_id, SUM(quantity)::int FROM order_pfi_allocations
     WHERE order_id IN ${ALL} GROUP BY pfi_id
    ON CONFLICT (order_id, pfi_id) DO UPDATE SET quantity = EXCLUDED.quantity`);
  await tx.execute(sql`DELETE FROM order_pfi_allocations WHERE order_id IN ${S}`);

  await tx.execute(sql`
    INSERT INTO pfi_movements (pfi_id, order_id, action, qty_litres, notes, recorded_by)
    SELECT MIN(pfi_id), ${targetId}::int, action, SUM(qty_litres)::int,
           ${`Combined when orders were merged into ${targetRef}`}, ${staffId}::int
      FROM pfi_movements WHERE order_id IN ${ALL} GROUP BY action
    ON CONFLICT (order_id, action) DO UPDATE SET qty_litres = EXCLUDED.qty_litres`);
  await tx.execute(sql`DELETE FROM pfi_movements WHERE order_id IN ${S}`);

  await tx.execute(sql`
    DELETE FROM commissions
     WHERE order_id IN ${S}
       AND (status = 'pending' OR (status = 'skipped' AND skipped_by IS NULL))`);
  await tx.execute(sql`UPDATE commissions SET order_id = ${targetId}, updated_at = now() WHERE order_id IN ${S}`);

  const lifted = rowsOf(
    await tx.execute(sql`
      UPDATE order_refunds
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${staffId}::int,
             cancel_reason = ${`Orders merged into ${targetRef} — the overpayment is a different figure now`},
             updated_at = now()
       WHERE order_id IN ${ALL} AND status = 'skipped'
      RETURNING id, order_id AS "orderId", amount::text AS amount`),
  );
  await tx.execute(sql`UPDATE order_refunds SET order_id = ${targetId}, updated_at = now() WHERE order_id IN ${S}`);

  await tx.execute(sql`UPDATE wallet_holds SET order_id = ${targetId} WHERE order_id IN ${S}`);

  await tx.execute(sql`
    INSERT INTO order_deposit_allocations (order_id, deposit_id, amount, applied_amount, source, created_at)
    SELECT ${targetId}::int, deposit_id, SUM(amount), SUM(applied_amount), MIN(source), MIN(created_at)
      FROM order_deposit_allocations WHERE order_id IN ${ALL} GROUP BY deposit_id
    ON CONFLICT (order_id, deposit_id)
      DO UPDATE SET amount = EXCLUDED.amount, applied_amount = EXCLUDED.applied_amount`);
  await tx.execute(sql`DELETE FROM order_deposit_allocations WHERE order_id IN ${S}`);

  await tx.execute(sql`UPDATE expected_payments SET order_id = ${targetId}, updated_at = now() WHERE order_id IN ${S}`);
  await tx.execute(sql`UPDATE delivery_notes SET order_id = ${targetId}, updated_at = now() WHERE order_id IN ${S}`);
  await tx.execute(sql`UPDATE bank_statement_lines SET matched_order_id = ${targetId} WHERE matched_order_id IN ${S}`);
  await tx.execute(sql`UPDATE wa_sessions SET last_order_id = ${targetId} WHERE last_order_id IN ${S}`);

  return { liftedSkips: lifted };
};

/**
 * POST /orders/:id/merge — fold `sourceOrderIds` into order `targetOrderId`.
 *
 * The survivor's status is written directly rather than through
 * orderStatus.transition. That function is the one place a status MOVES along
 * the pipeline, and a merge is not a move along it — Completed merged with
 * Pending becomes Loading, which is no legal step from either. The write is
 * still accounted for: it is in the `order.merged` audit row with the status
 * before and after, beside the order_merges record.
 *
 * The one exception is a merge that leaves the order fully paid when it was
 * not: that is the same fact as a payment arriving, so it takes the same path
 * a payment does (Paid, then released for loading) through the state machine.
 */
const mergeOrders = async ({ targetOrderId, sourceOrderIds, reason = "", staffId = null }) => {
  const why = String(reason || "").trim();
  if (why.length < 3) throw httpError(400, "Say why these orders are being merged.");
  const targetId = Number(targetOrderId);
  const sourceIds = cleanSources(sourceOrderIds, targetId);
  const actor = actorFor(staffId);

  const outcome = await db.transaction(async (tx) => {
    const assessed = await assess({ targetId, sourceIds, tx, lock: true });
    if (assessed.problems.length) {
      throw Object.assign(httpError(409, assessed.problems[0]), { problems: assessed.problems });
    }
    const { target, sources, result } = assessed;
    const allIds = [targetId, ...sourceIds];
    const mergeGroup = randomUUID();

    const { liftedSkips } = await repoint({
      tx, targetId, sourceIds, allIds, staffId, targetRef: target.reference,
    });

    await tx.execute(sql`
      UPDATE orders SET
        quantity = ${result.quantity},
        total_amount = ${result.totalAmount.toFixed(2)}::numeric,
        status = ${result.status}::order_status,
        credit_qty = ${result.creditQty.toFixed(2)}::numeric,
        credit_reason = ${result.creditReason},
        credit_authorised_by = ${result.creditAuthorisedBy ?? null}::int,
        credit_authorised_at = ${result.creditAuthorisedAt ? new Date(result.creditAuthorisedAt).toISOString() : null}::timestamptz,
        expected_trucks = ${result.expectedTrucks ?? null}::int,
        payment_confirmed_at = ${result.paymentConfirmedAt ? result.paymentConfirmedAt.toISOString() : null}::timestamptz,
        released_at = ${result.releasedAt ? new Date(result.releasedAt).toISOString() : null}::timestamptz,
        released_by = ${result.releasedBy ?? null}::int,
        loading_started_at = ${result.loadingStartedAt ? result.loadingStartedAt.toISOString() : null}::timestamptz,
        completed_at = ${result.completedAt ? result.completedAt.toISOString() : null}::timestamptz,
        updated_at = now()
      WHERE id = ${targetId}`);

    // The merged-away orders keep what they were ordered as — quantity, price,
    // value — so reading one still says what it was. Only the credit comes
    // off: it now sits on the survivor, and an allowance on an empty order
    // would be counted twice on the exposure report.
    await tx.execute(sql`
      UPDATE orders SET
        status = 'Cancelled', cancelled_at = now(), cancelled_by = ${staffId}::int,
        cancellation_reason = ${`Merged into ${target.reference}`},
        merged_into_order_id = ${targetId},
        credit_qty = 0, credit_reason = '', credit_authorised_by = NULL, credit_authorised_at = NULL,
        updated_at = now()
      WHERE id IN ${idList(sourceIds)}`);

    for (const id of sourceIds) await recomputeOrder(id, tx);
    const summary = await recomputeOrder(targetId, tx);

    // Became fully paid through the merge — take the same road a payment does.
    let finalStatus = result.status;
    if (result.status === "Pending" && summary.paymentStatus === "Paid") {
      const shared = { tx, actor, metadata: { via: "order_merge", mergeGroup } };
      await orderStatus().transition(targetId, "Paid", { ...shared, action: "order.paid", set: {} });
      await orderStatus().releaseOnPayment(targetId, shared);
      finalStatus = "Released";
    }

    const [after] = [...(await loadOrders([targetId], tx)).values()];
    const afterSnap = snapshot(after);
    const targetBefore = snapshot(target);

    await tx.execute(sql`
      INSERT INTO order_merges
        (target_order_id, source_order_id, source_before, target_before, target_after, merge_group, reason, merged_by)
      SELECT ${targetId}, (s.v->>'id')::int, s.v, ${JSON.stringify(targetBefore)}::jsonb,
             ${JSON.stringify(afterSnap)}::jsonb, ${mergeGroup}::uuid, ${why}, ${staffId}::int
        FROM jsonb_array_elements(${JSON.stringify(sources.map(snapshot))}::jsonb) s(v)`);

    await auditLogRepo.recordMany(
      [
        {
          entityType: "order",
          entityId: targetId,
          action: "order.merged",
          prevState: target.status,
          newState: finalStatus,
          actor,
          metadata: {
            mergeGroup,
            reason: why,
            mergedFrom: sources.map((s) => ({ id: s.id, reference: s.reference })),
            before: targetBefore,
            after: afterSnap,
          },
        },
        ...sources.map((s) => ({
          entityType: "order",
          entityId: s.id,
          action: "order.merged_away",
          prevState: s.status,
          newState: "Cancelled",
          actor,
          metadata: {
            mergeGroup,
            reason: why,
            intoOrderId: targetId,
            intoReference: target.reference,
            before: snapshot(s),
          },
        })),
        ...liftedSkips.map((skip) => ({
          entityType: "order",
          entityId: Number(skip.orderId),
          action: "order.refund_skip_lifted",
          actor,
          metadata: { refundId: Number(skip.id), amount: skip.amount, reason: "Orders merged", mergeGroup },
        })),
      ],
      tx,
    );

    return {
      target: afterSnap,
      merged: sources.map((s) => ({ id: s.id, reference: s.reference })),
      moving: assessed.moving,
      warnings: assessed.warnings,
      summary,
    };
  });

  // Outside the transaction, like every other caller of it: commission is
  // derived, and a failure to recompute it must not undo a merge that has
  // already been checked and written. Anything left unrecomputed is picked up
  // by the next payment or the finance reconcile, as it would be anyway.
  try {
    await require("./commission.service").createForOrder(targetId);
  } catch (err) {
    console.error(`[orderMerge] commission recompute failed for order ${targetId}:`, err.message);
  }

  return outcome;
};

module.exports = {
  MAX_SOURCES,
  AUDIT_SIGNED_OFF_THROUGH,
  combinedStatus,
  previewMerge,
  mergeOverview,
  mergeOrders,
};
