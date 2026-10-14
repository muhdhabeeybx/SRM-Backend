const crypto = require("crypto");
const { db, client } = require("../../db");
const { ensureBankAccounts } = require("../../lib/accounting/chart");
const SOURCES = require("../../lib/accounting/postingSources");

/**
 * The posting engine: fills the general ledger from the desks' own records.
 *
 * ── What it does on each run ──────────────────────────────────────────────
 *
 * Every source (lib/accounting/postingSources) lists its records and the
 * lines each should book. For each record the engine compares those lines with
 * the ones it booked last time (ledger_postings) and books the difference:
 *
 *   new record        its lines, as one entry
 *   changed record    an adjustment entry with only what moved — a payment
 *                     removed, an order repriced, an expense re-dated
 *   record gone       its lines taken back
 *   unchanged         nothing
 *
 * Nothing already in the journal is touched; the database refuses that
 * anyway (0082). So re-running is always safe, and two runs in a row book
 * nothing the second time.
 *
 * ── Dates ─────────────────────────────────────────────────────────────────
 *
 * An entry is dated by its record. A record from before the books started
 * (accounting_settings.books_start) is noted with no entry — the opening
 * balance carries it — and only a later change to it is booked. Anything that
 * would land in a closed month, or before the books started, is booked on the
 * first open day instead and marked late, with the day it belongs to kept.
 */

const SCALE = 100;
const toKobo = (v) => Math.round((Number(v) || 0) * SCALE);
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

/** The setting, or its default. */
async function settings(tx = client) {
  const rows = await tx`SELECT key, value FROM accounting_settings`;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { booksStart: map.books_start || "2026-09-01", purchaseVat: map.purchase_vat || "cost" };
}

/** The first day nothing stops an entry being booked on: the books' start, after any closed month. */
async function firstOpenDay(booksStart, tx = client) {
  const closed = new Set((await tx`SELECT period FROM accounting_periods WHERE status = 'closed'`).map((r) => r.period));
  let [y, m] = booksStart.slice(0, 7).split("-").map(Number);
  let day = booksStart;
  while (closed.has(`${y}-${String(m).padStart(2, "0")}`)) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    day = `${y}-${String(m).padStart(2, "0")}-01`;
  }
  return day;
}

/**
 * A record's lines as the engine stores and compares them: an account id, a
 * signed amount in kobo (debit positive), the day, and what the line is
 * about. Lines that say the same thing are added together; nought is dropped.
 */
/** Everything that makes two lines different lines. */
const lineKey = (l) =>
  [l.d, l.a, l.p, l.i, l.f, l.b, l.u, l.lt, l.li].map((v) => (v === undefined ? null : v)).join("|");

function normalize(record, accountOf) {
  const byKey = new Map();
  for (const l of record.lines) {
    const amount = toKobo(l.debit) - toKobo(l.credit);
    if (amount === 0) continue;
    const a = l.accountId ?? accountOf(l.key);
    // What the line is about: its own, else the record's.
    const pfi = l.pfiId !== undefined ? l.pfiId : record.pfiId;
    const where = l.location !== undefined ? l.location : record.location;
    const line = {
      d: record.date,
      a,
      p: l.party ? l.party[0] : null,
      i: l.party ? l.party[1] : null,
      f: pfi == null ? null : Number(pfi),
      b: l.bankAccountId ?? null,
      u: (l.unit !== undefined ? l.unit : record.unit) || null,
      lt: where ? where[0] : null,
      li: where ? Number(where[1]) : null,
    };
    const k = lineKey(line);
    const had = byKey.get(k);
    if (had) had.k += amount;
    else byKey.set(k, { ...line, k: amount });
  }
  const lines = [...byKey.values()].filter((l) => l.k !== 0);
  lines.sort((x, y) => lineKey(x).localeCompare(lineKey(y)));
  const total = lines.reduce((n, l) => n + l.k, 0);
  if (total !== 0) {
    throw new Error(`${record.id}: its lines do not balance (off by ₦${(total / SCALE).toFixed(2)})`);
  }
  return lines;
}

/** The money in a line, without what it is about. */
const moneyKey = (l) => [l.d, l.a, l.p, l.i, l.b].map((v) => (v === undefined ? null : v)).join("|");

/**
 * new − old, line by line, as lines of their own.
 *
 * A line dated before the books started was never booked — the opening
 * balance carries it — so only a change in its money is anything to book.
 * Its PFI, unit or place changing on its own moves nothing: compared on the
 * money alone, and the difference takes what it is about from the record as
 * it stands now. Otherwise re-tagging September's sales would book them
 * again in October under their new unit.
 */
function difference(oldLines, newLines, booksStart = null) {
  const opening = (l) => booksStart && l.d < booksStart;
  const keyOf = (l) => (opening(l) ? moneyKey(l) : lineKey(l));
  const byKey = new Map();
  const add = (l, sign) => {
    const k = keyOf(l);
    const had = byKey.get(k);
    if (had) had.k += sign * l.k;
    else byKey.set(k, { ...l, k: sign * l.k });
  };
  for (const l of oldLines) add(l, -1);
  for (const l of newLines) add(l, +1);
  // Where an opening line's money moved, say what it is about as it is now.
  const now = new Map(newLines.filter(opening).map((l) => [moneyKey(l), l]));
  return [...byKey.values()]
    .filter((l) => l.k !== 0)
    .map((l) => {
      const cur = opening(l) ? now.get(moneyKey(l)) : null;
      return cur ? { ...l, f: cur.f, u: cur.u, lt: cur.lt, li: cur.li } : l;
    });
}

/**
 * The part of a difference to book. Before the opening entry is posted,
 * lines dated before the books started are left to it (see runUnlocked).
 */
function bookable(delta, booksStart, openingPosted) {
  return openingPosted ? delta : delta.filter((l) => l.d >= booksStart);
}

/** Book one set of difference lines: one entry per day they come to rest on. */
async function book(tx, { type, record, delta, isNew, openDay }) {
  const byDay = new Map();
  for (const l of delta) {
    const day = l.d < openDay ? openDay : l.d;
    if (!byDay.has(day)) byDay.set(day, { original: l.d, lines: [] });
    byDay.get(day).lines.push(l);
  }
  let last = null;
  for (const [day, { original, lines }] of byDay) {
    const late = day !== original;
    const memo = isNew ? record.memo : `${record.memo} — changed`;
    const [entry] = await tx`
      INSERT INTO journal_entries (entry_date, kind, source_type, source_id, memo, original_date, is_late)
      VALUES (${day}, ${isNew ? "auto" : "adjustment"}, ${type}, ${record.id}, ${memo},
              ${late ? original : null}, ${late})
      RETURNING id`;
    await tx`
      INSERT INTO journal_lines ${tx(lines.map((l) => ({
        entry_id: entry.id,
        account_id: l.a,
        debit: l.k > 0 ? (l.k / SCALE).toFixed(2) : "0",
        credit: l.k < 0 ? (-l.k / SCALE).toFixed(2) : "0",
        party_type: l.p ?? null,
        party_id: l.i ?? null,
        pfi_id: l.f ?? null,
        bank_account_id: l.b ?? null,
        unit: l.u ?? null,
        location_type: l.lt ?? null,
        location_id: l.li ?? null,
      })))}`;
    last = entry.id;
  }
  return last;
}

/**
 * One run over every source, or the ones named.
 *
 * @param {{ only?: string[], dryRun?: boolean, log?: (s: string) => void }} opts
 * @returns per source: records read, booked new, adjusted, taken back, noted
 *          as before the books started, unchanged, and any that failed.
 */
/** One run at a time, across every server process: the schedule and "Post now" never overlap. */
const LOCK = 7_340_081;

async function run(opts = {}) {
  const conn = await client.reserve();
  try {
    const [{ got }] = await conn`SELECT pg_try_advisory_lock(${LOCK}) AS got`;
    if (!got) return { busy: true };
    try {
      return await runUnlocked(opts);
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK})`;
    }
  } finally {
    conn.release();
  }
}

async function runUnlocked({ only = null, dryRun = false, log = () => {} } = {}) {
  await ensureBankAccounts();
  const { booksStart } = await settings();
  const openDay = await firstOpenDay(booksStart);
  // Until the opening entry is posted, history before the books started is
  // the opening's to carry: it is worked out from ledger_postings as they
  // stand when it is posted (opening.service). A change to that history now
  // is noted there and booked nowhere — booked as well, on the first open
  // day, the opening would count it a second time.
  const openingPosted = (await client`
    SELECT 1 FROM journal_entries o
     WHERE o.kind = 'opening'
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = o.id)
     LIMIT 1`).length > 0;
  // Bank lines nothing has claimed — transfers between our accounts, the
  // withdrawals that paid expenses and refunds, charges, cargo payments —
  // recognised first, so the sources below book them as what they were.
  if (!dryRun) {
    const recognised = await require("./bankMatching.service").recognise({ booksStart });
    if (Object.keys(recognised).length) log(`bank lines recognised: ${JSON.stringify(recognised)}`);
  }

  const chart = await client`SELECT id, system_key FROM expense_categories WHERE system_key IS NOT NULL`;
  const ids = new Map(chart.map((r) => [r.system_key, Number(r.id)]));
  const accountOf = (key) => {
    const id = ids.get(key);
    if (!id) throw new Error(`No account in the chart for "${key}" — has migration 0081 run?`);
    return id;
  };

  const summary = {};
  // Shared by the sources within this run, so what one reads another reuses.
  const ctx = {};
  for (const source of SOURCES) {
    if (only && !only.includes(source.type)) continue;
    const s = { read: 0, booked: 0, adjusted: 0, takenBack: 0, opening: 0, unchanged: 0, failed: [] };
    summary[source.type] = s;

    const records = await source.load(db, ctx);
    s.read = records.length;
    const posted = new Map(
      (await client`SELECT source_id, lines, fingerprint FROM ledger_postings WHERE source_type = ${source.type}`)
        .map((r) => [r.source_id, r]),
    );

    // Gone since the last run: an empty record takes its lines back.
    const seen = new Set(records.map((r) => r.id));
    for (const [id, prev] of posted) {
      if (!seen.has(id) && Array.isArray(prev.lines) && prev.lines.length) {
        records.push({ id, date: prev.lines[0].d, memo: `${source.type} ${id} no longer stands`, lines: [], gone: true });
      }
    }

    // In batches, one transaction each; a batch that fails is retried one
    // record at a time so a single bad record cannot hold up the rest.
    const work = [];
    for (const record of records) {
      let lines;
      try {
        lines = normalize(record, accountOf);
      } catch (err) {
        s.failed.push({ id: record.id, error: err.message });
        continue;
      }
      const fingerprint = lines.length ? sha1(JSON.stringify(lines)) : "";
      const prev = posted.get(record.id);
      if (prev && prev.fingerprint === fingerprint) { s.unchanged += 1; continue; }
      if (!prev && !lines.length) { s.unchanged += 1; continue; }
      work.push({ record, lines, fingerprint, prev });
    }

    const apply = async (tx, w) => {
      const { record, lines, fingerprint, prev } = w;
      const before = prev?.lines || [];
      let entryId = null;
      let outcome;
      if (!prev && record.date < booksStart) {
        outcome = "opening";
      } else {
        const delta = bookable(difference(before, lines, booksStart), booksStart, openingPosted);
        if (delta.length) {
          entryId = await book(tx, { type: source.type, record, delta, isNew: !prev, openDay });
        }
        outcome = record.gone ? "takenBack" : prev ? "adjusted" : "booked";
      }
      await tx`
        INSERT INTO ledger_postings (source_type, source_id, lines, fingerprint, last_entry_id, updated_at)
        VALUES (${source.type}, ${record.id}, ${JSON.stringify(lines)}::jsonb, ${fingerprint}, ${entryId}, now())
        ON CONFLICT (source_type, source_id) DO UPDATE
          SET lines = EXCLUDED.lines, fingerprint = EXCLUDED.fingerprint,
              last_entry_id = COALESCE(EXCLUDED.last_entry_id, ledger_postings.last_entry_id),
              updated_at = now()`;
      return outcome;
    };

    if (dryRun) {
      for (const w of work) {
        if (!w.prev && w.record.date < booksStart) s.opening += 1;
        else if (w.record.gone) s.takenBack += 1;
        else if (w.prev) s.adjusted += 1;
        else s.booked += 1;
      }
      continue;
    }

    const BATCH = 300;
    for (let i = 0; i < work.length; i += BATCH) {
      const batch = work.slice(i, i + BATCH);
      try {
        const outcomes = await client.begin(async (tx) => {
          const out = [];
          for (const w of batch) out.push(await apply(tx, w));
          return out;
        });
        for (const o of outcomes) s[o] += 1;
      } catch {
        for (const w of batch) {
          try {
            s[await client.begin((tx) => apply(tx, w))] += 1;
          } catch (err) {
            s.failed.push({ id: w.record.id, error: err.message });
          }
        }
      }
      log(`${source.type}: ${Math.min(i + BATCH, work.length)}/${work.length}`);
    }
  }
  return { booksStart, openDay, sources: summary };
}

module.exports = { run, settings, firstOpenDay, normalize, difference, bookable };
