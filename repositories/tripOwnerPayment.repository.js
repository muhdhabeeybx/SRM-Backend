const { client } = require("../db");

/**
 * Each hired truck's part of the payment requests raised to its owner
 * (migration 0098, services/ownerPayments.service.js).
 *
 * A truck's part of a request is the request's amount × its share ÷ the
 * request's shares, read now — so a request corrected in Expenses is still
 * spread the same way and its parts still add up to it. Paid, it is what
 * actually cleared (amount_paid_ngn), the same figure the PFI's paid expenses
 * add (pfiExpense.repository SPEND), so the truck and the PFI take off and put
 * on exactly the same naira. Rejected and deleted requests pay nothing.
 *
 * ── Before migration 0098 ──────────────────────────────────────────────────
 *
 * Every Delivery Inventory, Costing and Sales Ledger list reads this. The
 * code can reach a server before its migration reaches the database, so the
 * table is asked about first and, until it exists, every truck reads as paid
 * nothing — exactly how they all read before.
 */

let ready = false;
const tableReady = async (tx = client) => {
  if (ready) return true;
  const [row] = await tx`SELECT to_regclass('public.trip_owner_payments') IS NOT NULL AS ok`;
  ready = row?.ok === true;
  return ready;
};

const ints = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const kobo = (n) => Math.round(n * 100) / 100;

/**
 * @returns {Promise<Map<number, {
 *   paid: number, requested: number, advance: number, lastPaidAt: string|null,
 *   payments: Array<{ expenseId, reference, kind, status, amount, paid, paidAt }>
 * }>>}
 */
const forTrips = async (tripIds, tx = client) => {
  const ids = ints(tripIds);
  const out = new Map();
  if (!ids.length || !(await tableReady(tx))) return out;
  const rows = await tx`
    WITH live AS (
      SELECT p.trip_id, p.expense_id, p.kind, p.share,
             SUM(p.share) OVER (PARTITION BY p.expense_id) AS shares,
             e.reference_number AS reference, e.status::text AS status,
             e.amount_ngn, COALESCE(e.amount_paid_ngn, e.amount_ngn) AS spent,
             e.paid_at
        FROM trip_owner_payments p
        JOIN pfi_expenses e ON e.id = p.expense_id
       WHERE e.deleted_at IS NULL AND e.status <> 'rejected'
         AND p.expense_id IN (SELECT expense_id FROM trip_owner_payments WHERE trip_id = ANY(${ids}::int[]))
    )
    SELECT * FROM live WHERE trip_id = ANY(${ids}::int[]) ORDER BY expense_id`;
  for (const r of rows) {
    const id = Number(r.trip_id);
    if (!out.has(id)) out.set(id, { paid: 0, requested: 0, advance: 0, lastPaidAt: null, payments: [] });
    const t = out.get(id);
    const part = Number(r.share) / Number(r.shares || r.share);
    const isPaid = r.status === "paid";
    const amount = kobo(Number(r.amount_ngn || 0) * part);
    const paid = isPaid ? kobo(Number(r.spent || 0) * part) : 0;
    t.payments.push({
      expenseId: Number(r.expense_id),
      reference: r.reference,
      kind: r.kind,
      status: r.status,
      amount,
      paid,
      paidAt: isPaid && r.paid_at ? new Date(r.paid_at).toISOString() : null,
    });
    if (isPaid) {
      t.paid = kobo(t.paid + paid);
      const at = t.payments[t.payments.length - 1].paidAt;
      if (at && (!t.lastPaidAt || at > t.lastPaidAt)) t.lastPaidAt = at;
    } else {
      t.requested = kobo(t.requested + amount);
    }
    if (r.kind === "advance") t.advance = kobo(t.advance + (isPaid ? paid : amount));
  }
  return out;
};

/** Requests already linked to some truck, among these. */
const linkedExpenseIds = async (expenseIds, tx = client) => {
  const ids = ints(expenseIds);
  if (!ids.length || !(await tableReady(tx))) return new Set();
  const rows = await tx`SELECT DISTINCT expense_id FROM trip_owner_payments WHERE expense_id = ANY(${ids}::int[])`;
  return new Set(rows.map((r) => Number(r.expense_id)));
};

const insertParts = async (parts, tx) => {
  if (!parts.length) return;
  await tx`INSERT INTO trip_owner_payments ${tx(parts)}`;
};

/**
 * The haulage rate per litre (0098), read and written apart from the drizzle
 * schema so a server ahead of its migration still lists every trip: until the
 * column exists, no trip has a rate and none can be given one.
 */
let rateReady = false;
const rateColumnReady = async (tx = client) => {
  if (rateReady) return true;
  const [row] = await tx`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delivery_inventory' AND column_name = 'haulage_rate'
    ) AS ok`;
  rateReady = row?.ok === true;
  return rateReady;
};

/** Trip id → its haulage rate, for the trips that have one. */
const haulageRates = async (tripIds, tx = client) => {
  const ids = ints(tripIds);
  if (!ids.length || !(await rateColumnReady(tx))) return new Map();
  const rows = await tx`
    SELECT id, haulage_rate FROM delivery_inventory
     WHERE id = ANY(${ids}::int[]) AND haulage_rate IS NOT NULL`;
  return new Map(rows.map((r) => [Number(r.id), Number(r.haulage_rate)]));
};

/**
 * Set (or clear) the rate on these trips. A rate replaces any lump sum typed
 * before it, so the trip has one haulage figure, not two.
 */
const setHaulageRate = async (tripIds, rate, tx = client) => {
  const ids = ints(tripIds);
  if (!ids.length) return 0;
  if (!(await rateColumnReady(tx))) {
    throw Object.assign(new Error("Haulage rates are not set up on this server yet (migration 0098)"), { status: 409, statusCode: 409 });
  }
  const rows = rate == null
    ? await tx`UPDATE delivery_inventory SET haulage_rate = NULL, updated_at = NOW() WHERE id = ANY(${ids}::int[]) RETURNING id`
    : await tx`
        UPDATE delivery_inventory SET haulage_rate = ${rate}, haulage_amount = NULL, updated_at = NOW()
         WHERE id = ANY(${ids}::int[]) RETURNING id`;
  return rows.length;
};

module.exports = { tableReady, forTrips, linkedExpenseIds, insertParts, haulageRates, setHaulageRate, rateColumnReady };
