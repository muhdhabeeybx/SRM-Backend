const { z } = require("zod");

/**
 * A statement's period: inclusive Lagos days, either end open. Unknown keys
 * are stripped, as with every schema here.
 */
const day = z.string().date();

const statementQuery = z
  .object({
    from: day.optional(),
    to: day.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "from must not be after to",
    path: ["from"],
  });

/**
 * The vendor list. With money, each vendor carries what it is owed and was
 * billed and paid over the period (vendorRepo.withMoney).
 */
const vendorListQuery = z
  .object({
    search: z.string().max(200).optional(),
    status: z.string().max(20).optional(),
    withMoney: z.enum(["1", "true"]).optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "from must not be after to",
    path: ["from"],
  });

module.exports = { statementQuery, vendorListQuery };
