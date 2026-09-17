const { escapeHtml } = require("./email");
const { n0 } = require("./reportTable");

/**
 * What each desk reports, and how each figure is spelled.
 *
 * Lifted out of dailyReportEmail so the per-PFI report renders a staff sheet
 * the same way the combined one does. Two report emails that disagree about
 * what `truckCount` means, because the column list was copied rather than
 * shared, is the same drift the palette was extracted to prevent — and this
 * half is worse, because the disagreement is about the NUMBERS rather than
 * about a shade of green.
 *
 * The reasoning behind every rule below moved with it, verbatim.
 */

// ─── Units ──────────────────────────────────────────────────────────────────

/**
 * The unit, spelled out.
 *
 * These columns used to abbreviate to "L" to stay narrow. It read as
 * engineering shorthand rather than as a report — "300,000 L" is a gauge
 * reading, "300,000 Litres" is a sentence — so the word is written in full and
 * the table is simply allowed to be wider; it already scrolls on its own.
 *
 * `pfis.product_unit` spells the same unit several ways and the live rows use
 * three of them at once — 'Liters', 'Litres' and 'kg' — so an unrecognised one
 * passes through as written rather than being guessed at. The one thing this
 * must never do is print "Litres" against the LPG batches, which is exactly
 * what a hard-coded unit did.
 */
const UNIT_LABEL = {
  l: "Litres",
  litres: "Litres",
  litre: "Litres",
  liters: "Litres",
  liter: "Litres",
  kilograms: "Kg",
  kilogram: "Kg",
  kg: "Kg",
  tonnes: "MT",
  tonne: "MT",
  mt: "MT",
};
const unitOf = (u) => UNIT_LABEL[String(u || "").toLowerCase()] || String(u || "Litres");

/**
 * The denominator in a rate: "₦1,200 per litre", not "₦1,200/Litres".
 * A rate reads as prose, so the unit goes singular and lower-case.
 */
const RATE_WORD = { Litres: "litre", Kg: "kg", MT: "MT" };
const rateWord = (u) => RATE_WORD[unitOf(u)] || unitOf(u).toLowerCase();

/** "3,000,000 Litres" — a quantity always carries its batch's own unit. */
const qty = (v, unit) => `${n0(v)} ${unitOf(unit)}`;

// ─── Field formatting ───────────────────────────────────────────────────────

/**
 * Null is not zero.
 *
 * The commission and gate figures are nullable with no default precisely so
 * that "nobody filled this in" stays distinguishable from "the answer is
 * zero" on a sheet somebody files in stages. A null renders as an em-dash; a
 * real 0 renders as 0.
 */
const FORMATTERS = {
  litres: (v, unit) => (v === null || v === undefined ? "—" : qty(v, unit)),
  money: (v) => (v === null || v === undefined ? "—" : `₦${n0(v)}`),
  rate: (v, unit) =>
    v === null || v === undefined || Number(v) === 0 ? "—" : `₦${n0(v)} per ${rateWord(unit)}`,
  count: (v) => (v === null || v === undefined ? "—" : n0(v)),
  text: (v) => escapeHtml(String(v ?? "")) || "—",
};

const NUMERIC_FORMATS = new Set(["litres", "money", "rate", "count"]);

/**
 * What each desk reports, in the order its own form asks for it.
 *
 * Keys are the API's column names — the same ones the dashboard form posts and
 * the Reports Hub lists — so a field added to a form needs one line here and
 * nothing else. Labels match the form's labels, with the two that mean
 * different things per role spelled out: `truckCount` is "Trucks exited" on the
 * gate sheet and "Trucks sold/loaded" everywhere else, and `amountPaid` is
 * "Commission paid" on the commission sheet and cash banked elsewhere.
 *
 * `tone` is the only place colour is decided for these tables: "credit" for a
 * figure that means money in or product moved, "balance" for one that means
 * what is left standing or not yet paid. A field with no tone prints in ink,
 * which is most of them — that is the point.
 */
const ROLE_FIELDS = {
  security_gate: [
    { key: "trucksEntered", label: "Trucks entered", fmt: "count" },
    { key: "truckCount", label: "Trucks exited", fmt: "count" },
  ],
  sales_manager: [
    { key: "openingStock", label: "Opening balance", fmt: "litres" },
    { key: "litresSold", label: "Litres sold", fmt: "litres", tone: "credit" },
    { key: "avgPrice", label: "Avg price", fmt: "rate" },
    { key: "totalSalesAmount", label: "Total sales", fmt: "money", tone: "credit" },
    { key: "truckCount", label: "Trucks sold", fmt: "count" },
    { key: "amountPaid", label: "Amount paid", fmt: "money", tone: "credit" },
    { key: "totalInflow", label: "Total inflow", fmt: "money", tone: "credit" },
    { key: "differentials", label: "Differentials", fmt: "money" },
    { key: "yesterdayDeficitPayment", label: "Yest. deficit", fmt: "money" },
    { key: "yesterdaySurplusPayment", label: "Yest. surplus", fmt: "money" },
    { key: "bankName", label: "Bank", fmt: "text" },
    { key: "accountNumber", label: "Account no.", fmt: "text" },
  ],
  product_manager: [
    { key: "openingStock", label: "Opening (b/f)", fmt: "litres" },
    { key: "receivedStock", label: "Ordered today", fmt: "litres" },
    { key: "litresSold", label: "Loaded today", fmt: "litres", tone: "credit" },
    { key: "loadingLeftOver", label: "Loading left over", fmt: "litres" },
    { key: "tankBalance", label: "Tank balance", fmt: "litres", tone: "balance" },
    { key: "truckCount", label: "Trucks loaded", fmt: "count" },
    { key: "differentials", label: "Differentials", fmt: "money" },
  ],
  commissions: [
    { key: "fundsReceived", label: "Funds received", fmt: "money", tone: "credit" },
    { key: "litresSold", label: "Litres sold", fmt: "litres", tone: "credit" },
    { key: "truckCount", label: "Trucks sold", fmt: "count" },
    { key: "customerCount", label: "Customers", fmt: "count" },
    { key: "orderCount", label: "Orders", fmt: "count" },
    { key: "commissionDue", label: "Commission due", fmt: "money" },
    { key: "amountPaid", label: "Commission paid", fmt: "money", tone: "credit" },
    { key: "commissionOutstanding", label: "Not yet paid", fmt: "money", tone: "balance" },
    { key: "fundsRemaining", label: "Funds remaining", fmt: "money", tone: "balance" },
  ],
  it_compliance: [
    { key: "orderCount", label: "Orders", fmt: "count" },
    { key: "litresSold", label: "Litres ordered", fmt: "litres", tone: "credit" },
    { key: "avgPrice", label: "Avg price", fmt: "rate" },
    { key: "totalSalesAmount", label: "Total value", fmt: "money", tone: "credit" },
  ],
};

/**
 * The order the desks are read in, and what each is called out loud.
 *
 * Plural, because the heading labels a table of people rather than a job
 * title: "SALES MANAGERS" over three rows, not "SALES MANAGER".
 */
const ROLE_ORDER = ["sales_manager", "product_manager", "security_gate", "commissions", "it_compliance"];

const ROLE_LABELS = {
  sales_manager: "Sales Managers",
  product_manager: "Product Managers",
  security_gate: "Security Gate",
  commissions: "Commissions",
  it_compliance: "IT & Compliance",
};

/** Which roles collect a price table, and which collect a customer list. */
const HAS_PRICE_BANDS = new Set(["sales_manager", "it_compliance"]);
const HAS_TOP_CUSTOMERS = new Set(["it_compliance"]);

module.exports = {
  UNIT_LABEL, unitOf, rateWord, qty,
  FORMATTERS, NUMERIC_FORMATS,
  ROLE_FIELDS, ROLE_ORDER, ROLE_LABELS,
  HAS_PRICE_BANDS, HAS_TOP_CUSTOMERS,
};
