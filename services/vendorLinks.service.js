const { client } = require("../db");

/**
 * Expenses that name their vendor only as typed text, linked to the saved
 * vendor that name belongs to.
 *
 * An expense raised before the vendor picker carries its vendor as text
 * (pfi_expenses.vendor), so it is on no vendor's statement and in no vendor's
 * figures. Where the text names a saved vendor — compared the way the request
 * form and vendorRepo.findByName compare names, ignoring case, spaces and
 * punctuation — it is linked to that vendor.
 *
 * Only blanks are filled: an expense already linked is never moved, and no
 * vendor is created. Each link is written to the expense's own audit. The
 * Vendors page offers this to Finance; scripts/link-expense-vendors.js runs
 * the same from a terminal.
 */

const keyOf = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function look() {
  const vendors = await client`SELECT id, name FROM vendors`;
  const byKey = new Map();
  for (const v of vendors) {
    const k = keyOf(v.name);
    // Two vendors that read the same: the older one, as findByName picks.
    if (k && (!byKey.has(k) || Number(v.id) < Number(byKey.get(k).id))) byKey.set(k, v);
  }
  const unlinked = await client`
    SELECT e.id, e.vendor, e.status::text AS status, COALESCE(c.is_refund, false) AS refund,
           COALESCE(e.amount_ngn, CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN e.amount END)::numeric AS amount
      FROM pfi_expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.vendor_id IS NULL AND e.deleted_at IS NULL AND btrim(COALESCE(e.vendor, '')) <> ''`;
  const matched = [];
  const unmatched = new Map();
  for (const e of unlinked) {
    const v = byKey.get(keyOf(e.vendor));
    if (v) matched.push({ expense: e, vendor: v });
    else {
      const k = keyOf(e.vendor);
      const u = unmatched.get(k) || { name: String(e.vendor).trim(), count: 0, amount: 0 };
      u.count += 1;
      u.amount += Number(e.amount) || 0;
      unmatched.set(k, u);
    }
  }
  return { unlinked, matched, unmatched };
}

/** What linking would do: how many expenses name a vendor only as text, how many match one, and the names that do not. */
async function preview() {
  const { unlinked, matched, unmatched } = await look();
  // Money that is on nobody's figures: approved or paid, and a vendor's (not a refund).
  const counted = unlinked.filter((e) => ["admin_approved", "paid"].includes(e.status) && !e.refund);
  return {
    unlinked: unlinked.length,
    unlinkedApproved: { count: counted.length, amount: Math.round(counted.reduce((t, e) => t + (Number(e.amount) || 0), 0) * 100) / 100 },
    matched: matched.length,
    unmatchedNames: [...unmatched.values()].sort((a, b) => b.count - a.count).slice(0, 20)
      .map((u) => ({ ...u, amount: Math.round(u.amount * 100) / 100 })),
  };
}

/** Link every expense whose typed name matches a saved vendor. */
async function apply({ staffId = null, actorName = "Vendor link" } = {}) {
  const { matched } = await look();
  let linked = 0;
  await client.begin(async (tx) => {
    for (const { expense, vendor } of matched) {
      // Only a blank is filled, even if somebody linked it a moment ago.
      const [row] = await tx`
        UPDATE pfi_expenses SET vendor_id = ${vendor.id}, updated_at = now()
         WHERE id = ${expense.id} AND vendor_id IS NULL RETURNING id`;
      if (!row) continue;
      await tx`
        INSERT INTO pfi_expense_audits (expense_id, action, changes, actor_id, actor_name)
        VALUES (${expense.id}, 'vendor_linked',
                ${JSON.stringify({ vendor_id: vendor.id, vendor: vendor.name, from_text: expense.vendor })},
                ${staffId}, ${actorName})`;
      linked += 1;
    }
  });
  return { linked };
}

module.exports = { preview, apply, keyOf };
