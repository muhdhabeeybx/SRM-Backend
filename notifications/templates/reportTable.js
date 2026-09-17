const { escapeHtml } = require("./email");

/**
 * The shared visual language of the report emails, and the primitives that
 * draw them.
 *
 * Extracted from dailyReportEmail so the per-PFI report cannot drift away from
 * the combined one. Two report emails that agree on what green means but
 * disagree by a shade, because the constant was copied rather than shared, is
 * worse than either choice made once: a reader learns the colours from
 * whichever email arrives first and then reads the other one wrong.
 *
 * Every rule below was learned rather than chosen. They are kept verbatim.
 */

/**
 * ── Black and white, with two colours that mean something ──────────────────
 *
 * The report used to be green throughout: green header rows, a green tint on
 * every key cell, green section labels, a green rule above each depot. Colour
 * that is everywhere carries no information — it was decoration, and it made
 * the figures harder to pick out rather than easier.
 *
 * So the document is ink on white, and colour is spent on the two things a
 * reader looks for first: what came IN — revenue and litres sold — in green,
 * and what is LEFT or STILL OWED — closing stock, balances, unpaid commission
 * — in red. Nothing else is coloured, which is what makes those two legible.
 */
const INK = "#1a1a1a";
const MUTED = "#6B7280";
/** Header rows: black ground, white type. */
const HEAD = "#1a1a1a";
const HEAD_KEY = "#000000";
/** The one tint left in the document, for the cells that anchor a row. */
const TINT = "#F5F5F5";
/** Money in, product moved. */
const CREDIT = "#15803D";
/** What is left standing: closing stock, balances, amounts not yet paid. */
const BALANCE = "#B91C1C";

/**
 * Cells carry attributes, not repeated style strings.
 *
 * Every `<td>` used to open with 72 bytes of identical inline CSS
 * (padding + border + colour + vertical-align). Over a day with ninety orders
 * and five staff tables per depot that alone came to ~90KB, and Gmail clips a
 * message at 102KB — the report would have been cut off mid-table, which is
 * the one failure a daily report cannot have.
 *
 * `cellpadding` and `align` are HTML attributes every mail client including
 * Outlook honours, so padding and alignment cost nothing per cell and only the
 * border remains in CSS. Colour is inherited from the wrapper. Same rendering,
 * roughly a third of the bytes.
 *
 * The same reasoning retired three more declarations. `background:` became the
 * `bgcolor` ATTRIBUTE, which every client including Outlook honours, and on a
 * <th> both `font-weight` (a header cell is bold already) and the repeated
 * background were restating what the element does. Across the ~150 header and
 * tinted cells a day's report renders, that was several KB of a document Gmail
 * clips at 102KB.
 *
 * The font is the one thing that had to be ADDED. Gmail and Apple Mail inherit
 * `font-family` into a table happily; Outlook, which renders through Word, does
 * not — it resets at the table boundary, so the prose came out in Satoshi and
 * every figure beneath it in a serif.
 */
const FONT_STACK =
  "'Satoshi','Satoshi Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const TABLE =
  '<table width="100%" border="1" bordercolor="#CCCCCC" cellpadding="6" cellspacing="0" ' +
  `style="border-collapse:collapse;font-size:12px;font-family:${FONT_STACK};">`;

/** Header cells: white type on HEAD, which `hcell` paints with `bgcolor`. */
const TH_S = "color:#fff;text-transform:uppercase;font-size:11px;letter-spacing:.3px;";

// Opening and closing stock carry the report, so they are tinted: the eye
// finds the two ends of the day's movement without reading the headers. The
// tint itself is `bg: TINT` on the cell; this is the weight that goes with it.
const KEY_S = "font-weight:700;";

/** The two meaning-carrying colours, as cell styles. */
const CREDIT_S = "color:" + CREDIT + ";font-weight:600;";
const BALANCE_S = "color:" + BALANCE + ";font-weight:600;";

/**
 * A plain cell carries no style attribute at all — the table's `border` and
 * `cellpadding` attributes draw it. Only a cell that is tinted, totalled or
 * spanned pays for CSS, and those are a handful per table rather than every
 * cell in it.
 */
const cell = (html, { r = false, s = "", span = 0, bg = "" } = {}) =>
  `<td${bg ? ` bgcolor="${bg}"` : ""}${r ? ' align="right"' : ""}` +
  `${span ? ` colspan="${span}"` : ""}${s ? ` style="${s}"` : ""}>${html}</td>`;

const hcell = (label, { r = false, s = "", bg = HEAD } = {}) =>
  `<th bgcolor="${bg}"${r ? ' align="right"' : ""} style="${s || TH_S}">${escapeHtml(label)}</th>`;

/** "₦1,504,000" — same rule, with the naira sign. */
const m = (val) => {
  const f = Number(val);
  if (!Number.isFinite(f) || f === 0) return "—";
  return `₦${f.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
};

/** Plain {:,.0f}-style formatting for stock figures, which print 0 rather than —. */
const n0 = (val) => Number(val || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });

const ORDINALS = { 1: "st", 2: "nd", 3: "rd" };
function ordinalDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDate();
  const suffix = ORDINALS[day % 10] && !(day % 100 >= 11 && day % 100 <= 13) ? ORDINALS[day % 10] : "th";
  const month = d.toLocaleDateString("en-NG", { month: "long", timeZone: "UTC" });
  return `${day}${suffix} ${month} ${d.getUTCFullYear()}`;
}

function plainDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

module.exports = {
  INK, MUTED, HEAD, HEAD_KEY, TINT, CREDIT, BALANCE, FONT_STACK,
  TABLE, TH_S, KEY_S, CREDIT_S, BALANCE_S,
  cell, hcell, m, n0, ordinalDate, plainDate, plural,
};
