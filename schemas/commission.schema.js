const z = require("zod");
const { id, money, requiredString, searchTerm, pagination } = require("./fields");

const listCommissions = pagination.extend({
  search: searchTerm,
  status: z.enum(["all", "pending", "paid", "skipped"]).optional(),
  depotId: id("Depot id").optional(),
  customerId: id("Customer id").optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
});

const idParam = z.object({ id: id("Commission id") });

// A reason is required, and short enough to be a reason rather than an essay.
// The row outlives everyone's memory of the order; "why was this not paid" is
// the only question it will ever be asked.
const skipCommission = z.object({
  reason: requiredString("Reason", 2000),
});

const revertCommission = z.object({
  reason: requiredString("Reason", 2000),
  // Only meaningful on a commission that credited a wallet in the old world.
  acknowledgeWalletCredit: z.boolean().optional(),
});

const bulkResolve = z.object({
  ids: z.array(id("Commission id")).min(1, "Select at least one commission").max(200, "Too many at once"),
  action: z.enum(["confirm", "skip"], { error: "Action must be confirm or skip" }),
  // Only read on a skip. Optional here so confirming a selection does not have
  // to invent one; the service rejects a skip without it.
  reason: z.string().trim().max(2000).optional(),
});

const upsertRate = z.object({
  depotId: id("Depot id"),
  productId: id("Product id"),
  commissionRate: money("Commission rate", { min: 0 }),
});

const dailyReport = z.object({
  location: z.string().trim().max(255).optional().default(""),
  pfi: z.string().trim().max(255).optional().default(""),
  date: z.string().trim().optional().default(""),
  litresSold: z.union([z.number(), z.string().trim()]).optional().default("0"),
  truckCount: z.union([z.number(), z.string().trim()]).optional().default("0"),
  customerCount: z.union([z.number(), z.string().trim()]).optional().default("0"),
  orderCount: z.union([z.number(), z.string().trim()]).optional().default("0"),
  totalCommissionPaid: z.union([z.number(), z.string().trim()]).optional().default("0"),
  staffName: z.string().trim().max(255).optional().default(""),
  remarks: z.string().trim().max(2000).optional().default(""),
});

module.exports = { listCommissions, idParam, skipCommission, revertCommission, bulkResolve, upsertRate, dailyReport };
