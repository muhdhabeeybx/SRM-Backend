const { client } = require("../../db");
const { settings } = require("./posting.service");

/**
 * How long money has been owed — to Soroman (receivables) or by it
 * (payables) — party by party, in four groups: 0–30, 31–60, 61–90 and over
 * 90 days. For Finance on the Accounts pages only (the owner's choice, 14 Oct
 * 2026); the Delivery Customers page keeps its days owing and no groups.
 *
 * ── How a balance is aged ─────────────────────────────────────────────────
 *
 * Each party's charges and payments in date order, the payments taken off
 * the oldest charges first. What is left of each charge is aged from its own
 * day. A party who has paid more than they were charged is "paid ahead" —
 * money of theirs we hold, or money we have paid a vendor in advance — and is
 * shown apart, never netted into the groups.
 *
 * The history before the books started is read at its own dates (what the
 * posting engine noted for each record, ledger_postings), not as the opening
 * entry's single day, so a debt from August reads as old as it is. The
 * opening entry is left out, being the same money summed (and so is any
 * reversal of an earlier opening entry), and so are late
 * changes to those records: the history is already read as it stands now.
 * Every party's total therefore equals its control account to the kobo.
 */

const RECEIVABLES = [
  { key: "customer_receivables", label: "Depot customer" },
  { key: "trucking_receivables", label: "Trucking customer" },
  { key: "station_takings", label: "Filling station" },
  { key: "plant_takings", label: "LPG plant" },
];
const PAYABLES = [
  { key: "vendor_payables", label: "Vendor" },
  { key: "supplier_payables", label: "Cargo supplier" },
];
const BUCKETS = [30, 60, 90];

const money = (k) => Math.round(k) / 100;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * @param {{ side: 'receivables'|'payables', at: string }} p  `at` is a Lagos day
 */
async function ageing({ side = "receivables", at }) {
  const { booksStart } = await settings();
  const kinds = side === "payables" ? PAYABLES : RECEIVABLES;
  const accounts = await client`
    SELECT id, system_key FROM expense_categories WHERE system_key = ANY(${kinds.map((k) => k.key)})`;
  const ids = accounts.map((a) => Number(a.id));
  const kindOf = new Map(accounts.map((a) => [Number(a.id), kinds.find((k) => k.key === a.system_key)]));
  // Receivables grow on the debit side, payables on the credit side.
  const sign = side === "payables" ? -1 : 1;

  const posted = await client`
    SELECT l.account_id, l.party_type, l.party_id, e.entry_date::text AS day,
           ROUND((l.debit - l.credit) * 100)::bigint AS k
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ANY(${ids}::int[]) AND e.entry_date <= ${at}::date
       -- The opening entry, and late changes to records from before the books
       -- started, are the history below already — at its own dates, as it
       -- stands now. Counting them as well would count that money twice.
       AND e.kind <> 'opening'
       AND NOT (e.kind = 'reversal' AND EXISTS (
             SELECT 1 FROM journal_entries o WHERE o.id = e.reverses_entry_id AND o.kind = 'opening'))
       AND NOT (e.original_date IS NOT NULL AND e.original_date < ${booksStart}::date)`;
  const before = await client`
    SELECT (l->>'a')::int AS account_id, l->>'p' AS party_type, (l->>'i')::int AS party_id,
           l->>'d' AS day, (l->>'k')::bigint AS k
      FROM ledger_postings lp, jsonb_array_elements(lp.lines) l
     WHERE (l->>'a')::int = ANY(${ids}::int[]) AND l->>'d' < ${booksStart} AND l->>'d' <= ${at}`;

  const parties = new Map();
  for (const r of [...before, ...posted]) {
    const key = `${r.account_id}|${r.party_type || ""}|${r.party_id ?? ""}`;
    if (!parties.has(key)) {
      parties.set(key, { accountId: Number(r.account_id), partyType: r.party_type || null, partyId: r.party_id == null ? null : Number(r.party_id), lines: [] });
    }
    parties.get(key).lines.push({ day: r.day, k: sign * Number(r.k) });
  }

  const rows = [];
  for (const p of parties.values()) {
    p.lines.sort((a, b) => a.day.localeCompare(b.day));
    // Charges in order; each payment takes off the oldest first.
    const open = [];
    let ahead = 0;
    for (const l of p.lines) {
      if (l.k > 0) {
        let k = l.k;
        // Money paid ahead earlier covers this charge first.
        const use = Math.min(ahead, k);
        ahead -= use;
        k -= use;
        if (k > 0) open.push({ day: l.day, k });
      } else {
        let pay = -l.k;
        while (pay > 0 && open.length) {
          const take = Math.min(open[0].k, pay);
          open[0].k -= take;
          pay -= take;
          if (open[0].k === 0) open.shift();
        }
        ahead += pay;
      }
    }
    const groups = [0, 0, 0, 0];
    for (const o of open) {
      const days = daysBetween(o.day, at);
      groups[days <= BUCKETS[0] ? 0 : days <= BUCKETS[1] ? 1 : days <= BUCKETS[2] ? 2 : 3] += o.k;
    }
    const owed = groups.reduce((t, g) => t + g, 0);
    if (owed === 0 && ahead === 0) continue;
    rows.push({
      accountId: p.accountId,
      // Which book: a station's or plant's takings open its own page.
      accountKey: kindOf.get(p.accountId)?.key || null,
      kind: kindOf.get(p.accountId)?.label || "",
      partyType: p.partyType,
      partyId: p.partyId,
      owed: money(owed),
      groups: groups.map(money),
      paidAhead: money(ahead),
      oldestDay: open[0]?.day ?? null,
      oldestDays: open[0] ? daysBetween(open[0].day, at) : null,
    });
  }

  // Names.
  const named = async (type, table) => {
    const want = rows.filter((r) => r.partyType === type).map((r) => r.partyId);
    if (!want.length) return new Map();
    const res = await client`SELECT id, name FROM ${client(table)} WHERE id = ANY(${want}::int[])`;
    return new Map(res.map((x) => [Number(x.id), x.name]));
  };
  const names = {
    customer: await named("customer", "customers"),
    delivery_customer: await named("delivery_customer", "delivery_customers"),
    vendor: await named("vendor", "vendors"),
  };
  for (const r of rows) {
    r.name = r.partyType ? names[r.partyType]?.get(r.partyId) || `#${r.partyId}` : "Not named on the record";
  }
  rows.sort((a, b) => b.owed - a.owed || b.paidAhead - a.paidAhead);

  const sum = (f) => Math.round(rows.reduce((t, r) => t + f(r) * 100, 0)) / 100;
  return {
    side,
    at,
    groups: ["0–30 days", "31–60 days", "61–90 days", "Over 90 days"],
    rows,
    totals: {
      owed: sum((r) => r.owed),
      groups: [0, 1, 2, 3].map((i) => sum((r) => r.groups[i])),
      paidAhead: sum((r) => r.paidAhead),
    },
  };
}

module.exports = { ageing };
