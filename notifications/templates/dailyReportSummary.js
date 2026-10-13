/**
 * The day in words, before any table.
 *
 * ── Why prose, and why it is generated rather than written by a model ──────
 *
 * The report answers "what were the numbers". It did not answer "how was
 * today", and that is the question the person opening it at midnight actually
 * has. Reading six depot tables to work out that Dangote filed nothing is work
 * a report should have already done.
 *
 * These sentences are composed from the same data the tables are rendered
 * from — deterministically, with no model in the loop. That is deliberate for
 * a document about money: a summary that occasionally invents a figure is
 * worse than no summary, it costs nothing to run, it cannot fail at 23:50, and
 * two people reading the same day always see the same words.
 *
 * ── House style ───────────────────────────────────────────────────────────
 *
 * One statement per paragraph, not a packed block — the summary is skimmed
 * standing up, and a reader looking for the confirmed figure should find it on
 * its own line rather than three clauses into a paragraph about depots.
 *
 * Plain reporting register: "were received", "recorded the highest sales",
 * "increased by 36% compared with". And "litres" lower-case in prose, though
 * the table columns capitalise it — a sentence is not a column heading.
 *
 * REMARKS are keyed by depot, one line each, in the form
 *
 *     DANGOTE REFINERY: No report was submitted today.
 *
 * because every remark is about a specific site and somebody has to act on it
 * there. A count ("1 depot filed nothing") names nobody to call.
 */

const n0 = (v) => Number(v || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });
const naira = (v) => `₦${n0(v)}`;
/** Lower-case in prose. The tables spell it "Litres"; a sentence does not. */
const litres = (v) => `${n0(v)} litres`;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const plural = (c, s, p = `${s}s`) => `${n0(c)} ${Number(c) === 1 ? s : p}`;

// ─── The statements, one per paragraph ──────────────────────────────────────

/** "29 orders were received today, totaling … across 6 depots." */
function ordersStatement(d) {
  const t = d.totals || {};
  const trading = (d.locations || []).filter((l) => l.orderCount > 0);

  if (!t.orderCount) return "No orders were received today.";

  const verb = Number(t.orderCount) === 1 ? "was" : "were";
  return (
    `${plural(t.orderCount, "order")} ${verb} received today, totaling ${litres(t.qtyLitres)} ` +
    `with a total value of ${naira(t.amountNaira)}, across ${plural(trading.length, "depot")}.`
  );
}

/** "LIQUID BULK DEPOT recorded the highest sales for the day at ₦…" */
function busiestStatement(d) {
  const trading = (d.locations || []).filter((l) => l.orderCount > 0);
  if (trading.length < 2) return null;
  const top = [...trading].sort((a, b) => b.orderValue - a.orderValue)[0];
  if (!top || top.orderValue <= 0) return null;
  return `${top.name} recorded the highest sales for the day at ${naira(top.orderValue)}.`;
}

/** "Total revenue increased by 36% compared with yesterday's ₦…" */
function comparisonStatement(d) {
  const t = d.totals || {};
  const yesterday = (d.history || [])[0];
  if (!t.amountNaira || !yesterday || !yesterday.amountNaira) return null;

  const ratio = t.amountNaira / yesterday.amountNaira;
  const was = naira(yesterday.amountNaira);
  if (ratio >= 0.95 && ratio <= 1.05) {
    return `Total revenue was largely unchanged compared with yesterday's ${was}.`;
  }
  const change = Math.round(Math.abs(ratio - 1) * 100);
  const direction = ratio > 1 ? "increased" : "decreased";
  return `Total revenue ${direction} by ${change}% compared with yesterday's ${was}.`;
}

/** "Total stock opened at …, with … sold today, leaving a closing stock of …" */
function stockStatement(d) {
  const t = d.totals || {};
  if (!t.openingStock && !t.closingStock) return null;

  // The stock movement, not the ordered quantity: these differ when an order is
  // placed against a batch that has not moved, and the sentence is about the
  // tank rather than the order book.
  const moved = t.openingStock - t.closingStock;
  // Stock moved to a trucking PFI left the tank too, but was not sold.
  const trucked = Math.min(Math.max(0, t.truckedQty || 0), Math.max(0, moved));
  if (moved > 0 && trucked > 0) {
    return (
      `Total stock opened at ${litres(t.openingStock)}, with ${litres(moved - trucked)} sold today ` +
      `and ${litres(trucked)} trucked out, leaving a closing stock of ${litres(t.closingStock)}.`
    );
  }
  if (moved > 0) {
    return (
      `Total stock opened at ${litres(t.openingStock)}, with ${litres(moved)} sold today, ` +
      `leaving a closing stock of ${litres(t.closingStock)}.`
    );
  }
  if (moved < 0) {
    return (
      `Total stock opened at ${litres(t.openingStock)}, with ${litres(-moved)} received today, ` +
      `bringing closing stock to ${litres(t.closingStock)}.`
    );
  }
  return `Total stock was unchanged today at ${litres(t.closingStock)}.`;
}

/** "Of today's total sales of ₦…, ₦… (79%) has been confirmed, while …" */
function confirmationStatement(d) {
  const t = d.totals || {};
  if (!t.amountNaira) return null;

  const confirmed = t.confirmedValue || 0;
  const outstanding = t.amountNaira - confirmed;

  if (confirmed <= 0) {
    return `None of today's total sales of ${naira(t.amountNaira)} has been confirmed yet.`;
  }
  if (outstanding <= 0) {
    return `All of today's total sales of ${naira(t.amountNaira)} has been confirmed.`;
  }
  return (
    `Of today's total sales of ${naira(t.amountNaira)}, ${naira(confirmed)} ` +
    `(${pct(confirmed, t.amountNaira)}%) has been confirmed, while ${naira(outstanding)} ` +
    `(${pct(outstanding, t.amountNaira)}%) is yet to be confirmed.`
  );
}

// ─── REMARKS, one line per depot ────────────────────────────────────────────

/**
 * @returns {Array<{depot: string, note: string}>}
 */
function buildRemarks(d) {
  const locations = d.locations || [];
  // Several findings about one depot become one line, so a site appears once.
  const byDepot = new Map();
  const add = (depot, note) => {
    if (!byDepot.has(depot)) byDepot.set(depot, []);
    byDepot.get(depot).push(note);
  };

  for (const loc of locations) {
    const filed = (loc.staffEntries || []).reduce((n, s) => n + s.entries.length, 0);

    // Only a depot that filed NOTHING is remarked on.
    //
    // A partial count used to be reported too — "Only 3 of 5 reports were
    // submitted" — and on a real day that was five of the six lines here,
    // burying the one depot that had filed nothing at all. Most depots file
    // some but not all of their five sheets most days, so the partial count
    // was a permanent condition rather than an exception, and a REMARKS block
    // full of permanent conditions is one people stop reading. The per-role
    // detail is still in the Staff entries tables, where a role nobody filed
    // says so on its own line.
    if (filed === 0) {
      add(loc.name, "No report was submitted today.");
    }

    if (loc.orderCount === 0 && loc.stock && loc.stock.closing > 0) {
      add(loc.name, "No orders were recorded, though stock is available.");
    }

    for (const pfi of loc.pfiStock || []) {
      if (pfi.openingStock > 0 && pfi.closingStock / pfi.openingStock < 0.1) {
        add(loc.name, `${pfi.pfiNumber} is nearly exhausted, with ${litres(pfi.closingStock)} remaining.`);
      }
    }
  }

  return [...byDepot.entries()].map(([depot, notes]) => ({ depot, note: notes.join(" ") }));
}

// ─── Assembly ───────────────────────────────────────────────────────────────

/**
 * @returns {{paragraphs: string[], remarks: Array<{depot, note}>}}
 */
function buildDailySummary(d) {
  const paragraphs = [
    ordersStatement(d),
    busiestStatement(d),
    comparisonStatement(d),
    stockStatement(d),
    confirmationStatement(d),
  ].filter(Boolean);

  return { paragraphs, remarks: buildRemarks(d) };
}

/** The same summary as plain text, for the email's text part. */
function summaryText(d) {
  const { paragraphs, remarks } = buildDailySummary(d);
  const out = paragraphs.join("\n\n");
  if (remarks.length === 0) return out;
  return `${out}\n\nREMARKS\n${remarks.map((r) => `${r.depot}: ${r.note}`).join("\n")}`;
}

module.exports = { buildDailySummary, summaryText, buildRemarks };
