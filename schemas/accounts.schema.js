const { z } = require("zod");

/**
 * The Accounts pages' queries. Lagos days; open ends mean all time. Zod
 * strips unknown keys, so these double as whitelists.
 */
const day = z.string().date();

/** A comma-separated list in the address: "depot,stations", "12,40", "station:12". */
const list = (re, label) =>
  z.string().max(4000)
    .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(re, `${label} is not one the books know`)));

/**
 * What part of the business to read (services/accounting/reports dimsSql):
 * PFIs, units and places, each a list; left out means all.
 */
const dims = {
  pfi: list(/^\d+$/, "A PFI").optional(),
  unit: list(/^(depot|trucking|stations|lpg_plants|fleet|head_office)$/, "A unit").optional(),
  location: list(/^(depot|station|plant):\d+$/, "A place").optional(),
};

const withRange = (shape = {}) =>
  z.object({ from: day.optional(), to: day.optional(), ...dims, ...shape })
    .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to", path: ["from"] });

const periodQuery = withRange();

/** The profit and loss can also be split into columns by unit, PFI or place. */
const profitQuery = withRange({ by: z.enum(["unit", "pfi", "location", "product"]).optional() });

const ledgerQuery = withRange({
  partyType: z.enum(["customer", "delivery_customer", "vendor"]).optional(),
  partyId: z.coerce.number().int().positive().optional(),
});

const journalsQuery = withRange({
  kind: z.enum(["auto", "adjustment", "opening", "manual", "reversal"]).optional(),
  source: z.string().max(40).optional(),
  late: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const accountParam = z.object({ accountId: z.coerce.number().int().positive() });

/** The balance sheet is as at the end of one day. */
const atQuery = z.object({ at: day.optional(), ...dims });

/** A month of the books: '2026-10'. */
const periodParam = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, "A month is written 2026-10") });

/** The accountant's own figures for the opening balances, by account id, debit-positive. */
const openingBody = z.object({
  amounts: z.record(z.string().regex(/^\d+$/), z.coerce.number().finite()).default({}),
});

/** One bank account against its statement. */
const reconciliationQuery = z.object({
  bankAccountId: z.coerce.number().int().positive(),
  from: day.optional(),
  to: day.optional(),
});

const lineParam = z.object({
  direction: z.enum(["credit", "debit"]),
  lineId: z.coerce.number().int().positive(),
});

/** What Finance says a bank line was. */
const classifyBody = z.object({
  accountId: z.coerce.number().int().positive(),
  vendorId: z.coerce.number().int().positive().optional().nullable(),
  note: z.string().trim().max(500).optional().default(""),
});

/** A journal written by hand: a day, what it is for, and its lines. */
const journalBody = z.object({
  day,
  memo: z.string().trim().min(1, "Say what the journal is for").max(500),
  lines: z.array(z.object({
    accountId: z.coerce.number().int().positive(),
    debit: z.coerce.number().min(0).optional().default(0),
    credit: z.coerce.number().min(0).optional().default(0),
    partyType: z.enum(["customer", "delivery_customer", "vendor"]).optional().nullable(),
    partyId: z.coerce.number().int().positive().optional().nullable(),
    pfiId: z.coerce.number().int().positive().optional().nullable(),
    unit: z.enum(["depot", "trucking", "stations", "lpg_plants", "fleet", "head_office"]).optional().nullable(),
    location: z.string().regex(/^(depot|station|plant):\d+$/).optional().nullable(),
    memo: z.string().trim().max(500).optional(),
  })).min(2, "A journal needs at least two lines").max(200),
});

const entryParam = z.object({ entryId: z.coerce.number().int().positive() });
/** Who owes what, and for how long, at the end of a day. */
const ageingQuery = z.object({ side: z.enum(["receivables", "payables"]).optional(), at: day.optional() });

const draftParam = z.object({ draftId: z.coerce.number().int().positive() });
const draftsQuery = z.object({ status: z.enum(["waiting", "posted", "rejected"]).optional() });
const rejectBody = z.object({ reason: z.string().trim().min(1, "Say why it is rejected").max(500) });
const reverseBody = z.object({ day: day.optional() });

/** The Report: a period, and the whole business or one PFI. */
const reportQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  pfi: z.coerce.number().int().positive().optional(),
  place: z.string().regex(/^(depot|station|plant):\d+$/, "That place is not one the books know").optional(),
})
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to", path: ["from"] })
  .refine((q) => !(q.pfi && q.place), { message: "Look at one PFI or one place, not both", path: ["place"] });

// ── The Fixed Assets and Loans registers (0088) ─────────────────────────────

const amount = z.coerce.number().finite();
const optionalId = z.union([z.coerce.number().int().positive(), z.literal(""), z.null()]).optional()
  .transform((v) => (v === "" || v == null ? null : v));
const optionalNumber = z.union([z.coerce.number().finite(), z.literal(""), z.null()]).optional()
  .transform((v) => (v === "" || v == null ? null : v));

const assetParam = z.object({ assetId: z.coerce.number().int().positive() });
const assetBody = z.object({
  name: z.string().trim().min(1, "Give the asset a name").max(255),
  kind: z.enum(["truck", "vehicle", "generator", "tank", "building", "land", "equipment", "computer", "furniture", "other"]),
  fleetTruckId: optionalId,
  boughtOn: day.optional().nullable(),
  cost: optionalNumber,
  residual: optionalNumber,
  lifeMonths: optionalNumber,
  paidHow: z.enum(["bank", "expense", "loan", "owned"]),
  bankAccountId: optionalId,
  expenseId: optionalId,
  loanId: optionalId,
  financed: optionalNumber,
  unit: z.enum(["depot", "trucking", "stations", "lpg_plants", "fleet", "head_office"]).optional().nullable(),
  location: z.string().regex(/^(depot|station|plant):\d+$/).optional().nullable().or(z.literal("")),
  notes: z.string().max(2000).optional().default(""),
});
const disposeBody = z.object({
  disposedOn: day,
  disposedFor: amount.min(0).optional().default(0),
  bankAccountId: optionalId,
});

const loanParam = z.object({ loanId: z.coerce.number().int().positive() });
const repaymentParam = z.object({ loanId: z.coerce.number().int().positive(), repaymentId: z.coerce.number().int().positive() });
const loanBody = z.object({
  kind: z.enum(["bank_loan", "hire_purchase", "other_lender"]),
  lender: z.string().trim().min(1, "Say who lent the money").max(255),
  amount: optionalNumber,
  receivedOn: day.optional().nullable().or(z.literal("")),
  bankAccountId: optionalId,
  interestRate: optionalNumber,
  termMonths: optionalNumber,
  notes: z.string().max(2000).optional().default(""),
  closedOn: day.optional().nullable().or(z.literal("")),
});
const repaymentBody = z.object({
  paidOn: day,
  principal: amount.min(0).optional().default(0),
  interest: amount.min(0).optional().default(0),
  bankAccountId: z.coerce.number().int().positive({ message: "Say which bank account it was paid from" }),
  notes: z.string().max(2000).optional().default(""),
});

module.exports = { reportQuery, assetParam, assetBody, disposeBody, loanParam, repaymentParam, loanBody, repaymentBody, ageingQuery, journalBody, entryParam, draftParam, draftsQuery, rejectBody, reverseBody, reconciliationQuery, lineParam, classifyBody, periodQuery, profitQuery, ledgerQuery, journalsQuery, accountParam, atQuery, periodParam, openingBody };
