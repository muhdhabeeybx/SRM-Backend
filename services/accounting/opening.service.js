const { client } = require("../../db");
const { settings } = require("./posting.service");
const { statementBalance } = require("./reconciliation.service");
const gl = require("../../lib/glAccounts");

/**
 * The opening balances — what the books carry in on the day before they start
 * (accounting_settings.books_start, 1 Sep 2026 — 0085) — and the months after it,
 * open or closed.
 *
 * ── Where each opening figure comes from ──────────────────────────────────
 *
 *   banks            the balance the bank's own statement prints beside its
 *                    last line on or before that day
 *   customers,       each one's balance from the records before the books
 *   trucking,        started, exactly as the posting engine read them
 *   stations,        (ledger_postings) — so a customer's opening is their
 *   vendors, FIRS    statement's balance that day, to the kobo
 *   stock            each cargo's cost before that day — the product and the
 *                    cargo costs that go into stock — less the cost of what
 *                    it sold, at its landed cost per litre
 *   fixed assets,    the Fixed Assets and Loans registers (0088): what each
 *   their wear,      asset owned that day cost and had worn, and what each
 *   loans            loan still owed
 *   the rest         typed by the accountant: capital, what is owed to cargo
 *                    suppliers
 *
 * Whatever does not balance goes to Opening balance equity. The entry is
 * posted once; it can be replaced only while the first month is open, by a
 * reversal and a new one, never by editing it.
 */

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dayBefore = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Control accounts carried from the records, by party. */
const FROM_RECORDS = [
  "customer_receivables", "trucking_receivables", "station_takings", "plant_takings",
  "vendor_payables", "vat_payable", "wht_payable", "commissions_payable",
  "fixed_assets", "accumulated_depreciation", "loans",
];
/** Carried from a register rather than the desks' records (0088). */
const FROM_REGISTER = {
  fixed_assets: "the Fixed Assets register",
  accumulated_depreciation: "the Fixed Assets register",
  loans: "the Loans register",
};

async function proposal() {
  const { booksStart } = await settings();
  const day = dayBefore(booksStart);
  const chart = await client`SELECT id, gl_code, name, gl_group, system_key, bank_account_id FROM expense_categories WHERE system_key IS NOT NULL`;
  const byKey = new Map(chart.map((a) => [a.system_key, a]));
  const sideOf = new Map(chart.map((a) => [Number(a.id), gl.normalSideOf(gl.accountTypeOf(a.gl_group))]));
  const lines = [];

  // Banks: the statement's own printed balance.
  // Read under the Balance heading, at the end of its last day (see
  // reconciliation.service statementBalance), money in and out alike.
  for (const a of chart.filter((x) => x.bank_account_id != null)) {
    const printed = await statementBalance(Number(a.bank_account_id), day);
    lines.push({
      accountId: Number(a.id), code: a.gl_code, name: a.name,
      amount: printed?.balance ?? 0,
      source: !printed
        ? "No statement balance — type it from the bank's statement"
        : printed.day === day
          ? `Statement balance on ${printed.day}`
          : `Last balance on file is ${printed.day}'s — check it against the bank's closing balance on ${day}`,
      editable: true,
    });
  }

  // Customers, trucking, stations, vendors, FIRS: from the records before the
  // books started, party by party.
  const ids = FROM_RECORDS.map((k) => byKey.get(k)?.id).filter(Boolean).map(Number);
  const carried = await client`
    SELECT (l->>'a')::int AS account_id, l->>'p' AS party_type, (l->>'i')::int AS party_id,
           SUM((l->>'k')::bigint) AS kobo
      FROM ledger_postings lp, jsonb_array_elements(lp.lines) l
     WHERE l->>'d' < ${booksStart} AND (l->>'a')::int = ANY(${ids}::int[])
     GROUP BY 1, 2, 3
    HAVING SUM((l->>'k')::bigint) <> 0`;
  for (const key of FROM_RECORDS) {
    const a = byKey.get(key);
    if (!a) continue;
    const parties = carried.filter((r) => Number(r.account_id) === Number(a.id));
    const total = money(parties.reduce((t, r) => t + Number(r.kobo), 0) / 100);
    const register = FROM_REGISTER[key];
    lines.push({
      accountId: Number(a.id), code: a.gl_code, name: a.name, amount: total,
      source: register
        ? (parties.length ? `From ${register}, as it stood on ${day}` : `Nothing on ${register} before ${booksStart}`)
        : parties.length ? `From the records before ${booksStart}, ${parties.length} ${parties.length === 1 ? "party" : "parties"}` : "Nothing before the books started",
      editable: false,
      parties: parties.map((r) => ({ partyType: r.party_type, partyId: r.party_id, amount: money(Number(r.kobo) / 100) })),
    });
  }

  // Stock: what each cargo cost before the books started — the product, its
  // cargo costs that go into stock — less the cost of what it sold, at its
  // landed cost per litre. Read from the same records as everything else, so
  // the opening and the cost of later sales are one figure per litre.
  const stock = byKey.get("stock");
  if (stock) {
    const perPfi = await client`
      SELECT (l->>'f')::int AS pfi_id, p.pfi_number, SUM((l->>'k')::bigint) AS kobo
        FROM ledger_postings lp, jsonb_array_elements(lp.lines) l
        LEFT JOIN pfis p ON p.id = (l->>'f')::int
       WHERE l->>'d' < ${booksStart} AND (l->>'a')::int = ${stock.id}
       GROUP BY 1, 2
      HAVING SUM((l->>'k')::bigint) <> 0`;
    const pfis = perPfi.map((r) => ({ pfiId: r.pfi_id == null ? null : Number(r.pfi_id), pfiNumber: r.pfi_number || "No PFI", amount: money(Number(r.kobo) / 100) }));
    lines.push({
      accountId: Number(stock.id), code: stock.gl_code, name: stock.name,
      amount: money(pfis.reduce((t, p) => t + p.amount, 0)),
      source: pfis.length
        ? `From the records before ${booksStart}: ${pfis.length} PFI${pfis.length === 1 ? "" : "s"}, bought and costed, less what was sold`
        : "Nothing before the books started",
      editable: true,
      pfis,
    });
  }

  // Commission money still with staff: what was handed out on 5410 before the
  // books started, less the commissions marked paid out of it, PFI by PFI
  // (0084). From the records, like the parties above.
  const float = byKey.get("commission_float");
  if (float) {
    const perPfi = await client`
      SELECT (l->>'f')::int AS pfi_id, p.pfi_number, SUM((l->>'k')::bigint) AS kobo
        FROM ledger_postings lp, jsonb_array_elements(lp.lines) l
        LEFT JOIN pfis p ON p.id = (l->>'f')::int
       WHERE l->>'d' < ${booksStart} AND (l->>'a')::int = ${float.id}
       GROUP BY 1, 2
      HAVING SUM((l->>'k')::bigint) <> 0`;
    const pfis = perPfi.map((r) => ({ pfiId: r.pfi_id == null ? null : Number(r.pfi_id), pfiNumber: r.pfi_number || "No PFI", amount: money(Number(r.kobo) / 100) }));
    lines.push({
      accountId: Number(float.id), code: float.gl_code, name: float.name,
      amount: money(pfis.reduce((t, p) => t + p.amount, 0)),
      source: pfis.length
        ? `From the records before ${booksStart}: ${pfis.length} PFI${pfis.length === 1 ? "" : "s"}, money given to staff less commissions paid out of it`
        : "Nothing before the books started",
      editable: false,
      pfis,
    });
  }

  // The rest is the accountant's.
  for (const key of ["supplier_payables", "share_capital", "retained_earnings"]) {
    const a = byKey.get(key);
    if (a) lines.push({ accountId: Number(a.id), code: a.gl_code, name: a.name, amount: 0, source: "Type it", editable: true });
  }

  const posted = await current();
  return {
    booksStart,
    day,
    // Amounts are debit-positive; normalSide says how the account reads, so a
    // payable can be typed as what is owed.
    lines: lines.map((l) => ({ ...l, normalSide: sideOf.get(l.accountId) || "debit" })),
    equityAccountId: Number(byKey.get("opening_balance_equity")?.id),
    posted,
  };
}

/** The opening entry in force, if one has been posted and not reversed. */
async function current() {
  const [e] = await client`
    SELECT e.id, e.entry_date::text AS day, e.created_at, e.created_by, e.memo
      FROM journal_entries e
     WHERE e.kind = 'opening'
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
     ORDER BY e.id DESC LIMIT 1`;
  if (!e) return null;
  const lines = await client`
    SELECT l.account_id, c.gl_code, c.name, SUM(l.debit - l.credit)::numeric AS amount
      FROM journal_lines l JOIN expense_categories c ON c.id = l.account_id
     WHERE l.entry_id = ${e.id} GROUP BY 1, 2, 3 ORDER BY c.gl_code`;
  return { ...e, id: Number(e.id), lines: lines.map((l) => ({ accountId: Number(l.account_id), code: l.gl_code, name: l.name, amount: money(l.amount) })) };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Post the opening balances: the proposal's figures, with the accountant's
 * changes to the ones they may change, and the difference to Opening balance
 * equity. Replaces an earlier opening entry by reversing it.
 *
 * @param {{ amounts: Record<number, number>, staffId: number }} p  debit-positive
 *        figures for the editable accounts, by account id
 */
async function post({ amounts = {}, staffId = null }) {
  const p = await proposal();
  const [firstClosed] = await client`
    SELECT period FROM accounting_periods WHERE status = 'closed' AND period = ${p.booksStart.slice(0, 7)}`;
  if (firstClosed) throw httpError(409, `${p.booksStart.slice(0, 7)} is closed — reopen it before changing the opening balances`);

  const out = [];
  for (const l of p.lines) {
    if (l.parties) {
      for (const party of l.parties) out.push({ account_id: l.accountId, k: Math.round(party.amount * 100), party_type: party.partyType, party_id: party.partyId, pfi_id: null });
    } else if (l.pfis && !(String(l.accountId) in amounts)) {
      for (const pf of l.pfis) out.push({ account_id: l.accountId, k: Math.round(pf.amount * 100), party_type: null, party_id: null, pfi_id: pf.pfiId });
    } else {
      const amount = l.editable && String(l.accountId) in amounts ? Number(amounts[l.accountId]) : l.amount;
      out.push({ account_id: l.accountId, k: Math.round((Number(amount) || 0) * 100), party_type: null, party_id: null, pfi_id: null });
    }
  }
  const lines = out.filter((l) => l.k !== 0);
  const net = lines.reduce((t, l) => t + l.k, 0);
  if (net !== 0) lines.push({ account_id: p.equityAccountId, k: -net, party_type: null, party_id: null, pfi_id: null });
  if (lines.length < 2) throw httpError(400, "There is nothing to open the books with");

  return client.begin(async (tx) => {
    // One posting at a time, and only over the opening entry this one was
    // worked out against — two people posting at once would otherwise each
    // reverse the old entry and leave two openings standing.
    await tx`SELECT pg_advisory_xact_lock(7340083)`;
    const [live] = await tx`
      SELECT e.id FROM journal_entries e
       WHERE e.kind = 'opening' AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
       ORDER BY e.id DESC LIMIT 1`;
    if ((live ? Number(live.id) : null) !== (p.posted ? p.posted.id : null)) {
      throw httpError(409, "The opening balances were posted by somebody else a moment ago — look at them again before posting");
    }
    if (p.posted) {
      const old = await tx`SELECT account_id, debit, credit, party_type, party_id, pfi_id, bank_account_id FROM journal_lines WHERE entry_id = ${p.posted.id}`;
      const [rev] = await tx`
        INSERT INTO journal_entries (entry_date, kind, memo, reverses_entry_id, created_by)
        VALUES (${p.day}, 'reversal', ${"Opening balances replaced"}, ${p.posted.id}, ${staffId}) RETURNING id`;
      await tx`INSERT INTO journal_lines ${tx(old.map((l) => ({ ...l, entry_id: rev.id, debit: l.credit, credit: l.debit })))}`;
    }
    const [entry] = await tx`
      INSERT INTO journal_entries (entry_date, kind, memo, created_by)
      VALUES (${p.day}, 'opening', ${`Opening balances at ${p.day}`}, ${staffId}) RETURNING id`;
    await tx`INSERT INTO journal_lines ${tx(lines.map((l) => ({
      entry_id: entry.id, account_id: l.account_id,
      debit: l.k > 0 ? (l.k / 100).toFixed(2) : "0", credit: l.k < 0 ? (-l.k / 100).toFixed(2) : "0",
      party_type: l.party_type, party_id: l.party_id, pfi_id: l.pfi_id,
    })))}`;
    return { entryId: Number(entry.id), lines: lines.length, toOpeningEquity: money(-net / 100) };
  });
}

// ── Months ────────────────────────────────────────────────────────────────

const monthOf = (day) => day.slice(0, 7);
const nextMonth = (m) => {
  let [y, mo] = m.split("-").map(Number);
  mo += 1;
  if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
};
const lastDayOf = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

/** Every month from the books' start to this one, open or closed. */
async function periods(today) {
  const { booksStart } = await settings();
  const rows = await client`SELECT period, status, closed_at, closed_by, reopened_at FROM accounting_periods`;
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  const out = [];
  for (let m = monthOf(booksStart); m <= monthOf(today); m = nextMonth(m)) {
    const r = byPeriod.get(m);
    out.push({ period: m, status: r?.status || "open", closedAt: r?.closed_at || null, ended: lastDayOf(m) < today });
  }
  return out;
}

/**
 * Close a month. In order, and only once it has ended: a closed month takes
 * nothing new, so a late change is booked on the first open day instead.
 */
async function close(period, { today, staffId }) {
  const list = await periods(today);
  const i = list.findIndex((p) => p.period === period);
  if (i < 0) throw httpError(400, `${period} is not a month of these books`);
  if (!list[i].ended) throw httpError(400, `${period} has not ended yet`);
  if (list.slice(0, i).some((p) => p.status !== "closed")) throw httpError(400, "Close the months before it first");
  await client`
    INSERT INTO accounting_periods (period, status, closed_at, closed_by)
    VALUES (${period}, 'closed', now(), ${staffId})
    ON CONFLICT (period) DO UPDATE SET status = 'closed', closed_at = now(), closed_by = ${staffId}`;
  return periods(today);
}

/** Reopen the latest closed month — never one with a closed month after it. */
async function reopen(period, { today, staffId }) {
  const list = await periods(today);
  const i = list.findIndex((p) => p.period === period);
  if (i < 0 || list[i].status !== "closed") throw httpError(400, `${period} is not closed`);
  if (list.slice(i + 1).some((p) => p.status === "closed")) throw httpError(400, "Reopen the later months first");
  await client`
    UPDATE accounting_periods SET status = 'open', reopened_at = now(), reopened_by = ${staffId} WHERE period = ${period}`;
  return periods(today);
}

module.exports = { proposal, current, post, periods, close, reopen };
