const { z } = require("zod");

/**
 * The CFO report's query and its corrections.
 *
 * Zod strips unknown keys, so these double as whitelists — which is what
 * stops a PUT carrying `{ remarks, stockBalance: 0 }` from writing a column
 * that is deliberately derived rather than stored. See migration 0040.
 */

/** "2026-09-17". The report is laid out in calendar days, never instants. */
const day = z.string().date();

const cfoReportQuerySchema = z
  .object({
    dateFrom: day,
    dateTo: day,
    depotId: z.coerce.number().int().positive().optional(),
    pfiId: z.coerce.number().int().positive().optional(),
    /**
     * Every batch that had started by the date, rather than only the ones
     * trading. Off by default: a sheet listing forty finished cargoes at
     * zero buries the twelve that matter.
     */
    includeAll: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .transform((v) => v === true || v === "true" || v === "1")
      .optional()
      .default(false),
  })
  // Caught here rather than in the service, where a reversed range returns an
  // empty `days` array and reads as "no trading in this period".
  .refine((q) => q.dateFrom <= q.dateTo, {
    message: "dateFrom must not be after dateTo",
    path: ["dateFrom"],
  })
  /**
   * A year at a time, and no more.
   *
   * The report is one block per day, so the response grows linearly with the
   * range and a five-year request is a slow query that ends in a browser tab
   * nobody can scroll. 366 keeps a full year — including a leap one —
   * reachable, which is the widest span anyone has asked for.
   */
  .refine(
    (q) =>
      (Date.parse(`${q.dateTo}T00:00:00Z`) - Date.parse(`${q.dateFrom}T00:00:00Z`)) /
        86400000 <=
      365,
    { message: "Range must be 366 days or fewer", path: ["dateTo"] }
  );

/**
 * A figure somebody has typed over the top of the system's.
 *
 * `nullish`, and the distinction is the whole design: a key sent as null
 * clears the override and hands the cell back to the computed figure, a key
 * left out entirely leaves whatever is already saved alone, and 0 is a real
 * correction meaning zero. Collapsing any two of those would make a cell
 * impossible to un-correct. See db/migrations/0040.
 *
 * Not `nonnegative`. A cumulative volume cannot sensibly be negative but a
 * bank inflow can — a batch that gave more surplus away than it ever received
 * nets below zero — and a report that refuses to record what happened is
 * worse than one showing an uncomfortable figure.
 */
const override = z.coerce.number().finite().nullish();

const cfoReportEntrySchema = z.object({
  reportDate: day,
  pfiId: z.coerce.number().int().positive(),

  initialQty: override,
  cumulativeVolume: override,
  dayVolume: override,
  salesValue: override,
  bankInflow: override,

  remarks: z.string().max(2000).optional(),
});

/** Which row to put back to what the system says. */
const cfoReportEntryKeySchema = z.object({
  reportDate: day,
  pfiId: z.coerce.number().int().positive(),
});

module.exports = {
  cfoReportQuerySchema,
  cfoReportEntrySchema,
  cfoReportEntryKeySchema,
};
