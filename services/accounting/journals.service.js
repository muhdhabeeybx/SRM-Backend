const { sql } = require("drizzle-orm");
const { db } = require("../../db");
const auditLogRepo = require("../../repositories/auditLog.repository");
const { settings, firstOpenDay } = require("./posting.service");

/**
 * Journals written by hand — the accountant's own entries: depreciation,
 * accruals, salaries not raised as expenses, corrections.
 *
 * Everything else in the books is posted from the desks' records; this is
 * the one door for what no desk records. So it keeps the books' rules:
 *
 *   it balances            two lines or more, debits equal to credits — and
 *                          the database checks again when it commits (0082)
 *   no bank, no Suspense   a bank account in the books is its statement, and
 *                          Suspense is what still needs matching; a hand entry
 *                          in either would make both untrue
 *   an open month          on or after the books' start, never in a closed month
 *   never edited           put right by reversing it, which is also an entry
 *   two people             one writes it, somebody else approves it — only
 *                          then is it posted (maker-checker). Nobody approves
 *                          their own, a super admin included.
 *
 * Writing, approving, rejecting and reversing are each recorded in the audit
 * log, in the same transaction.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status });
const toKobo = (v) => Math.round((Number(v) || 0) * 100);
const rowsOf = (r) => r.rows ?? r;

const UNITS = ["depot", "trucking", "stations", "lpg_plants", "fleet", "head_office"];

async function checkDay(day) {
  const { booksStart } = await settings();
  const open = await firstOpenDay(booksStart);
  if (day < booksStart) throw httpError(400, `The books start on ${booksStart}; a journal cannot go before that`);
  if (day < open) throw httpError(400, `${day.slice(0, 7)} is closed — date the journal on or after ${open}`);
}

/** The lines as the books will hold them, or a refusal that says what is wrong. */
async function checked({ day, memo, lines }) {
  if (!memo || !memo.trim()) throw httpError(400, "Say what the journal is for");
  await checkDay(day);

  const clean = (lines || []).map((l) => {
    const debit = toKobo(l.debit);
    const credit = toKobo(l.credit);
    if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
      throw httpError(400, "Each line is a debit or a credit — one of them, above nought");
    }
    if (l.unit && !UNITS.includes(l.unit)) throw httpError(400, `${l.unit} is not a unit the books know`);
    const [type, id] = l.location ? String(l.location).split(":") : [null, null];
    return {
      accountId: Number(l.accountId), debit, credit,
      partyType: l.partyType || null, partyId: l.partyId ?? null, pfiId: l.pfiId ?? null,
      unit: l.unit || null, locationType: type || null, locationId: id ? Number(id) : null, memo: l.memo || "",
    };
  });
  if (clean.length < 2) throw httpError(400, "A journal needs at least two lines");
  const dr = clean.reduce((t, l) => t + l.debit, 0);
  const cr = clean.reduce((t, l) => t + l.credit, 0);
  if (dr !== cr) throw httpError(400, `Debits (₦${(dr / 100).toLocaleString()}) and credits (₦${(cr / 100).toLocaleString()}) must agree`);

  const ids = [...new Set(clean.map((l) => l.accountId))];
  const accounts = rowsOf(await db.execute(sql`
    SELECT id, name, system_key, bank_account_id FROM expense_categories WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
  for (const id of ids) {
    const a = accounts.find((x) => Number(x.id) === id);
    if (!a) throw httpError(400, "One of those accounts is not in the chart");
    if (a.bank_account_id != null) throw httpError(400, `${a.name} moves only with its statement — name the bank line on Bank Reconciliation instead`);
    if (a.system_key === "suspense") throw httpError(400, "Suspense clears itself as lines are matched — it takes no journal");
  }
  return { day, memo: memo.trim(), lines: clean, amount: dr / 100 };
}

const actor = (staffId) => (staffId ? { type: "staff", staffId } : { type: "system" });

/**
 * Write a journal: checked, then kept waiting for somebody else to approve.
 * Nothing is in the books yet.
 */
async function write({ day, memo, lines, staffId }) {
  const j = await checked({ day, memo, lines });
  return db.transaction(async (tx) => {
    const [draft] = rowsOf(await tx.execute(sql`
      INSERT INTO journal_drafts (entry_date, memo, lines, written_by)
      VALUES (${j.day}, ${j.memo}, ${JSON.stringify(j.lines)}::jsonb, ${staffId}) RETURNING id`));
    await auditLogRepo.record({
      entityType: "journal_draft", entityId: Number(draft.id), action: "journal.written",
      actor: actor(staffId), newState: { day: j.day, memo: j.memo, amount: j.amount, lines: j.lines },
    }, tx);
    return { draftId: Number(draft.id), amount: j.amount };
  });
}

/** Journals waiting for approval, and the last ones decided. */
async function drafts({ status = "waiting", limit = 100 } = {}) {
  const rows = rowsOf(await db.execute(sql`
    SELECT d.id, d.entry_date::text AS day, d.memo, d.lines, d.status, d.written_at, d.decided_at, d.reject_reason, d.entry_id,
           d.written_by, concat_ws(' ', w.first_name, w.surname) AS written_by_name,
           concat_ws(' ', k.first_name, k.surname) AS decided_by_name
      FROM journal_drafts d
      LEFT JOIN staff w ON w.id = d.written_by
      LEFT JOIN staff k ON k.id = d.decided_by
     WHERE (${status}::text IS NULL OR d.status = ${status})
     ORDER BY d.id DESC
     LIMIT ${Number(limit)}`));
  const accountIds = [...new Set(rows.flatMap((r) => (r.lines || []).map((l) => Number(l.accountId))))];
  const names = accountIds.length
    ? new Map(rowsOf(await db.execute(sql`SELECT id, gl_code, name FROM expense_categories WHERE id IN (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})`))
        .map((a) => [Number(a.id), { code: a.gl_code || "", name: a.name }]))
    : new Map();
  return rows.map((r) => ({
    id: Number(r.id), day: r.day, memo: r.memo, status: r.status, writtenAt: r.written_at, decidedAt: r.decided_at,
    writtenBy: r.written_by == null ? null : Number(r.written_by), writtenByName: r.written_by_name || "",
    decidedByName: r.decided_by_name || "", rejectReason: r.reject_reason || "", entryId: r.entry_id == null ? null : Number(r.entry_id),
    amount: (r.lines || []).reduce((t, l) => t + l.debit, 0) / 100,
    lines: (r.lines || []).map((l) => ({ ...names.get(Number(l.accountId)), accountId: Number(l.accountId), debit: l.debit / 100, credit: l.credit / 100, unit: l.unit })),
  }));
}

async function waitingDraft(draftId) {
  const [d] = rowsOf(await db.execute(sql`SELECT *, entry_date::text AS day FROM journal_drafts WHERE id = ${Number(draftId)}`));
  if (!d) throw httpError(404, "That journal is not waiting anywhere");
  if (d.status !== "waiting") throw httpError(409, `That journal has already been ${d.status}`);
  return d;
}

/** Approve and post: by anybody but whoever wrote it, into a month still open. */
async function approve({ draftId, staffId }) {
  const d = await waitingDraft(draftId);
  if (d.written_by != null && Number(d.written_by) === Number(staffId)) {
    throw httpError(403, "Somebody other than whoever wrote a journal has to approve it");
  }
  // Checked again: the month may have closed, or an account moved, since it was written.
  const j = await checked({
    day: d.day,
    memo: d.memo,
    lines: d.lines.map((l) => ({ ...l, debit: l.debit / 100, credit: l.credit / 100, location: l.locationType ? `${l.locationType}:${l.locationId}` : null })),
  });

  return db.transaction(async (tx) => {
    const [entry] = rowsOf(await tx.execute(sql`
      INSERT INTO journal_entries (entry_date, kind, memo, created_by)
      VALUES (${j.day}, 'manual', ${j.memo}, ${d.written_by}) RETURNING id`));
    for (const l of j.lines) {
      await tx.execute(sql`
        INSERT INTO journal_lines (entry_id, account_id, debit, credit, party_type, party_id, pfi_id, unit, location_type, location_id, memo)
        VALUES (${entry.id}, ${l.accountId}, ${(l.debit / 100).toFixed(2)}, ${(l.credit / 100).toFixed(2)},
                ${l.partyType}, ${l.partyId}, ${l.pfiId}, ${l.unit}, ${l.locationType}, ${l.locationId}, ${l.memo})`);
    }
    // Guarded by its status, so two approvals at once post it once.
    const done = rowsOf(await tx.execute(sql`
      UPDATE journal_drafts SET status = 'posted', decided_by = ${staffId}, decided_at = now(), entry_id = ${entry.id}
       WHERE id = ${d.id} AND status = 'waiting' RETURNING id`));
    if (!done.length) throw httpError(409, "That journal was decided a moment ago");
    await auditLogRepo.record({
      entityType: "journal_entry", entityId: Number(entry.id), action: "journal.approved",
      actor: actor(staffId), metadata: { draftId: Number(d.id), writtenBy: d.written_by },
    }, tx);
    return { entryId: Number(entry.id), amount: j.amount };
  });
}

async function reject({ draftId, reason, staffId }) {
  const d = await waitingDraft(draftId);
  if (!reason || !reason.trim()) throw httpError(400, "Say why it is rejected, so whoever wrote it can put it right");
  return db.transaction(async (tx) => {
    const done = rowsOf(await tx.execute(sql`
      UPDATE journal_drafts SET status = 'rejected', decided_by = ${staffId}, decided_at = now(), reject_reason = ${reason.trim()}
       WHERE id = ${d.id} AND status = 'waiting' RETURNING id`));
    if (!done.length) throw httpError(409, "That journal was decided a moment ago");
    await auditLogRepo.record({
      entityType: "journal_draft", entityId: Number(d.id), action: "journal.rejected",
      actor: actor(staffId), metadata: { reason: reason.trim() },
    }, tx);
    return { draftId: Number(d.id) };
  });
}

/**
 * Reverse a journal written by hand: the same lines, sides swapped, on a day
 * that is open. The original stays, with the reversal pointing at it.
 */
async function reverse({ entryId, day, staffId }) {
  const [entry] = rowsOf(await db.execute(sql`
    SELECT e.id, e.kind, e.memo, e.entry_date::text AS day,
           EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed
      FROM journal_entries e WHERE e.id = ${Number(entryId)}`));
  if (!entry) throw httpError(404, "That journal entry is not in the books");
  if (entry.kind !== "manual") throw httpError(400, "Only a journal written by hand is reversed here — the rest follow their records");
  if (entry.reversed) throw httpError(409, "That journal has already been reversed");
  const on = day || entry.day;
  await checkDay(on);

  return db.transaction(async (tx) => {
    // One reversal, however many people press it at once: the second waits
    // here for the first to commit, then finds it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7340082, ${Number(entry.id)})`);
    const again = rowsOf(await tx.execute(sql`
      SELECT 1 FROM journal_entries WHERE reverses_entry_id = ${entry.id} LIMIT 1`));
    if (again.length) throw httpError(409, "That journal has already been reversed");
    const [rev] = rowsOf(await tx.execute(sql`
      INSERT INTO journal_entries (entry_date, kind, memo, reverses_entry_id, created_by)
      VALUES (${on}, 'reversal', ${`Reversed: ${entry.memo}`}, ${entry.id}, ${staffId}) RETURNING id`));
    await tx.execute(sql`
      INSERT INTO journal_lines (entry_id, account_id, debit, credit, party_type, party_id, pfi_id, bank_account_id, unit, location_type, location_id, memo)
      SELECT ${rev.id}, account_id, credit, debit, party_type, party_id, pfi_id, bank_account_id, unit, location_type, location_id, memo
        FROM journal_lines WHERE entry_id = ${entry.id}`);
    await auditLogRepo.record({
      entityType: "journal_entry", entityId: Number(entry.id), action: "journal.reversed",
      actor: staffId ? { type: "staff", staffId } : { type: "system" },
      metadata: { reversalId: Number(rev.id), day: on },
    }, tx);
    return { entryId: Number(rev.id) };
  });
}

module.exports = { write, drafts, approve, reject, reverse };
