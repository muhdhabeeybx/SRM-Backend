/**
 * Drivers' feeding entered in Delivery Costing, raised as a payment request.
 *
 * Feeding is paid as one expense per batch, on the trucking PFI, under the
 * Feeding category — "₦50,000 by 32 trucks drivers feeding allowance". Typing
 * it on the trucks and then raising that expense by hand was two entries of
 * the same naira, and the reason "Already paid in Expenses" exists. So the
 * truck's figure now raises the request itself (the user, 2026-10-21):
 *
 *   - Feeding entered on a truck, not ticked as already paid, goes on its
 *     PFI's open Feeding request raised from Delivery Costing — one per batch
 *     — or a new one if there is none still pending.
 *   - The request asks for what its trucks carry. A truck changed, cleared or
 *     ticked as paid elsewhere moves the amount while the request is pending;
 *     a request left with no trucks is deleted.
 *   - Once finance takes it forward the trucks' feeding is fixed
 *     (deliveryInventory.repository feedingLockedIds).
 *
 * Counted once: the truck's feeding counts as a trip cost until its request
 * is paid, then the PFI's paid expenses carry it (lib/tripCosts.js). A
 * rejected or deleted request leaves the feeding on the truck, where it can be
 * corrected and saved again.
 */
const { client } = require("../db");
const pfiExpenseRepo = require("../repositories/pfiExpense.repository");
const { notifyExpenseStage } = require("./expenseNotifications.service");

const ints = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

/** The chart's Feeding account (5430), not a PFI's own category. */
const feedingCategoryId = async (tx) => {
  const [c] = await tx`
    SELECT id FROM expense_categories
     WHERE pfi_id IS NULL AND lower(name) = 'feeding'
     ORDER BY (gl_code = '5430') DESC NULLS LAST, id
     LIMIT 1`;
  return c ? Number(c.id) : null;
};

/** "Drivers' feeding allowance: 32 trucks on PFI-47D, ₦50,000 each." */
const describe = ({ trucks, total, each, codes }) =>
  `Drivers' feeding allowance: ${trucks} truck${trucks === 1 ? "" : "s"}` +
  `${codes ? ` on ${codes}` : ""}, ${each != null ? `${naira(each)} each` : `${naira(total)} in all`}. ` +
  "Raised from Delivery Costing.";

/**
 * Make the Feeding requests match these trips' feeding.
 *
 * @param {object} p
 * @param {number[]} p.tripIds       trips whose feeding was just written
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
          SELECT id, pfi_id, feeding_allowance, feeding_in_expenses, feeding_expense_id
            FROM delivery_inventory WHERE id = ANY(${ids}::int[]) FOR UPDATE`
      : [];
    const linked = ints([...trips.map((t) => t.feeding_expense_id), ...also]);
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
      const e = t.feeding_expense_id ? requests.get(Number(t.feeding_expense_id)) : null;
      const owes = Number(t.feeding_allowance) > 0 && !t.feeding_in_expenses;
      if (live(e)) {
        // Taken forward by finance: fixed, and the save refused the change.
        if (!open(e)) continue;
        if (!owes) await tx`UPDATE delivery_inventory SET feeding_expense_id = NULL WHERE id = ${t.id}`;
        dirty.add(Number(e.id));
        continue;
      }
      if (!owes) continue;
      if (t.pfi_id == null) { out.noPfi += 1; continue; }
      if (!needs.has(Number(t.pfi_id))) needs.set(Number(t.pfi_id), []);
      needs.get(Number(t.pfi_id)).push(Number(t.id));
    }

    if (needs.size) {
      const category = await feedingCategoryId(tx);
      if (!category) {
        out.noCategory = true;
      } else {
        for (const [pfiId, tripList] of needs) {
          // The PFI's request from Delivery Costing still waiting: the batch's one.
          const [pending] = await tx`
            SELECT e.id FROM pfi_expenses e
             WHERE e.pfi_id = ${pfiId} AND e.category_id = ${category}
               AND e.status = 'pending' AND e.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM delivery_inventory d WHERE d.feeding_expense_id = e.id)
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
          await tx`UPDATE delivery_inventory SET feeding_expense_id = ${id} WHERE id = ANY(${tripList}::int[])`;
          dirty.add(id);
        }
      }
    }

    // Each request touched now asks for exactly what its trucks carry.
    for (const id of dirty) {
      const [e] = await tx`SELECT * FROM pfi_expenses WHERE id = ${id}`;
      if (!e || e.deleted_at || e.status !== "pending") continue;
      const [sum] = await tx`
        SELECT count(*)::int AS trucks,
               COALESCE(sum(feeding_allowance), 0)::numeric AS total,
               count(DISTINCT feeding_allowance)::int AS amounts,
               min(feeding_allowance)::numeric AS each,
               string_agg(DISTINCT NULLIF(allocation_code, ''), ', ') AS codes
          FROM delivery_inventory
         WHERE feeding_expense_id = ${id} AND feeding_allowance > 0 AND NOT feeding_in_expenses`;
      const isNew = created.includes(id);

      if (sum.trucks === 0) {
        await tx`UPDATE pfi_expenses SET deleted_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
        await tx`UPDATE delivery_inventory SET feeding_expense_id = NULL WHERE feeding_expense_id = ${id}`;
        await pfiExpenseRepo.writeAudit({
          expenseId: id,
          action: "deleted",
          changes: { note: "No truck's feeding left on it in Delivery Costing" },
          actorId: actor.id ?? null,
          actorName: actor.name || "",
        }, tx);
        out.dropped.push({ reference: e.reference_number });
        continue;
      }

      const total = Number(sum.total);
      const description = describe({
        trucks: sum.trucks,
        total,
        each: sum.amounts === 1 ? Number(sum.each) : null,
        codes: sum.codes,
      });
      if (!isNew && Number(e.amount) === total && e.description === description) continue;

      const row = await pfiExpenseRepo.updateExpense(id, { amount: String(total), description }, tx);
      await pfiExpenseRepo.writeAudit({
        expenseId: id,
        action: isNew ? "created" : "updated",
        changes: isNew
          ? { ...row, note: "Raised from Delivery Costing" }
          : { amount: { from: e.amount, to: row.amount }, note: "Trucks' feeding changed in Delivery Costing" },
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

/** What a save did to the requests, in a sentence for the toast. */
function sentence(result, pfiNames = new Map()) {
  const on = (r) => (pfiNames.get(r.pfiId) ? ` on ${pfiNames.get(r.pfiId)}` : "");
  const parts = [
    ...result.raised.map((r) => `Feeding request ${r.reference} raised${on(r)} for ${naira(r.amount)}, ${r.trucks} truck${r.trucks === 1 ? "" : "s"}`),
    ...result.changed.map((r) => `Feeding request ${r.reference} now ${naira(r.amount)} for ${r.trucks} truck${r.trucks === 1 ? "" : "s"}`),
    ...result.dropped.map((r) => `Feeding request ${r.reference} deleted — no truck's feeding left on it`),
  ];
  if (result.noPfi) parts.push(`${result.noPfi} truck${result.noPfi === 1 ? " is" : "s are"} on no PFI, so no feeding request was raised for ${result.noPfi === 1 ? "it" : "them"}`);
  if (result.noCategory) parts.push("No Feeding account in the chart, so no feeding request was raised");
  return parts.join(". ");
}

module.exports = { sync, sentence };
