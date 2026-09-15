const { z } = require("zod");

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const priceBandSchema = z.object({
  price: z.coerce.number().nonnegative(),
  litres: z.coerce.number().nonnegative(),
});

const REPORT_TYPES = [
  "sales_manager",
  "product_manager",
  "security_gate",
  "commissions",
  "it_compliance",
];

const submitDailyReportSchema = z.object({
  // Which of the five reports this is. Zod strips unknown keys, so without
  // this the field was silently dropped and every report saved as the
  // column default — the type filter then found nothing.
  reportType: z.enum(REPORT_TYPES).optional(),
  // Commission and compliance fields, real columns rather than text packed
  // into remarks.
  customerCount: z.coerce.number().int().nonnegative().optional(),
  orderCount: z.coerce.number().int().nonnegative().optional(),
  rates: z.string().max(500).optional(),
  reportDate: z.string().date(),
  location: z.string().min(1).max(255),
  pfiNumber: z.string().max(50).optional().default(""),
  productName: z.string().max(100).optional(),
  carriedOverLoading: z.coerce.number().nonnegative().optional(),
  openingStock: z.coerce.number().nonnegative().optional(),
  receivedStock: z.coerce.number().nonnegative().optional(),
  litresSold: z.coerce.number().nonnegative().optional(),
  avgPrice: z.coerce.number().nonnegative().optional(),
  priceBands: z.array(priceBandSchema).max(20).optional(),
  tankBalance: z.coerce.number().nonnegative().optional(),
  loadingLeftOver: z.coerce.number().nonnegative().optional(),
  // The location manager's sheet. Nullable rather than defaulted: on a form
  // filled in across a shift, 0 and "not answered" are different answers.
  // A balance may legitimately go negative when a tank is over-drawn against
  // the book, so those are not nonnegative.
  blFigure: z.coerce.number().nonnegative().nullish(),
  tankInitial: z.coerce.number().nonnegative().nullish(),
  aggregateSold: z.coerce.number().nonnegative().nullish(),
  pfiDaysCounting: z.coerce.number().int().nonnegative().nullish(),
  yesterdayRemarks: z.string().max(5000).nullish(),
  soldUnloaded: z.coerce.number().nullish(),
  tankBalanceInclusive: z.coerce.number().nullish(),
  netTankBalance: z.coerce.number().nullish(),
  amountPaid: z.coerce.number().nonnegative().optional(),
  differentials: z.coerce.number().optional(),
  truckCount: z.coerce.number().int().nonnegative().optional(),
  // Settling yesterday's gap, and the running bank total for this PFI — both
  // distinct from today's own amountPaid/differentials above.
  yesterdayDeficitPayment: z.coerce.number().nonnegative().optional(),
  yesterdaySurplusPayment: z.coerce.number().nonnegative().optional(),
  totalInflow: z.coerce.number().nonnegative().optional(),
  // Commission report. Nullable rather than defaulted — see the columns'
  // own note in db/schema/dailyReport.js on why 0 and "not filled in" have
  // to stay distinguishable here.
  fundsReceived: z.coerce.number().nonnegative().nullish(),
  commissionDue: z.coerce.number().nonnegative().nullish(),
  // Both start life as a subtraction of the two above and stay editable —
  // what is still owed can carry arrears today's figures cannot see. Signed:
  // paying more than was due leaves a negative outstanding, which is a real
  // answer and not one to reject.
  commissionOutstanding: z.coerce.number().nullish(),
  fundsRemaining: z.coerce.number().nullish(),
  // security_gate's other truck count — truckCount above is "exited" for
  // this role, this is "entered".
  trucksEntered: z.coerce.number().int().nonnegative().optional(),
  bankName: z.string().max(255).optional(),
  accountNumber: z.string().max(50).optional(),
  topCustomers: z.array(z.object({
    name: z.string().max(255),
    phone: z.string().max(30).optional().default(""),
    litres: z.coerce.number().nonnegative().optional(),
  })).max(5).optional(),
  remarks: z.string().max(5000).optional(),
});

const amendDailyReportSchema = submitDailyReportSchema.partial();

const reviewDailyReportSchema = z.object({
  approve: z.boolean(),
  comment: z.string().max(2000).optional().default(""),
});

const dailyReportQuerySchema = z.object({
  reportType: z.enum(REPORT_TYPES).optional(),
  page: z.coerce.number().int().positive().default(1),
  // 1000, not 100 — the ceiling the repository itself clamps to, and the one
  // schemas/fields.js#pagination gives every other list.
  //
  // This schema hand-rolls its pagination instead of extending that helper, so
  // when the dashboard moved every list to 1000 rows a page it took this
  // endpoint with it and nothing here followed. The page has been asking for
  // limit=1000 and getting a flat 400 ever since: no reports, for anybody, on
  // a screen whose whole job is showing you what you filed. It reads exactly
  // like empty data, which is how it survived being looked at more than once.
  limit: z.coerce.number().int().positive().max(1000).default(50),
  location: z.string().max(255).optional(),
  status: z.enum(["submitted", "approved", "rejected"]).optional(),
  pfiNumber: z.string().max(50).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  sort: z
    .enum(["reportDate", "location", "createdAt", "totalSalesAmount", "litresSold"])
    .optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

// The Hub's own "Email report" action: the same combined report the
// scheduled job sends, for whatever date the admin is looking at, to whoever
// they type in — not the static REPORT_RECIPIENTS list the scheduled script
// uses. filename/attachmentBase64/reportCount/location/pfi are accepted but
// ignored, so an un-updated client that still builds a workbook doesn't 400.
const emailReportsHubSchema = z.object({
  recipients: z.array(z.string().email()).min(1).max(25),
  reportDate: z.string().date(),
  filename: z.string().max(255).optional(),
  attachmentBase64: z.string().optional(),
  reportCount: z.coerce.number().int().nonnegative().optional(),
  location: z.string().max(255).optional(),
  pfi: z.string().max(50).optional(),
});

/**
 * Numbers rather than emails, and validated loosely on purpose.
 *
 * The shapes people type — 0803…, +234803…, 234 803 … — all mean the same
 * number, so normalising is the service's job (see whatsappReport.service) and
 * this only rejects what could not be a phone number at all. A stricter rule
 * here would reject a correct number typed in a correct-but-unexpected way.
 */
const whatsappReportSchema = z.object({
  recipients: z.array(z.string().min(7).max(25)).min(1).max(25),
  reportDate: z.string().date(),
  /** Resolve everything and send nothing — see sendDailyReportToWhatsApp. */
  preview: z.boolean().optional(),
});

module.exports = {
  whatsappReportSchema,
  idParamSchema,
  submitDailyReportSchema,
  amendDailyReportSchema,
  reviewDailyReportSchema,
  dailyReportQuerySchema,
  emailReportsHubSchema,
};
