/**
 * The expense chart of accounts, as the UI needs to see it.
 *
 * The accounts themselves live in `expense_categories` (seeded by migration
 * 0007) — this file only holds what cannot go in a table: the order the groups
 * are offered in, their labels, and which of them may be booked to.
 */

/**
 * Group codes, in the order the first dropdown offers them.
 *
 * Two, because a cost either belongs to a cargo or it does not, and that one
 * question decides everything that follows: whether a PFI must be named, and
 * whether the amount lands in a batch's cost or in the company's overhead.
 * Splitting the overhead side further — administrative, depot, sales — only
 * asked the requester to classify their own spending before they were allowed
 * to describe it, and got a guess.
 */
const GL_GROUPS = [
  {
    code: "general",
    label: "General Expenses",
    hint: "The cost of running the company. Not tied to any cargo.",
  },
  {
    code: "pfi_direct",
    label: "PFI Attached Expenses",
    hint: "Booked to a cargo batch and rolled into its cost.",
    /** The only group that may name a PFI — and it must. */
    requiresPfi: true,
  },
];

const GROUP_BY_CODE = new Map(GL_GROUPS.map((g) => [g.code, g]));

/** Everything but income. What the expense form is allowed to offer. */
const EXPENSE_GROUPS = GL_GROUPS.filter((g) => !g.isIncome);

/** One of the expense form's groups, or null. */
const groupFor = (code) => GROUP_BY_CODE.get(code) || null;

/**
 * The rest of the chart (migration 0081): accounts the general ledger posts to
 * and the expense form never offers. An expense booked to one of these is
 * refused (expense.controller resolveBooking) — a bank account or a sales
 * account is not something money is spent on.
 *
 * `type` is the account's kind in the accounts: what side its balance sits on,
 * and where it is printed — balance sheet or profit and loss.
 */
const LEDGER_GROUPS = [
  { code: "assets", label: "Assets", type: "asset" },
  { code: "liabilities", label: "Liabilities", type: "liability" },
  { code: "equity", label: "Equity", type: "equity" },
  { code: "income", label: "Income", type: "income", isIncome: true },
  { code: "cost_of_sales", label: "Cost of Sales", type: "cost_of_sales" },
];

/** The whole chart, in the order the Chart of Accounts lists it. */
const CHART_GROUPS = [
  ...LEDGER_GROUPS,
  { ...groupFor("pfi_direct"), type: "cost_of_sales" },
  { ...groupFor("general"), type: "expense" },
];
const CHART_BY_CODE = new Map(CHART_GROUPS.map((g) => [g.code, g]));

/** Any group in the chart, or null. */
const chartGroupFor = (code) => CHART_BY_CODE.get(code) || null;

/** True for the groups only the ledger posts to. */
const isLedgerGroup = (code) => LEDGER_GROUPS.some((g) => g.code === code);

/**
 * An account's kind. A pre-chart category (no group) carried old expenses, so
 * it reads as an expense.
 */
const accountTypeOf = (glGroup) => chartGroupFor(glGroup)?.type || "expense";

/** Assets and costs grow on the debit side; everything else on the credit. */
const DEBIT_TYPES = new Set(["asset", "expense", "cost_of_sales"]);
const normalSideOf = (type) => (DEBIT_TYPES.has(type) ? "debit" : "credit");

/** Nigerian standard rate, applied to the ex-VAT figure on the form. */
const VAT_RATE = 0.075;

/**
 * The withholding rates the form offers, as percentages.
 *
 * Deliberately unlabelled by transaction type. Which rate a given invoice
 * attracts is a judgement Finance makes — printing "5% — professional fees"
 * beside the option would be this app quietly giving tax advice, and would be
 * wrong the moment the schedule changes. Anything not on the list is entered as
 * a plain amount instead.
 *
 * WHT is computed on the ex-VAT value, never on the VAT-inclusive total.
 */
const WHT_RATES = [0, 2, 2.5, 5, 10];

module.exports = {
  GL_GROUPS,
  EXPENSE_GROUPS,
  groupFor,
  LEDGER_GROUPS,
  CHART_GROUPS,
  chartGroupFor,
  isLedgerGroup,
  accountTypeOf,
  normalSideOf,
  VAT_RATE,
  WHT_RATES,
};
