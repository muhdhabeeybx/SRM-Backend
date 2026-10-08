const z = require("zod");

/** The LPG plants' expenses tracker — services/expenseTracker.service.js checks every field. */

const cell = z.union([z.string().max(2000), z.number(), z.null()]).optional();
const row = z.object({
  line: z.coerce.number().int().optional(),
  tab: cell,
  sn: cell,
  date: cell,
  amount: cell,
  receipt: cell,
  vendor: cell,
  vendorBank: cell,
  reason: cell,
  location: cell,
  source: cell,
  sourceBank: cell,
});

const upload = z.object({
  dryRun: z.boolean().optional(),
  enteredBy: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  rows: z.array(row).min(1, "No expenses to record").max(3000, "Too many rows in one go — split the file"),
});

module.exports = { upload };
