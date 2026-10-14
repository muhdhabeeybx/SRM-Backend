const { client } = require("../db");

/**
 * Vendors saved under several names, found and merged into one (0086).
 *
 * ── Which names are one vendor ────────────────────────────────────────────
 *
 * Names are compared as words, less the words every company name carries
 * (Ltd, Limited, Nig, Enterprise, Services…). Two names are one vendor when
 * they then read the same ("Tetris Energy" / "Tetris Energy Ltd"), when one
 * is the start of the other ("Keonamex" / "KEONAMEX PETROLEUM NIG LTD"), or
 * when a long name differs by a slip of the keyboard ("REMITA CHECOUT"). These
 * are suggestions: Finance looks at each group before anything is merged.
 *
 * ── What merging does ─────────────────────────────────────────────────────
 *
 * The vendor kept is the one used most. It takes the name Finance chose, and
 * any contact or bank detail it lacks from the others. Every expense, every
 * cargo naming one of them as supplier, and every bank line named to one of
 * them, moves to it — each expense's move written to its own audit, the
 * merge to the audit log. The others are not deleted: each stays as a name
 * pointing at the vendor kept (merged_into_id), off every list, so the name
 * still finds it. The books follow on their next run.
 */

const STOP = new Set([
  "ltd", "limited", "nig", "nigeria", "plc", "co", "company", "enterprise", "enterprises", "ent", "and", "the",
  "int", "intl", "international", "services", "service", "global", "resources", "ventures", "venture", "concept", "concepts",
]);
const keyOf = (name) => String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()
  .split(" ").filter((w) => w && !STOP.has(w)).join("");
const tidy = (name) => String(name || "").replace(/\s+/g, " ").trim();
const LONGEST_NAME = 40;

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Two names, one vendor? */
function sameVendor(a, b) {
  const x = keyOf(a);
  const y = keyOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 6 && long.startsWith(short)) return true;
  return short.length >= 8 && distance(x, y) <= Math.max(1, Math.floor(short.length / 8));
}

/**
 * Which member to keep, and the name to keep it under: the member used most
 * (then the oldest); the fullest form of its name another member carries —
 * its name and more — if that is a name rather than a sentence.
 */
function suggest(members) {
  const keep = [...members].sort((a, b) => b.expenseCount - a.expenseCount || a.id - b.id)[0];
  const k = keyOf(keep.name);
  const fuller = members
    .filter((m) => tidy(m.name).length <= LONGEST_NAME && keyOf(m.name).startsWith(k))
    // Fullest first: more of the name, then the longer way of writing it
    // ("Tetris Energy Ltd" over "TETRIS ENERGY"), then the one used most.
    .sort((a, b) => keyOf(b.name).length - keyOf(a.name).length || tidy(b.name).length - tidy(a.name).length
      || b.expenseCount - a.expenseCount || a.id - b.id)[0];
  return { keepId: keep.id, name: tidy((fuller || keep).name) };
}

/** Groups of vendors that look like one vendor, each with what to keep. */
async function duplicates() {
  const vendors = (await client`
    SELECT v.id, v.name, v.status,
           (SELECT COUNT(*) FROM pfi_expenses e WHERE e.vendor_id = v.id AND e.deleted_at IS NULL)::int AS expense_count,
           (SELECT COALESCE(SUM(COALESCE(e.amount_paid_ngn, e.amount_paid)), 0) FROM pfi_expenses e
             WHERE e.vendor_id = v.id AND e.deleted_at IS NULL AND e.status = 'paid')::numeric AS paid,
           (SELECT MAX(e.expense_date)::date::text FROM pfi_expenses e WHERE e.vendor_id = v.id AND e.deleted_at IS NULL) AS last_used
      FROM vendors v WHERE v.merged_into_id IS NULL ORDER BY v.id`)
    .map((v) => ({ id: Number(v.id), name: v.name, status: v.status, expenseCount: v.expense_count, paid: Math.round(Number(v.paid) * 100) / 100, lastUsed: v.last_used }));

  const parent = new Map(vendors.map((v) => [v.id, v.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  for (let i = 0; i < vendors.length; i++) {
    for (let j = i + 1; j < vendors.length; j++) {
      if (sameVendor(vendors[i].name, vendors[j].name)) parent.set(find(vendors[i].id), find(vendors[j].id));
    }
  }
  const groups = new Map();
  for (const v of vendors) {
    const root = find(v.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(v);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((members) => ({ members: members.sort((a, b) => a.name.localeCompare(b.name)), ...suggest(members) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const DETAILS = ["contact_person", "phone", "email", "address", "bank_name", "account_number", "account_name", "tax_id"];

/**
 * Merge vendors into one.
 *
 * @param {{ keepId: number, mergeIds: number[], name?: string, staffId?: number, actorName?: string }} p
 */
async function merge({ keepId, mergeIds, name = null, staffId = null, actorName = "" }) {
  const keep = Number(keepId);
  const others = [...new Set((mergeIds || []).map(Number))].filter((id) => id && id !== keep);
  if (!others.length) throw httpError(400, "Choose at least one other vendor to merge into this one");

  return client.begin(async (tx) => {
    const rows = await tx`SELECT * FROM vendors WHERE id = ANY(${[keep, ...others]}::int[]) FOR UPDATE`;
    const kept = rows.find((r) => Number(r.id) === keep);
    if (!kept) throw httpError(404, "The vendor to keep is not on file");
    if (kept.merged_into_id) throw httpError(409, `${kept.name} was itself merged into another vendor`);
    const merging = others.map((id) => rows.find((r) => Number(r.id) === id));
    if (merging.some((r) => !r)) throw httpError(404, "One of those vendors is not on file");
    if (merging.some((r) => r.merged_into_id)) throw httpError(409, "One of those vendors has already been merged");

    // The name kept: as chosen, tidied; not one another vendor already uses.
    const finalName = tidy(name || kept.name);
    if (!finalName) throw httpError(400, "Give the vendor a name");
    const nameKey = String(finalName).toLowerCase().replace(/[^a-z0-9]/g, "");
    const [clash] = await tx`
      SELECT id, name FROM vendors
       WHERE merged_into_id IS NULL AND NOT (id = ANY(${[keep, ...others]}::int[]))
         AND regexp_replace(LOWER(name), '[^a-z0-9]', '', 'g') = ${nameKey} LIMIT 1`;
    if (clash) throw httpError(409, `Another vendor is already called ${clash.name}`);

    // A name is held by one vendor only (vendors_name_idx, on its lower case).
    // The one whose name the vendor kept takes gives it up — the vendor kept
    // now answers to it — and is marked as merged.
    for (const r of merging) {
      if (String(r.name).toLowerCase() === finalName.toLowerCase()) {
        await tx`UPDATE vendors SET name = ${`${tidy(r.name)} · merged ${r.id}`} WHERE id = ${r.id}`;
      }
    }

    // Contact and bank details the vendor kept lacks, from the others.
    const patch = {};
    for (const col of DETAILS) {
      if (String(kept[col] || "").trim()) continue;
      const from = merging.find((r) => String(r[col] || "").trim());
      if (from) patch[col] = from[col];
    }
    await tx`
      UPDATE vendors SET ${tx({ ...patch, name: finalName, status: "Active" })}, updated_at = now()
       WHERE id = ${keep}`;

    // Everything that names the others now names the vendor kept.
    const moved = await tx`
      UPDATE pfi_expenses SET vendor_id = ${keep}, updated_at = now()
       WHERE vendor_id = ANY(${others}::int[]) RETURNING id, vendor_id`;
    for (const e of moved) {
      await tx`
        INSERT INTO pfi_expense_audits (expense_id, action, changes, actor_id, actor_name)
        VALUES (${e.id}, 'vendor_merged', ${JSON.stringify({ vendor_id: keep, vendor: finalName, merged: merging.map((r) => r.name) })},
                ${staffId}, ${actorName || "Vendors page"})`;
    }
    const cargos = await tx`UPDATE pfis SET supplier_vendor_id = ${keep} WHERE supplier_vendor_id = ANY(${others}::int[]) RETURNING id`;
    const lines = await tx`UPDATE bank_line_classifications SET vendor_id = ${keep} WHERE vendor_id = ANY(${others}::int[]) RETURNING id`;
    // Anything already merged into one of the others follows it to the vendor kept.
    await tx`UPDATE vendors SET merged_into_id = ${keep} WHERE merged_into_id = ANY(${others}::int[])`;
    await tx`
      UPDATE vendors SET merged_into_id = ${keep}, merged_at = now(), merged_by = ${staffId}, status = 'Inactive', updated_at = now()
       WHERE id = ANY(${others}::int[])`;

    // The audit log, in this transaction (auditLog.repository writes through
    // drizzle; this merge runs on the raw client).
    await tx`
      INSERT INTO audit_logs (entity_type, entity_id, action, prev_state, new_state, actor_type, actor_staff_id, metadata)
      VALUES ('vendor', ${keep}, 'vendor.merged', NULL, 'merged',
              ${staffId ? "staff" : "system"}, ${staffId},
              ${JSON.stringify({
                name: { before: kept.name, after: finalName },
                merged: merging.map((r) => ({ id: Number(r.id), name: r.name })),
                filledIn: Object.keys(patch), expenses: moved.length, cargos: cargos.length, bankLines: lines.length,
              })}::jsonb)`;

    return { keepId: keep, name: finalName, merged: merging.length, expenses: moved.length, cargos: cargos.length, bankLines: lines.length };
  });
}

/** The vendor a vendor now is: itself, or the one it was merged into. */
async function resolve(id, tx = client) {
  let current = Number(id);
  for (let i = 0; i < 10; i++) {
    const [r] = await tx`SELECT id, merged_into_id FROM vendors WHERE id = ${current}`;
    if (!r || r.merged_into_id == null) return r ? Number(r.id) : null;
    current = Number(r.merged_into_id);
  }
  return current;
}

module.exports = { duplicates, merge, resolve, sameVendor, suggest, keyOf };
