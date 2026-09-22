const { escapeHtml } = require("./email");
const {
  INK, MUTED, TINT, FONT_STACK,
  TABLE, KEY_S, CREDIT_S, BALANCE_S,
  cell, hcell, m, n0, ordinalDate,
} = require("./reportTable");

const {
  qty,
  FORMATTERS, NUMERIC_FORMATS,
  ROLE_FIELDS,
  HAS_PRICE_BANDS, HAS_TOP_CUSTOMERS,
} = require("./roleFields");

/**
 * The Soroman Sales & Operations Report.
 *
 * `buildPfiDailyReportData` (services/pfiDailyReport.service.js) supplies `d`;
 * this file only renders it. Bare markup, every style inline, no
 * <html>/<head>/<body> wrapper, because mail clients strip <style> blocks and
 * Gmail ignores classes — the constraint the original Django port was written
 * under, and it has not changed.
 *
 * ── Tables, not sections ──────────────────────────────────────────────────
 *
 * One table per fact, one row per batch, so the reader compares down a column.
 * Ten sections would mean scrolling past nine to compare two, and comparison
 * is the whole reason the report gets opened: which batch moved, which is owed
 * on, which is nearly out.
 *
 * ── Wording ───────────────────────────────────────────────────────────────
 *
 * The labels are the dashboard's own: SALES VALUE, AMOUNT RECEIVED, BALANCE,
 * OPENING STOCK, COMMISSION DUE. Not "collected", not "outstanding". A report
 * that renames the things it reports makes the reader translate before they
 * can read, and eventually they translate one of them wrong.
 *
 * ── Units belong to the batch ─────────────────────────────────────────────
 *
 * Every quantity is printed with ITS OWN batch's unit, never a hard-coded "L".
 * Two of the live batches are LPG and trade in kilograms; printing 160,000 kg
 * of gas as "160,000 L" is not a formatting slip, it is a wrong number on a
 * report people trade on. `pfis.product_unit` is the authority and roleFields
 * normalises its three spellings.
 */

const up = (v) => String(v == null ? "" : v).toUpperCase();

/** The tint that anchors a row, as the options the cell helpers take. */
const KEY = { s: KEY_S, bg: TINT };

/**
 * The vertical rhythm, as four numbers rather than a dozen literals.
 *
 * Spacing was the last thing carrying hierarchy once colour had been reserved
 * for meaning and the section bars were told apart by weight — and it had
 * drifted into eight different values that no longer said anything. These are
 * a scale: a new SECTION gets roughly twice the air a GROUP inside one does,
 * and a heading sits closer to the table it introduces than to the table above
 * it. That last relationship is the one doing the work — it is what makes a
 * heading read as belonging to what follows it.
 *
 * Spacers are `<td>`-height divs rather than margins: Outlook drops margins on
 * a div, and two sections would run together in exactly the client least able
 * to cope with it.
 */
const GAP = { section: 32, group: 18, afterSectionBar: 8, afterGroupBar: 5 };

/** A fixed vertical gap that survives Outlook. */
const space = (px) => `<div style="height:${px}px;line-height:${px}px;">&nbsp;</div>`;

/**
 * Satoshi, where the client will have it.
 *
 * Mail clients do not download web fonts with any reliability — Gmail strips
 * @import, Outlook ignores @font-face outright — so this is a preference, not
 * a guarantee, and the stack behind it is what most readers will actually see.
 * The <style> block is worth the 120 bytes for the clients that do honour it
 * (Apple Mail, Thunderbird, Gmail's web client), and costs nothing where it is
 * dropped. What matters is that the fallbacks are a deliberate choice rather
 * than whatever the client defaults to: -apple-system and Segoe UI are the
 * two faces that ship on the devices this is read on.
 */
const FONT = FONT_STACK;

/**
 * The one <style> block, and everything in it is an IMPROVEMENT rather than a
 * requirement.
 *
 * Gmail strips @import, Outlook ignores @font-face, and several clients drop
 * embedded <style> entirely — so every rule here has an inline equivalent
 * already doing the job, and the document has to read correctly with this
 * block deleted. It is not where the report is styled; it is where the report
 * is made nicer on the clients that allow it.
 *
 * What it buys, in order of how much it matters on a phone:
 *
 *   NOWRAP ON FIGURES  "₦1,220,979,873" breaking across two lines mid-number
 *     is the single worst thing that happens to this report on a narrow
 *     screen — the eye reads "₦1,220" and stops. Right-aligned cells are
 *     exactly the numeric ones, so the selector needs no markup of its own.
 *     Inline it would cost ~20 bytes on every one of ~600 cells; here it costs
 *     45 bytes once, which is the only reason it is affordable at all.
 *
 *   TIGHTER CELLS UNDER 600px  `cellpadding="6"` is an attribute and cannot be
 *     conditional, so the media query overrides it. Two pixels a side across
 *     nine columns is most of a column back.
 *
 *   THE SECTION NOTE STEPS ASIDE  "raised or paid today" is floated right of
 *     its heading. There is room for it on a laptop and there is not on a
 *     phone, where it wraps under the heading and doubles the bar's height on
 *     every section. It is an aside; it goes.
 *
 * Mobile mail clients that report a desktop viewport will not match the media
 * query at all. That is why the layout does not depend on it: the tables scroll
 * inside their own wrappers either way, and `max-width` lets the document
 * shrink to whatever width it is actually given.
 */
const FONT_LINK =
  `<style>` +
  `@import url('https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap');` +
  `table,td,th,p,div,span{font-family:${FONT};}` +
  `td[align=right],th[align=right]{white-space:nowrap;}` +
  `@media only screen and (max-width:600px){` +
  // Scoped to the DATA tables by their border attribute. A bare `td,th` also
  // catches the section bars, which are single-cell tables — shrinking a
  // heading to 11px and stripping its padding turns the one piece of structure
  // the report has into another line of small text.
  `table[border="1"] td,table[border="1"] th{padding:4px 5px!important;font-size:11px!important;}` +
  `.rpt-note{display:none!important;}` +
  `.rpt-title{font-size:19px!important;}` +
  `}` +
  `</style>`;

// ─── Section furniture ──────────────────────────────────────────────────────

/**
 * Telling the sections apart by WEIGHT, not by hue.
 *
 * Colour in this document already means something — green is money in, red is
 * what is still owed or still standing — and giving each section its own
 * colour would spend that meaning on decoration, making the figures harder to
 * read again. So the levels are told apart by weight:
 *
 *   section   a solid black bar, white type, full width — unmissable
 *   group     a grey band with a black left rule — clearly subordinate
 *
 * Both are single-cell tables rather than styled divs, because Outlook drops
 * `background` on a div and would render a bar as bare text on white.
 */
/** Grey enough to sit quietly on black; MUTED would disappear into it. */
const NOTE_ON_INK = "#BDBDBD";

/**
 * The note sits at the right-hand end of the bar, in the bar's own weight
 * undone: not bold, not uppercase, not tracked out. It is an aside about the
 * section, and it has to read as one or it competes with the heading.
 */
const barNote = (note, color) =>
  note
    ? `<span class="rpt-note" style="float:right;font-weight:400;letter-spacing:0;` +
      `text-transform:none;color:${color};font-size:11px;padding-left:12px;">${escapeHtml(note)}</span>`
    : "";

const bar = (label, note, { bg, color, size, noteColor, extra = "" }) =>
  `<table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>` +
  `<td bgcolor="${bg}" style="color:${color};padding:8px 11px;font-size:${size}px;font-weight:700;` +
  `text-transform:uppercase;letter-spacing:.7px;font-family:${FONT};${extra}">` +
  `${escapeHtml(up(label))}${barNote(note, noteColor)}</td>` +
  `</tr></table>`;

const section = (label, note = "") =>
  `<div style="margin-top:${GAP.section}px;">` +
  bar(label, note, { bg: INK, color: "#ffffff", size: 13, noteColor: NOTE_ON_INK }) +
  space(GAP.afterSectionBar);

/** A PFI inside FILLING STATIONS, a desk inside STAFF REPORTS. */
const group = (label, note = "") =>
  `<div style="margin-top:${GAP.group}px;">` +
  bar(label, note, {
    bg: "#EDEDED", color: INK, size: 11, noteColor: MUTED,
    extra: `border-left:4px solid ${INK};`,
  }) +
  space(GAP.afterGroupBar);

/**
 * An empty section, in one line — and the `</div>` its heading opened.
 *
 * The closing tag lives here rather than at the call site because `section`
 * and `group` open a div and `table` is the only thing that ever follows them;
 * both of `table`'s branches have to close it or every later section nests one
 * level deeper. See `table` below.
 */
const nothing = (text) =>
  `<p style="margin:2px 0 0;color:${MUTED};font-size:12px;font-family:${FONT};">${escapeHtml(text)}</p></div>`;

// ─── Cells ──────────────────────────────────────────────────────────────────

/** A count that prints 0 as an em-dash — a zero truck count is not news. */
const c0 = (v) => (Number(v || 0) === 0 ? "—" : n0(v));

/** A quantity that prints 0 as an em-dash, in the batch's own unit. */
const q0 = (v, unit) => (Number(v || 0) === 0 ? "—" : qty(v, unit));

/** A figure the data cannot support. Never a zero, never a negative. */
const UNKNOWN = `<span style="color:${MUTED};">N/A</span>`;

const MUTED_S = `color:${MUTED};`;

/** Green only when there is something there: a green em-dash reads as money. */
const credit = (html) => ({ r: true, s: html === "—" ? "" : CREDIT_S });
const balance = (html) => ({ r: true, s: html === "—" ? "" : BALANCE_S });

const headRow = (labels) => `<tr>${labels.map((l, i) => hcell(up(l), { r: i > 0 })).join("")}</tr>`;

/**
 * Closes the section or group `div` its heading opened, on BOTH branches.
 *
 * A table that rendered nothing used to return an empty string, leaving that
 * div open — which in a mail client means every section after it nests one
 * level deeper and the margins compound down the page. An empty section says
 * so in a line instead.
 */
const table = (labels, rows, empty = "Nothing to report.") =>
  rows.length
    ? `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px;">` +
      `${TABLE}<thead>${headRow(labels)}</thead><tbody>${rows.join("")}</tbody></table></div></div>`
    : nothing(empty);

/** The row label column: uppercase, tinted, bold. Every table opens with one. */
const idCell = (text) => cell(`<strong>${escapeHtml(up(text))}</strong>`, KEY);

/** A stock figure, tinted so the eye finds the two ends of the day's movement. */
const stockCell = (html) => cell(html, { ...KEY, r: true });

// ─── Depot sales ────────────────────────────────────────────────────────────

/**
 * Opening, what moved, closing — with the batch it was bought as either side.
 *
 * INITIAL STOCK is the batch as purchased and never changes; OPENING and
 * CLOSING are today's two ends. Three stock columns rather than two because
 * they answer different questions: "how much of this batch is gone" needs the
 * initial figure, "what happened today" needs the other two. The row reads
 * straight across — opening − sold today = closing.
 */
const depotSales = (pfis) =>
  section("Depot sales", "stock and orders, by PFI") +
  table(
    [
      "PFI", "Location", "Initial stock", "Opening stock today", "Total sold today",
      "Closing stock today", "Sales value today", "Total PFI revenue",
    ],
    pfis.map((p) => {
      const sold = q0(p.stock.soldToday, p.unit);
      const value = m(p.orders.today.value);
      const revenue = m(p.orders.toDate.paid);
      return (
        `<tr>` +
        idCell(p.pfiNumber) +
        cell(escapeHtml(up(p.location)) || "—") +
        // An evacuation surplus is named under the initial figure rather
        // than folded into it: initial is the batch as landed and never
        // changes, and the surplus is why closing can exceed initial − sold.
        stockCell(
          qty(p.stock.starting, p.unit) +
            (p.stock.surplus > 0 ? `<br><span style="font-size:11px">+ ${qty(p.stock.surplus, p.unit)} surplus</span>` : "")
        ) +
        stockCell(qty(p.stock.openingToday, p.unit)) +
        cell(sold, credit(sold)) +
        cell(qty(p.stock.remaining, p.unit), { r: true, s: KEY_S + BALANCE_S, bg: TINT }) +
        cell(value, credit(value)) +
        cell(revenue, credit(revenue)) +
        `</tr>`
      );
    })
  );

// ─── Loading and exit gate ──────────────────────────────────────────────────

/**
 * Loaded and exited are two different events, and both are reported.
 *
 * The volume columns hang off the gantry's `loaded_at`, not off the security
 * barrier: a truck that loads at 18:00 and sleeps in the yard loaded today and
 * exits tomorrow, and a "litres loaded today" measured on the way out reports
 * nothing for it.
 */
const gateReport = (pfis) => {
  const rows = pfis
    .filter((p) => p.movements.trucksToDate > 0)
    .map((p) => {
      const mv = p.movements;
      const loaded = q0(mv.litresLoadedToday, p.unit);
      const total = q0(mv.litresLoadedToDate, p.unit);
      return (
        `<tr>` +
        idCell(p.pfiNumber) +
        cell(escapeHtml(up(p.location)) || "—") +
        cell(loaded, credit(loaded)) +
        cell(c0(mv.enteredToday), { r: true }) +
        cell(c0(mv.exitedToday), { r: true }) +
        cell(c0(mv.onSite), balance(c0(mv.onSite))) +
        cell(c0(mv.trucksLoadedToDate), { r: true }) +
        cell(total, credit(total)) +
        `</tr>`
      );
    });

  if (!rows.length) return "";
  return (
    section("Loading and exit gate report", "across locations") +
    table(
      [
        "PFI", "Location", "Litres loaded today", "Trucks entered today", "Trucks exited today",
        "On site now", "Total trucks loaded", "Total litres loaded",
      ],
      rows
    )
  );
};

// ─── Expenses ───────────────────────────────────────────────────────────────

/**
 * The day first, the running totals after it.
 *
 * This table used to be to-date columns only, listing every batch and category
 * that had ever raised an expense — twenty-four rows of cumulative figures in
 * which the three requests actually raised that day were invisible. A daily
 * report whose expenses section says the same thing every day is a section
 * people stop reading.
 *
 * So a row appears only if something happened on it TODAY — a request raised,
 * or money paid out — and it leads with those two figures. The totals stay on
 * the right, because "what is still owed on this batch" is the question the
 * day's figures prompt and it should not need a second email to answer.
 *
 * General expenses sit in the same table under the batch rows. They are money
 * out like any other, and a separate table would invite the reader to add the
 * two up themselves. Labelled by category, because "General" as one number
 * answers nothing.
 */
const expenseRow = (label, today, toDate) => {
  const unpaid = Math.max(0, toDate.requested - toDate.paid);
  const reqToday = m(today.requested);
  const paidToday = m(today.paid);
  const paid = m(toDate.paid);
  return (
    `<tr>` +
    idCell(label) +
    cell(reqToday, { ...KEY, r: true }) +
    cell(paidToday, { ...credit(paidToday), s: paidToday === "—" ? KEY_S : KEY_S + CREDIT_S, bg: TINT }) +
    cell(m(toDate.requested), { r: true }) +
    cell(paid, credit(paid)) +
    cell(m(unpaid), balance(m(unpaid))) +
    `</tr>`
  );
};

/**
 * `expenseLines` arrives filtered to today's movement and already ordered —
 * see buildPfiDailyReportData. It is the one section whose rows are not the
 * active-batch list: a closed batch that spent money today is on it too, and
 * only the service knows that batch's number.
 */
const expenses = (lines) => {
  const rows = (lines || []).map((l) => expenseRow(l.label, l.today, l.toDate));
  if (!rows.length) return "";
  return (
    section("Expenses", "raised or paid today") +
    table(
      [
        "PFI/Category", "Requested today", "Paid today",
        "Total requested", "Total paid", "Not yet paid",
      ],
      rows
    )
  );
};

// ─── Commissions ────────────────────────────────────────────────────────────

/**
 * What the day's orders earned agents, and what went out against it — then the
 * running totals.
 *
 * The DUE column used to be the to-date outstanding figure sitting under a
 * heading that read like a daily one, so a batch with ₦21m of accumulated
 * arrears and no trading today reported ₦21m "commission due" on a day it
 * earned nobody anything. Today's two figures lead now; the totals follow and
 * are labelled as totals.
 *
 * A batch appears if something happened on it today — product sold, commission
 * earned, or commission settled. A batch that only carries old arrears is not
 * today's news, and its arrears are still on the line the day it next trades.
 *
 * LITRES SOLD TODAY is the batch's own order volume for the day — the figure
 * commission is worked out from — rather than a separate total kept on the
 * commission rows, so the column can be checked against DEPOT SALES above it.
 */
const commissions = (pfis) => {
  const rows = pfis
    .filter(
      (p) =>
        p.orders.today.litres > 0 || p.commission.today.due > 0 || p.commission.today.paid > 0
    )
    .map((p) => {
      const c = p.commission;
      const sold = q0(p.orders.today.litres, p.unit);
      const dueToday = m(c.today.due);
      const paidToday = m(c.today.paid);
      const due = m(c.due);
      const paid = m(c.paid);
      return (
        `<tr>` +
        idCell(p.pfiNumber) +
        cell(escapeHtml(up(p.location)) || "—") +
        cell(sold, { ...credit(sold), s: sold === "—" ? KEY_S : KEY_S + CREDIT_S, bg: TINT }) +
        cell(dueToday, { ...KEY, r: true }) +
        cell(paidToday, { ...credit(paidToday), s: paidToday === "—" ? KEY_S : KEY_S + CREDIT_S, bg: TINT }) +
        cell(due, balance(due)) +
        cell(paid, credit(paid)) +
        `</tr>`
      );
    });
  if (!rows.length) return "";
  return (
    section("Commissions", "earned or settled today") +
    table(
      [
        "PFI", "Location", "Litres sold today", "Commission due today", "Commission paid today",
        "Total still due", "Total paid",
      ],
      rows
    )
  );
};

// ─── Truck sales ────────────────────────────────────────────────────────────

/**
 * The delivery batches, which are a different identity system on purpose.
 *
 * `delivery_sales.allocation_code` ("PFI-14B") and `pfis.pfi_number`
 * ("PFI/43/26/DANGOTE/PMS/3ML/AUG") do not meet — there is no key joining
 * them, and "43B" and "43/26" being the same batch is a business fact, not a
 * string fact. So this half is reported under the code, which is the only
 * identity the data has and the one the desk uses out loud. The hyphen is
 * dropped for reading; nothing else about the code is touched.
 */
const batchLabel = (code) => String(code || "").replace(/^PFI-/i, "PFI ");

const truckSales = (batches) => {
  if (!batches.length) return "";
  return (
    section("Truck sales", "active allocations") +
    table(
      [
        "PFI", "Trucks allocated", "Trucks sold", "Unsold trucks",
        "Total sales value", "Amount received", "Balance to be paid",
      ],
      batches.map((b) => {
        const value = m(b.salesValue);
        const received = m(b.fundsReceived);
        const bal = m(b.balance);
        return (
          `<tr>` +
          idCell(batchLabel(b.code)) +
          // A batch with no allocation rows has an UNKNOWN count, not a zero
          // one: a confident 0 against a batch still selling is a worse answer
          // than an honest blank.
          cell(b.trucksAllocated ? n0(b.trucksAllocated) : UNKNOWN, { r: true }) +
          cell(c0(b.trucksSold), { r: true }) +
          // n0, not c0: in this column a zero means "all of them sold", which
          // is the best news on the row and has to be readable as such. An
          // em-dash here would sit beside the N/A that means "we do not know
          // how many were allocated" and the two would be indistinguishable.
          cell(b.unsoldTrucks === null ? UNKNOWN : n0(b.unsoldTrucks), {
            r: true,
            s: b.unsoldTrucks ? BALANCE_S : "",
          }) +
          cell(value, credit(value)) +
          cell(received, credit(received)) +
          cell(bal, balance(bal)) +
          `</tr>`
        );
      })
    )
  );
};

// ─── Filling stations, grouped by PFI ───────────────────────────────────────

/**
 * Grouped by batch, with the stations under it.
 *
 * A station holds stock from several batches at once and draws each down
 * separately, so "Kano Filling Station" is not a row — it is a row PER BATCH.
 * Flat, that table repeated the same station name five times and the reader
 * had to sort it themselves to answer "how is 14B going". Under a batch
 * heading the question is answered by looking.
 *
 * Stations are customers, not places: a filling station is a row in
 * `delivery_customers` reached through the sale's customer_id. Grouping on the
 * customer retired a whole class of spelling problem the free-text `location`
 * had (JOS/JOSE, KADUNA/KADUAN) — and stopped DAMATURU and KADUNA, which are
 * cities, being listed as stations.
 */
const STATION_HEADERS = [
  "Station", "Initial stock", "Opening stock today", "Volume sold today", "Total volume sold",
  "Stock remaining", "Sales value today", "Total amount received", "Balance",
];

/**
 * Station volumes are litres, and that is an assumption worth naming.
 *
 * Unlike a depot batch, a station's figures are summed across `delivery_sales`
 * rows that carry no unit of their own — the allocation does, on
 * `delivery_inventory.pfi_product`, but the sale does not, and the two are
 * joined on a free-text code. Every station on the ledger sells PMS, so litres
 * is right today. The day one holds gas, this line is where it is wrong, and
 * the fix is to carry the unit through the allocation rather than to change
 * this constant.
 */
const STATION_UNIT = "Litres";

const stationGroups = (stations) => {
  if (!stations.length) return "";

  const byCode = new Map();
  for (const st of stations) {
    if (!byCode.has(st.code)) byCode.set(st.code, []);
    byCode.get(st.code).push(st);
  }

  const groups = [...byCode.entries()]
    .map(([code, rows]) => {
      const body = rows.map((st) => {
        const soldToday = q0(st.litresToday, STATION_UNIT);
        const sold = q0(st.litres, STATION_UNIT);
        const value = m(st.salesValueToday);
        const received = m(st.fundsReceived);
        const bal = m(st.balance);
        return (
          `<tr>` +
          idCell(st.party) +
          cell(st.allocatedLitres ? qty(st.allocatedLitres, STATION_UNIT) : UNKNOWN, { ...KEY, r: true }) +
          // Opening is derived from what remains, so it is only as knowable as
          // that is: a station that has sold more than was ever allocated to it
          // has no honest opening figure, and prints none rather than a
          // negative one.
          cell(st.stockKnown ? qty(st.openingLitresToday, STATION_UNIT) : UNKNOWN, { ...KEY, r: true }) +
          cell(soldToday, credit(soldToday)) +
          cell(sold, credit(sold)) +
          cell(st.stockKnown ? qty(st.remainingLitres, STATION_UNIT) : UNKNOWN, {
            r: true,
            bg: TINT,
            s: KEY_S + (st.stockKnown && st.remainingLitres ? BALANCE_S : ""),
          }) +
          cell(value, credit(value)) +
          cell(received, credit(received)) +
          cell(bal, balance(bal)) +
          `</tr>`
        );
      });
      return group(batchLabel(code), `${rows.length} station${rows.length === 1 ? "" : "s"}`) +
        table(STATION_HEADERS, body);
    })
    .join("");

  return section("Filling stations", "active stock, by PFI") + `</div>` + groups;
};

// ─── Staff reports ──────────────────────────────────────────────────────────

/**
 * Prices, the customer list and remarks are COLUMNS, not notes under the row.
 *
 * They used to render as a second full-width row beneath each entry, each
 * prefixed with its own little "Prices:" / "Top customers:" / "Remarks:"
 * label — three lines of hint text per sheet filed. Across five roles and
 * several PFIs that becomes most of the section, and a reader following a
 * column of figures has to step over prose to reach the next number.
 *
 * A column only appears when at least one sheet in that table actually filled
 * it in: an empty "Top customers" column on every compliance table is the same
 * noise wearing a different hat.
 */
const priceBandsText = (bands, unit) =>
  (bands || []).map((b) => `${qty(b.litres, unit)} @ ₦${n0(b.price)}`).join("<br>");

const topCustomersText = (list, unit) =>
  (list || []).map((c) => `${escapeHtml(c.name) || "—"} &mdash; ${qty(c.litres, unit)}`).join("<br>");

/** An array with something in it, or a string that is not just whitespace. */
const filled = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "");

const EXTRA_COLUMNS = [
  { key: "priceBands", label: "Prices", roles: HAS_PRICE_BANDS, render: priceBandsText },
  { key: "topCustomers", label: "Top customers", roles: HAS_TOP_CUSTOMERS, render: topCustomersText },
  // Every role can leave a remark, so this one is not restricted by role.
  { key: "remarks", label: "Remarks", roles: null, render: (v) => escapeHtml(String(v)) },
];

const TONE_STYLE = { credit: CREDIT_S, balance: BALANCE_S };

/**
 * One table per desk, under the desk's own headings, listing every batch.
 *
 * ── Why each role gets its own columns ────────────────────────────────────
 *
 * This was one 12-column table with fixed headers that every role was forced
 * through, and the five daily reports do not share those fields: the gate
 * sheet's `trucksEntered` had no column at all, every commission figure was
 * absent while its `amountPaid` showed under a heading meaning cash banked,
 * and a filed compliance sheet rendered as a row of dashes. So each role now
 * declares its own columns (roleFields.js), in the same order and under the
 * same labels as the form that collects them and the Reports Hub that lists
 * them.
 *
 * ── Why a batch that filed nothing still gets a row ───────────────────────
 *
 * The section used to list the sheets that arrived and say nothing about the
 * ones that did not, so a desk that filed nothing all day looked exactly like
 * a desk that does not exist. Reading this at the end of a day, who has NOT
 * reported is the question. Every active batch appears under every role, and
 * one that filed nothing says so.
 *
 * There is no approval badge beside the filer's name. Whether a manager has
 * since signed a sheet off is a workflow state that belongs in the Reports
 * Hub; a green or red chip against a person's name in a document circulated to
 * the whole company reads as a verdict on them.
 */
const roleTable = ({ type, label, filed: filedCount, rows }) => {
  const fields = ROLE_FIELDS[type] || [];
  const entries = rows.filter((r) => r.reported);

  const extraCols = EXTRA_COLUMNS.filter(
    (c) => (!c.roles || c.roles.has(type)) && entries.some((e) => filled(e[c.key]))
  );

  const headers = [
    "Staff name", "PFI",
    ...fields.map((f) => f.label),
    ...extraCols.map((c) => c.label),
  ];

  const body = rows.map((e) => {
    if (!e.reported) {
      // The first cell says it; the rest of the row is one span rather than a
      // dash per column. Across five desks and eleven batches that difference
      // is several KB of a document Gmail clips.
      return (
        `<tr>` +
        cell(`<em>Not reported</em>`, { s: MUTED_S }) +
        cell(escapeHtml(up(e.pfiNumber)) || "—", { s: MUTED_S }) +
        // Math.max, because a colspan of 0 is not a span — it would emit a
        // third cell into a two-column table. No role declares zero columns
        // today; a role that did would silently break the table.
        cell("—", { s: MUTED_S, span: Math.max(1, headers.length - 2) }) +
        `</tr>`
      );
    }

    const figures = fields
      .map((f) => {
        const fmt = FORMATTERS[f.fmt] || FORMATTERS.text;
        const value = fmt(e[f.key], e.unit);
        // An em-dash means "not filled in" and is not a figure, so it never
        // takes a colour — a red dash reads as a problem where there is none.
        const tone = f.tone && value !== "—" ? TONE_STYLE[f.tone] : "";
        return cell(value, { r: NUMERIC_FORMATS.has(f.fmt), s: tone });
      })
      .join("");

    const extras = extraCols
      .map((c) => cell(filled(e[c.key]) ? c.render(e[c.key], e.unit) : "—"))
      .join("");

    return (
      `<tr>` +
      cell(`<strong>${escapeHtml(e.submittedBy) || "—"}</strong>`) +
      cell(escapeHtml(up(e.pfiNumber)) || "—", KEY) +
      figures +
      extras +
      `</tr>`
    );
  });

  const note = filedCount
    ? `${filedCount} sheet${filedCount === 1 ? "" : "s"} filed`
    : "nothing filed today";

  return group(label, note) + table(headers, body);
};

const staffReports = (reports) => {
  if (!reports || !reports.length) return "";
  return section("Staff reports", "every desk, every PFI") + `</div>` + reports.map(roleTable).join("");
};

// ─── Assembly ────────────────────────────────────────────────────────────────

const renderPfiDailyReportEmail = (d) => {
  const date = ordinalDate(d.reportDate);
  const subject = `SOROMAN Sales & Operations Report for ${date}`;
  const s = d.summary || {};
  const pfis = d.pfis || [];

  const body =
    FONT_LINK +
    // `max-width` rather than `width`, so the document shrinks to whatever it
    // is given instead of forcing a phone to zoom out to 1100px and render
    // every figure at four pixels. The horizontal padding is what keeps the
    // section bars off the very edge of a narrow screen.
    `<div style="font-family:${FONT};font-size:13px;color:${INK};max-width:1100px;padding:0 2px;">` +
    `<div class="rpt-title" style="font-size:22px;font-weight:900;letter-spacing:1px;line-height:1.1;">SOROMAN</div>` +
    `<div style="font-size:14px;font-weight:700;letter-spacing:.4px;color:${INK};margin-top:2px;line-height:1.3;">` +
    `Sales &amp; Operations Report</div>` +
    `<div style="font-size:12px;color:${MUTED};margin-top:3px;">${escapeHtml(up(date))}</div>` +
    `<div style="height:1px;line-height:1px;background:${INK};margin:12px 0 16px;">&nbsp;</div>` +
    // The greeting, in the words the desk reads it in. Deliberately the first
    // prose in the document and deliberately before any figure: somebody
    // opening this on a phone should know what it is in one line.
    `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;">Dear Sir,</p>` +
    `<p style="margin:0 0 4px;font-size:13px;line-height:1.6;">` +
    `Please find below the summary of sales and operations across all locations for ` +
    `<strong>${escapeHtml(date)}</strong>.</p>` +
    /**
     * There is deliberately no figure between the greeting and DEPOT SALES.
     *
     * A four-tile band sat here with the day in headline numbers, and the
     * biggest of them could not be trusted: TOTAL VOLUME SOLD added litres of
     * petrol to kilograms of gas, because the batches are not measured in the
     * same thing, and no honest unit could be printed beside it. A summary
     * whose first figure is wrong teaches the reader to distrust the tables
     * underneath, which are right.
     *
     * The tables are the report. Each one carries its own units and its own
     * totals, and every figure in them can be traced to the rows it came from.
     */
    depotSales(pfis) +
    gateReport(pfis) +
    expenses(d.expenseLines) +
    commissions(pfis) +
    truckSales(d.truckSales || []) +
    stationGroups(d.stations || []) +
    staffReports(d.staffReports) +
    `<p style="margin:34px 0 0;font-size:13px;color:${INK};">Best regards,<br/>Soroman System</p>` +
    `</div>`;

  /**
   * The plain-text alternative.
   *
   * What a text-only client, a watch and most screen readers actually render.
   * It used to repeat the four headline figures the band showed; those went
   * with the band, and for the same reason — a volume total that adds litres to
   * kilograms is not a figure worth carrying anywhere. What is left says what
   * the report covers and how much of it there is, and sends the reader to the
   * tables, which are the report.
   */
  const text = [
    `SOROMAN Sales & Operations Report for ${date}`,
    "",
    "Dear Sir,",
    "",
    `Please find below the summary of sales and operations across all locations for ${date}.`,
    "",
    `${s.activePfis || 0} active PFI(s), ${s.activeBatches || 0} truck-sales batch(es), ` +
      `${s.activeStations || 0} filling station(s).`,
    "",
    "Depot sales, loading and exit gate, expenses, commissions, truck sales,",
    "filling stations and staff reports follow in the HTML version of this email.",
    "",
    "Best regards,",
    "Soroman System",
  ].join("\n");

  return { subject, html: body, text };
};

module.exports = { renderPfiDailyReportEmail };
