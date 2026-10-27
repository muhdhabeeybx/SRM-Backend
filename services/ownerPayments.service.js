/**
 * Paying a hired truck's owner, through Expenses (migration 0098).
 *
 * A third party's truck (0094) is costed at the haulage its owner charges; the
 * owner takes AGO from us out of it, and is paid the rest — "Owner gets",
 * haulage − AGO. The owner is paid the way the business pays anybody: a
 * payment request in Expenses, approved and paid by finance. From Delivery
 * Costing (the user, 2026-10-26):
 *
 *   advance   an amount for several of one owner's trucks — "₦20m for 20
 *             trucks" — spread equally across them.
 *   balance   what each of the trucks still has to come: owner gets, less
 *             what is already paid or asked for. Needs each truck's haulage
 *             and its AGO priced.
 *   link      an advance somebody already raised by hand under
 *             Transportation/Haulage, spread equally across the trucks
 *             instead of being raised again.
 *   paid      an advance or balance paid to the owner already, before it was
 *             raised here: written in as a paid expense, not a request — a
 *             super admin, with the account, date and reference (2026-10-27).
 *
 * One owner and one PFI per request: the request is charged to the trucks'
 * PFI and made out to the owner.
 *
 * Counted once (lib/tripCosts.js): a truck's haulage counts on the trip less
 * what is already paid to its owner, because the PFI's paid expenses carry
 * that part. The landing cost is right before, during and after paying.
 */
const { client } = require("../db");
const pfiExpenseRepo = require("../repositories/pfiExpense.repository");
const tripOwnerPayments = require("../repositories/tripOwnerPayment.repository");
const deliveryInventoryRepo = require("../repositories/deliveryInventory.repository");
const { notifyExpenseStage } = require("./expenseNotifications.service");
const { equalSplit } = require("./feedingRequests.service");
const { paidColumns, AUDIT_NOTE } = require("../lib/recordedAsPaid");

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const ints = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const KINDS = new Set(["advance", "balance"]);

/** The chart's Transportation/Haulage account (5120). */
const haulageCategoryId = async (tx = client) => {
  const [c] = await tx`
    SELECT id FROM expense_categories
     WHERE pfi_id IS NULL AND (gl_code = '5120' OR lower(name) IN ('transportation/haulage', 'haulage'))
     ORDER BY (gl_code = '5120') DESC NULLS LAST, id
     LIMIT 1`;
  return c ? Number(c.id) : null;
};

/**
 * Haulage expenses on these PFIs that no truck carries yet: raised by hand,
 * not rejected, not deleted. What an advance can be linked to.
 */
async function unlinked(pfiIds) {
  const ids = ints(pfiIds);
  if (!ids.length || !(await tripOwnerPayments.tableReady())) return [];
  const category = await haulageCategoryId();
  if (!category) return [];
  const rows = await client`
    SELECT e.id, e.pfi_id, e.reference_number AS reference, e.status::text AS status,
           e.amount_ngn AS amount, e.vendor, e.description, e.created_at
      FROM pfi_expenses e
     WHERE e.pfi_id = ANY(${ids}::int[]) AND e.category_id = ${category}
       AND e.deleted_at IS NULL AND e.status <> 'rejected'
       AND NOT EXISTS (SELECT 1 FROM trip_owner_payments p WHERE p.expense_id = e.id)
     ORDER BY e.id DESC`;
  return rows.map((r) => ({
    id: Number(r.id),
    pfiId: Number(r.pfi_id),
    reference: r.reference,
    status: r.status,
    amount: Number(r.amount || 0),
    vendor: r.vendor || "",
    description: r.description || "",
    raisedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}

/** "Haulage advance to NASIRU GOLOLO: 10 trucks on PFI-38C, ₦1,000,000 each." */
const describe = ({ kind, owner, trucks, code, each, total, note }) =>
  `Haulage ${kind} to ${owner}: ${trucks} truck${trucks === 1 ? "" : "s"}${code ? ` on ${code}` : ""}, ` +
  `${each != null ? `${naira(each)} each` : `${naira(total)} in all`}. Raised from Delivery Costing.` +
  (note ? ` ${note}` : "");

/**
 * Raise (or link) one payment request to one owner for these trucks.
 *
 * @param {object} p
 * @param {number[]} p.tripIds
 * @param {"advance"|"balance"} p.kind
 * @param {number} [p.amount]     an advance's total, spread equally
 * @param {number} [p.expenseId]  a haulage expense already raised, to link instead
 * @param {string} [p.note]
 * @param {object} [p.paid]      paid already: { bankPaidFrom, paymentDate, paymentReference, ... }
 * @param {object} [p.user]      req.user — recording as paid is a super admin's
 * @param {{ id: number|null, name: string }} p.actor
 */
async function raise({ tripIds, kind, amount = null, expenseId = null, note = "", paid = null, user = null, actor = {} }) {
  if (!KINDS.has(kind)) throw httpError(400, "Say whether it is an advance or the balance");
  if (paid && expenseId != null) throw httpError(400, "An expense already raised is paid in Expenses, not here");
  // Checked before anything is read, so a refusal says the role first.
  if (paid) paidColumns(paid, { amount: 1, user, actorId: actor.id });
  const ids = ints(tripIds);
  if (!ids.length) throw httpError(400, "Pick the trucks");
  if (!(await tripOwnerPayments.tableReady())) {
    throw httpError(409, "Owner payments are not set up on this server yet (migration 0098)");
  }

  // Costed, so each truck's owner-gets and what is already paid or asked come with it.
  const trips = await deliveryInventoryRepo.findCostedByIds(ids);
  if (trips.length !== ids.length) throw httpError(404, "A truck was not found");

  const notHired = trips.filter((t) => !t.truckThirdParty);
  if (notHired.length) {
    throw httpError(409, `${notHired.map((t) => t.truckNumber).join(", ")} ${notHired.length === 1 ? "is" : "are"} not a third party's truck`);
  }
  const owners = [...new Set(trips.map((t) => (t.truckOwner || "").trim().toUpperCase()))];
  if (owners.length !== 1 || !owners[0]) {
    throw httpError(409, owners.length > 1 ? "Pay one owner at a time — these trucks belong to more than one" : "These trucks have no owner on the fleet register");
  }
  const owner = trips[0].truckOwner.trim();
  const pfiIds = ints(trips.map((t) => t.pfiId));
  if (pfiIds.length !== 1 || trips.some((t) => t.pfiId == null)) {
    throw httpError(409, "Pay for one PFI's trucks at a time — the request is charged to that PFI");
  }
  const pfiId = pfiIds[0];
  const code = trips.find((t) => t.allocationCode)?.allocationCode || "";

  const category = await haulageCategoryId();
  if (!category) throw httpError(409, "There is no Transportation/Haulage account in the chart");

  /** What each truck still has to come: owner gets − paid − asked for. Null while unknown. */
  const left = (t) => (t.ownerToRaise == null ? null : Number(t.ownerToRaise));

  let linked = null;
  if (expenseId != null) {
    const [e] = await client`
      SELECT id, pfi_id, category_id, reference_number, status::text AS status, amount_ngn, deleted_at
        FROM pfi_expenses WHERE id = ${Number(expenseId)}`;
    if (!e || e.deleted_at) throw httpError(404, "Expense not found");
    if (Number(e.category_id) !== category) throw httpError(409, `${e.reference_number} is not a Transportation/Haulage expense`);
    if (e.status === "rejected") throw httpError(409, `${e.reference_number} was rejected`);
    if (Number(e.pfi_id) !== pfiId) throw httpError(409, `${e.reference_number} is on another PFI than these trucks`);
    if ((await tripOwnerPayments.linkedExpenseIds([e.id])).size) {
      throw httpError(409, `${e.reference_number} is already spread across trucks`);
    }
    if (!(Number(e.amount_ngn) > 0)) throw httpError(409, `${e.reference_number} has no amount in naira`);
    linked = e;
  }

  // ── The trucks' shares ───────────────────────────────────────────────
  let parts;
  if (kind === "advance") {
    const total = linked ? Number(linked.amount_ngn) : Number(amount);
    if (!(total > 0)) throw httpError(400, "Enter the advance");
    const shares = equalSplit(total, trips.length);
    parts = trips.map((t, i) => ({ trip: t, share: shares[i] }));
    // Known what a truck is owed, an advance may not pay it more than that.
    const over = parts.filter((p) => left(p.trip) != null && p.share > left(p.trip) + 0.005);
    if (over.length) {
      const t = over[0].trip;
      throw httpError(
        409,
        `${t.truckNumber} has ${naira(Math.max(0, left(t)))} left to pay its owner, less than its ${naira(over[0].share)} share of the advance` +
          (over.length > 1 ? ` (and ${over.length - 1} more)` : ""),
      );
    }
  } else {
    const unknown = trips.filter((t) => left(t) == null);
    if (unknown.length) {
      throw httpError(
        409,
        `${unknown.map((t) => t.truckNumber).join(", ")} ${unknown.length === 1 ? "has" : "have"} no haulage entered, ` +
          "or AGO given at no price — the balance cannot be worked out yet",
      );
    }
    parts = trips.filter((t) => left(t) > 0.005).map((t) => ({ trip: t, share: Math.round(left(t) * 100) / 100 }));
    if (!parts.length) throw httpError(409, `Nothing is left to pay ${owner} on these trucks`);
  }
  const total = Math.round(parts.reduce((s, p) => s + p.share, 0) * 100) / 100;
  const each = parts.every((p) => p.share === parts[0].share) ? parts[0].share : null;

  // ── The request, and each truck's part of it ──────────────────────────
  let row;
  await client.begin(async (tx) => {
    if (linked) {
      row = (await tx`SELECT * FROM pfi_expenses WHERE id = ${linked.id} FOR UPDATE`)[0];
    } else {
      const [vendor] = await tx`SELECT id, name FROM vendors WHERE lower(name) = lower(${owner}) LIMIT 1`;
      row = await pfiExpenseRepo.createExpense({
        pfi_id: pfiId,
        category_id: category,
        expense_date: new Date().toISOString(),
        vendor: vendor?.name || owner,
        vendor_id: vendor?.id ?? null,
        description: describe({ kind, owner, trucks: parts.length, code, each, total, note: String(note || "").trim() })
          .replace("Raised from Delivery Costing.", paid ? "Paid already, recorded from Delivery Costing." : "Raised from Delivery Costing."),
        amount: String(total),
        currency: "NGN",
        exchange_rate: "1",
        ...(paid
          ? { ...paidColumns(paid, { amount: total, user, actorId: actor.id }), expense_date: new Date(paid.paymentDate).toISOString() }
          : { status: "pending" }),
        entered_by: actor.name || "",
        recorded_by: actor.id ?? null,
        added_by: actor.id ?? null,
      }, tx);
    }
    await tripOwnerPayments.insertParts(parts.map((p) => ({
      expense_id: Number(row.id),
      trip_id: Number(p.trip.id),
      kind,
      share: String(p.share),
      created_by: actor.id ?? null,
    })), tx);
    await pfiExpenseRepo.writeAudit({
      expenseId: Number(row.id),
      action: linked ? "updated" : paid ? "recorded_as_paid" : "created",
      changes: linked
        ? { note: `Spread across ${parts.length} of ${owner}'s trucks in Delivery Costing as a haulage ${kind}`, trips: parts.map((p) => Number(p.trip.id)) }
        : { ...row, note: paid ? AUDIT_NOTE : "Raised from Delivery Costing", trips: parts.map((p) => Number(p.trip.id)) },
      actorId: actor.id ?? null,
      actorName: actor.name || "",
    }, tx);
  });

  // The Expenditure Officer is told, as for any request raised by hand. Paid
  // already, there is nobody to tell.
  if (!linked && !paid) {
    notifyExpenseStage({ expense: row, stage: "pending", note: "", actorId: actor.id ?? null, actorName: actor.name || "" })
      .catch(() => {});
  }

  return {
    expense: { id: Number(row.id), reference: row.reference_number, status: row.status, amount: Number(row.amount_ngn ?? row.amount) },
    linked: Boolean(linked),
    paid: Boolean(paid),
    kind,
    owner,
    trucks: parts.length,
    total: linked ? Number(linked.amount_ngn) : total,
    each,
  };
}

/** The sentence for the toast. */
const sentence = (r) =>
  r.paid
    ? `${r.expense.reference} recorded as paid: haulage ${r.kind} of ${naira(r.total)} to ${r.owner}, ${r.trucks} truck${r.trucks === 1 ? "" : "s"}` +
      (r.each != null ? ` at ${naira(r.each)} each` : "")
    : r.linked
    ? `${r.expense.reference} (${naira(r.total)}) spread across ${r.trucks} of ${r.owner}'s trucks as a haulage ${r.kind}` +
      (r.each != null ? `, ${naira(r.each)} each` : "")
    : `Haulage ${r.kind} request ${r.expense.reference} raised to ${r.owner} for ${naira(r.total)}, ${r.trucks} truck${r.trucks === 1 ? "" : "s"}` +
      (r.each != null ? ` at ${naira(r.each)} each` : "");

module.exports = { raise, unlinked, sentence, haulageCategoryId };
