/**
 * Trucks' loading money entered in Delivery Costing, raised as a payment
 * request (migration 0099) — the way their feeding is (feedingRequests.service).
 *
 * The desk raised it by hand: "loading expenses of 6 trucks, 90,000 × 6" under
 * Other PFI Operational Expenses (EXP-652). Now it is typed on the trucks —
 * one, the ticked ones, or a whole batch — and raised from there, under its
 * own Truck Loading account (5435, the user's choice, 2026-10-27):
 *
 *   - Loading entered on a truck, not ticked as already in Expenses, goes on
 *     its PFI's open Truck Loading request raised from Delivery Costing — one
 *     per batch — or a new one if none is still pending. It then goes through
 *     the approval chain like any expense.
 *   - The request asks for what its trucks carry. A truck changed, cleared or
 *     ticked moves the amount while the request is pending; a request left
 *     with no trucks is deleted.
 *   - Once finance takes it forward the trucks' loading is fixed
 *     (deliveryInventory.repository loadingLockedIds).
 *   - Loading paid already, before anybody costed the trucks, is recorded as
 *     paid (recordPaid): a super admin, with the account, date and reference.
 *
 * Counted once: the loading counts as a trip cost until its request is paid,
 * then the PFI's paid expenses carry it (lib/tripCosts.js).
 *
 * Every truck takes loading, hired ones too (the user, 2026-10-27) — unlike
 * feeding, which the owner of a hired truck covers.
 */
const { client } = require("../db");
const pfiExpenseRepo = require("../repositories/pfiExpense.repository");
const { notifyExpenseStage } = require("./expenseNotifications.service");
const { paidColumns, AUDIT_NOTE } = require("../lib/recordedAsPaid");

const ints = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const MARK = "Raised from Delivery Costing";

/** The chart's Truck Loading account (5435). */
const loadingCategoryId = async (tx = client) => {
  const [c] = await tx`
    SELECT id FROM expense_categories
     WHERE pfi_id IS NULL AND (gl_code = '5435' OR lower(name) = 'truck loading')
     ORDER BY (gl_code = '5435') DESC NULLS LAST, id
     LIMIT 1`;
  return c ? Number(c.id) : null;
};

/** "Truck loading: 6 trucks on PFI-47D, ₦90,000 each." */
const describe = ({ trucks, total, each, codes, paid }) =>
  `Truck loading: ${trucks} truck${trucks === 1 ? "" : "s"}` +
  `${codes ? ` on ${codes}` : ""}, ${each != null ? `${naira(each)} each` : `${naira(total)} in all`}. ` +
  (paid ? "Paid already, recorded from Delivery Costing." : `${MARK}.`);

/**
 * Make the Truck Loading requests match these trips' loading.
 *
 * @param {object} p
 * @param {number[]} p.tripIds       trips whose loading was just written
 * @param {number[]} [p.expenseIds]  requests to re-total anyway (a trip deleted off one)
 * @param {{ id: number|null, name: string }} p.actor
 * @returns {{ raised: object[], changed: object[], dropped: object[], noPfi: number, noCategory: boolean }}
 */
async function sync({ tripIds = [], expenseIds = [], actor = {} }) {
  const out = { raised: [], changed: [], dropped: [], noPfi: 0, noCategory: false };
  const ids = ints(tripIds);
  const also = ints(expenseIds);
  if (!ids.length && !also.length) return out;

  const created = [];
  const toTell = [];
  await client.begin(async (tx) => {
    const trips = ids.length
      ? await tx`
          SELECT id, pfi_id, loading_cost, loading_cost_in_expenses, loading_cost_expense_id
            FROM delivery_inventory WHERE id = ANY(${ids}::int[]) FOR UPDATE`
      : [];
    const linked = ints([...trips.map((t) => t.loading_cost_expense_id), ...also]);
    const requests = new Map(
      (linked.length
        ? await tx`SELECT id, status::text AS status, deleted_at FROM pfi_expenses WHERE id = ANY(${linked}::int[]) FOR UPDATE`
        : []
      ).map((e) => [Number(e.id), e]),
    );
    const open = (e) => e && !e.deleted_at && e.status === "pending";
    const live = (e) => e && !e.deleted_at && e.status !== "rejected";

    const dirty = new Set(also.filter((id) => open(requests.get(id))));
    const needs = new Map(); // pfi id → trip ids
    for (const t of trips) {
      const e = t.loading_cost_expense_id ? requests.get(Number(t.loading_cost_expense_id)) : null;
      const owes = Number(t.loading_cost) > 0 && !t.loading_cost_in_expenses;
      if (live(e)) {
        // Taken forward by finance, or recorded as paid: fixed.
        if (!open(e)) continue;
        if (!owes) await tx`UPDATE delivery_inventory SET loading_cost_expense_id = NULL WHERE id = ${t.id}`;
        dirty.add(Number(e.id));
        continue;
      }
      if (!owes) continue;
      if (t.pfi_id == null) { out.noPfi += 1; continue; }
      if (!needs.has(Number(t.pfi_id))) needs.set(Number(t.pfi_id), []);
      needs.get(Number(t.pfi_id)).push(Number(t.id));
    }

    if (needs.size) {
      const category = await loadingCategoryId(tx);
      if (!category) {
        out.noCategory = true;
      } else {
        for (const [pfiId, tripList] of needs) {
          // The PFI's request from Delivery Costing still waiting: the batch's one.
          const [pending] = await tx`
            SELECT e.id FROM pfi_expenses e
             WHERE e.pfi_id = ${pfiId} AND e.category_id = ${category}
               AND e.status = 'pending' AND e.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM delivery_inventory d WHERE d.loading_cost_expense_id = e.id)
             ORDER BY e.id DESC LIMIT 1
             FOR UPDATE`;
          let id = pending ? Number(pending.id) : null;
          if (!id) {
            const row = await pfiExpenseRepo.createExpense({
              pfi_id: pfiId,
              category_id: category,
              expense_date: new Date().toISOString(),
              description: "",
              amount: "0",
              currency: "NGN",
              exchange_rate: "1",
              status: "pending",
              entered_by: actor.name || "",
              recorded_by: actor.id ?? null,
              added_by: actor.id ?? null,
            }, tx);
            id = Number(row.id);
            created.push(id);
          }
          await tx`UPDATE delivery_inventory SET loading_cost_expense_id = ${id} WHERE id = ANY(${tripList}::int[])`;
          dirty.add(id);
        }
      }
    }

    // Each request touched now asks for exactly what its trucks carry.
    for (const id of dirty) {
      const [e] = await tx`SELECT * FROM pfi_expenses WHERE id = ${id}`;
      if (!e || e.deleted_at || e.status !== "pending") continue;
      const [sum] = await totals(tx, id);
      const isNew = created.includes(id);

      if (sum.trucks === 0) {
        await tx`UPDATE pfi_expenses SET deleted_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
        await tx`UPDATE delivery_inventory SET loading_cost_expense_id = NULL WHERE loading_cost_expense_id = ${id}`;
        await pfiExpenseRepo.writeAudit({
          expenseId: id,
          action: "deleted",
          changes: { note: "No truck's loading left on it in Delivery Costing" },
          actorId: actor.id ?? null,
          actorName: actor.name || "",
        }, tx);
        out.dropped.push({ reference: e.reference_number });
        continue;
      }

      const total = Number(sum.total);
      const ours = isNew || !e.description || e.description.includes(MARK);
      const description = ours
        ? describe({ trucks: sum.trucks, total, each: sum.amounts === 1 ? Number(sum.each) : null, codes: sum.codes })
        : e.description;
      if (!isNew && Number(e.amount) === total && e.description === description) continue;

      const row = await pfiExpenseRepo.updateExpense(id, { amount: String(total), description }, tx);
      await pfiExpenseRepo.writeAudit({
        expenseId: id,
        action: isNew ? "created" : "updated",
        changes: isNew
          ? { ...row, note: MARK }
          : { amount: { from: e.amount, to: row.amount }, note: "Trucks' loading changed in Delivery Costing" },
        actorId: actor.id ?? null,
        actorName: actor.name || "",
      }, tx);
      const said = { id, reference: row.reference_number, amount: total, trucks: sum.trucks, pfiId: Number(row.pfi_id) };
      (isNew ? out.raised : out.changed).push(said);
      if (isNew) toTell.push(row);
    }
  });

  // The Expenditure Officer is told, as for any request raised by hand.
  for (const row of toTell) {
    notifyExpenseStage({ expense: row, stage: "pending", note: "", actorId: actor.id ?? null, actorName: actor.name || "" })
      .catch(() => {});
  }
  return out;
}

/** What a request's trucks carry: how many, the total, and whether all at one figure. */
const totals = (tx, expenseId) => tx`
  SELECT count(*)::int AS trucks,
         COALESCE(sum(loading_cost), 0)::numeric AS total,
         count(DISTINCT loading_cost)::int AS amounts,
         min(loading_cost)::numeric AS each,
         string_agg(DISTINCT NULLIF(allocation_code, ''), ', ') AS codes
    FROM delivery_inventory
   WHERE loading_cost_expense_id = ${expenseId} AND loading_cost > 0 AND NOT loading_cost_in_expenses`;

/**
 * Loading these trucks paid already, written in as a paid Truck Loading
 * expense — one per PFI — instead of a request for approval.
 *
 * Refused for a truck with no loading entered, one ticked as already in
 * Expenses (it is there once already), or one whose loading is on a request
 * finance has taken forward. A truck on a request still pending comes off it,
 * and that request is re-totalled.
 *
 * @param {object} p
 * @param {number[]} p.tripIds
 * @param {object} p.paid   { bankPaidFrom, paymentDate, paymentReference, paymentMethod?, notes? }
 * @param {object} p.user   req.user — a super admin only
 * @param {{ id: number|null, name: string }} p.actor
 */
async function recordPaid({ tripIds, paid, user, actor = {} }) {
  const ids = ints(tripIds);
  if (!ids.length) throw httpError(400, "Pick the trucks");
  // Checked before anything is read, so a refusal says the role first.
  paidColumns(paid, { amount: 1, user, actorId: actor.id });

  const recorded = [];
  const replaced = new Set();
  await client.begin(async (tx) => {
    const category = await loadingCategoryId(tx);
    if (!category) throw httpError(409, "There is no Truck Loading account in the chart (migration 0099)");

    const trips = await tx`
      SELECT d.id, d.pfi_id, d.truck_number, d.loading_cost, d.loading_cost_in_expenses, d.loading_cost_expense_id,
             e.reference_number AS request_ref, e.status::text AS request_status, e.deleted_at AS request_deleted
        FROM delivery_inventory d
        LEFT JOIN pfi_expenses e ON e.id = d.loading_cost_expense_id
       WHERE d.id = ANY(${ids}::int[])
       ORDER BY d.id
       FOR UPDATE OF d`;
    if (trips.length !== ids.length) throw httpError(404, "A truck was not found");

    const list = (rows) => rows.map((t) => t.truck_number || `#${t.id}`).join(", ");
    const none = trips.filter((t) => !(Number(t.loading_cost) > 0));
    if (none.length) throw httpError(409, `${list(none)} ${none.length === 1 ? "has" : "have"} no loading entered`);
    const ticked = trips.filter((t) => t.loading_cost_in_expenses);
    if (ticked.length) {
      throw httpError(409, `${list(ticked)} ${ticked.length === 1 ? "is" : "are"} ticked as already in Expenses — ${ticked.length === 1 ? "its" : "their"} loading is there once already`);
    }
    const fixed = trips.filter((t) => t.loading_cost_expense_id && !t.request_deleted && !["pending", "rejected"].includes(t.request_status));
    if (fixed.length) {
      const refs = [...new Set(fixed.map((t) => t.request_ref))].join(", ");
      throw httpError(409, `Loading on ${list(fixed)} is on ${refs}, which finance has already taken forward — pay it there`);
    }
    const noPfi = trips.filter((t) => t.pfi_id == null);
    if (noPfi.length) throw httpError(409, `${list(noPfi)} ${noPfi.length === 1 ? "is" : "are"} on no PFI, so the expense has nowhere to go`);

    for (const t of trips) {
      if (t.loading_cost_expense_id && !t.request_deleted && t.request_status === "pending") replaced.add(Number(t.loading_cost_expense_id));
    }

    const byPfi = new Map();
    for (const t of trips) {
      if (!byPfi.has(Number(t.pfi_id))) byPfi.set(Number(t.pfi_id), []);
      byPfi.get(Number(t.pfi_id)).push(t);
    }
    for (const [pfiId, group] of byPfi) {
      const total = Math.round(group.reduce((s, t) => s + Number(t.loading_cost), 0) * 100) / 100;
      const amounts = new Set(group.map((t) => Number(t.loading_cost)));
      const [code] = await tx`
        SELECT string_agg(DISTINCT NULLIF(allocation_code, ''), ', ') AS codes
          FROM delivery_inventory WHERE id = ANY(${group.map((t) => Number(t.id))}::int[])`;
      const row = await pfiExpenseRepo.createExpense({
        pfi_id: pfiId,
        category_id: category,
        expense_date: new Date(paid.paymentDate).toISOString(),
        description: describe({
          trucks: group.length, total, each: amounts.size === 1 ? [...amounts][0] : null, codes: code?.codes, paid: true,
        }),
        amount: String(total),
        currency: "NGN",
        exchange_rate: "1",
        ...paidColumns(paid, { amount: total, user, actorId: actor.id }),
        entered_by: actor.name || "",
        recorded_by: actor.id ?? null,
        added_by: actor.id ?? null,
      }, tx);
      await tx`UPDATE delivery_inventory SET loading_cost_expense_id = ${row.id}, updated_at = NOW()
                WHERE id = ANY(${group.map((t) => Number(t.id))}::int[])`;
      await pfiExpenseRepo.writeAudit({
        expenseId: Number(row.id),
        action: "recorded_as_paid",
        changes: { ...row, note: AUDIT_NOTE, trips: group.map((t) => Number(t.id)) },
        actorId: actor.id ?? null,
        actorName: actor.name || "",
      }, tx);
      recorded.push({ reference: row.reference_number, amount: total, trucks: group.length, pfiId });
    }
  });

  // The pending requests those trucks came off are re-totalled — deleted if left with none.
  const requests = replaced.size ? await sync({ expenseIds: [...replaced], actor }) : null;
  return { recorded, requests };
}

/** What a save did to the requests, in a sentence for the toast. */
function sentence(result, pfiNames = new Map()) {
  if (!result) return "";
  const on = (r) => (pfiNames.get(r.pfiId) ? ` on ${pfiNames.get(r.pfiId)}` : "");
  const parts = [
    ...result.raised.map((r) => `Truck loading request ${r.reference} raised${on(r)} for ${naira(r.amount)}, ${r.trucks} truck${r.trucks === 1 ? "" : "s"}`),
    ...result.changed.map((r) => `Truck loading request ${r.reference} now ${naira(r.amount)} for ${r.trucks} truck${r.trucks === 1 ? "" : "s"}`),
    ...result.dropped.map((r) => `Truck loading request ${r.reference} deleted — no truck's loading left on it`),
  ];
  if (result.noPfi) parts.push(`${result.noPfi} truck${result.noPfi === 1 ? " is" : "s are"} on no PFI, so no loading request was raised for ${result.noPfi === 1 ? "it" : "them"}`);
  if (result.noCategory) parts.push("No Truck Loading account in the chart, so no loading request was raised");
  return parts.join(". ");
}

/** The toast for recordPaid. */
const paidSentence = (r) =>
  [
    ...r.recorded.map((x) => `${x.reference} recorded as paid: ${naira(x.amount)} loading on ${x.trucks} truck${x.trucks === 1 ? "" : "s"}`),
    r.requests ? sentence(r.requests) : "",
  ].filter(Boolean).join(". ");

module.exports = { sync, sentence, recordPaid, paidSentence, loadingCategoryId };
