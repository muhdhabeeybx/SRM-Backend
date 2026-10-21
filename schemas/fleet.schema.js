const { z } = require("zod");

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const documentSchema = z.object({
  kind: z.string().min(1).max(50),
  name: z.string().max(255).default(""),
  url: z.string().max(2000),
  uploadedAt: z.string().datetime().optional(),
});

const createFleetTruckSchema = z.object({
  plateNumber: z.string().min(2).max(50),
  truckMake: z.string().max(255).optional(),
  chassisNumber: z.string().max(255).optional(),
  maxCapacity: z.coerce.number().int().positive().max(100000).nullable().optional(),
  fuelCapacity: z.coerce.number().positive().nullable().optional(),
  avgLitresPerTrip: z.coerce.number().positive().nullable().optional(),
  mileage: z.coerce.number().int().nonnegative().nullable().optional(),
  // A real driver record. Nullable — a one-off stand-in is just a name.
  driverId: z.coerce.number().int().positive().nullable().optional(),
  driverName: z.string().max(255).optional(),
  driverPhone: z.string().max(50).optional(),
  driverAltPhone: z.string().max(50).optional(),
  motorBoyName: z.string().max(255).optional(),
  motorBoyPhone: z.string().max(50).optional(),
  spareDriverName: z.string().max(255).optional(),
  spareDriverPhone: z.string().max(50).optional(),
  // Vehicle identity, absorbed from the old `trucks` table.
  vin: z.string().max(50).optional(),
  year: z.coerce.number().int().min(1950).max(2100).nullable().optional(),
  model: z.string().max(100).optional(),
  truckType: z.string().max(100).optional(),
  fuelLevel: z.coerce.number().int().min(0).max(100).nullable().optional(),
  registrationExpiry: z.string().date().nullable().optional(),
  nextServiceMileage: z.coerce.number().int().nonnegative().nullable().optional(),
  insuranceExpiry: z.string().date().nullable().optional(),
  roadWorthinessExpiry: z.string().date().nullable().optional(),
  lastServiceDate: z.string().date().nullable().optional(),
  nextServiceDate: z.string().date().nullable().optional(),
  documents: z.array(documentSchema).max(20).optional(),
  passportPhoto: z.string().max(500000).optional(),
  truckStatus: z.string().max(500).optional(),
  incidents: z.string().max(100000).optional(),
  notes: z.string().max(5000).optional(),
  // Hired, not ours (0094) — and whose it is.
  isThirdParty: z.boolean().optional(),
  ownerName: z.string().trim().max(255).optional(),
});

/**
 * A hired truck added where it is first needed — allocating trucks off a PFI.
 * Only what loading it takes: the plate, what it holds, who drives it, and
 * whose it is. The rest can be filled in on the Fleet page later.
 */
const thirdPartyTruckSchema = z.object({
  plateNumber: z.string().trim().min(2).max(50),
  maxCapacity: z.coerce.number().int().positive().max(100000).nullable().optional(),
  driverName: z.string().trim().max(255).optional(),
  driverPhone: z.string().trim().max(50).optional(),
  ownerName: z.string().trim().max(255).optional(),
});

const updateFleetTruckSchema = createFleetTruckSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const fleetQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  // The pickers load the whole register; hired trucks (0094) take it past 100.
  limit: z.coerce.number().int().positive().max(1000).default(50),
  search: z.string().max(100).optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sort: z.enum(["plateNumber", "createdAt", "mileage", "nextServiceDate"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

// Same shape as the Django FleetLedgerEntry form: expense|income, free-text
// category, amount, business date.
const fleetLedgerEntrySchema = z.object({
  entryType: z.enum(["expense", "income"]),
  category: z.string().min(1).max(100),
  amount: z.coerce.number().positive().max(1000000000),
  entryDate: z.string().date(),
  description: z.string().max(5000).optional(),
});

/**
 * A batch posting: one fully-resolved line per truck.
 *
 * Lines are spelled out rather than expressed as "these fields × those
 * trucks", because the screen lets the operator vary the amount and the
 * description per truck before committing, and the server must store the set
 * they actually approved. The 200 cap is a fat-finger guard — no real fleet
 * posts more in one go.
 */
const fleetLedgerBatchSchema = z.object({
  entries: z
    .array(
      z.object({
        truckId: z.coerce.number().int().positive(),
        entryType: z.enum(["expense", "income"]),
        category: z.string().min(1).max(100),
        amount: z.coerce.number().positive().max(1000000000),
        entryDate: z.string().date(),
        description: z.string().max(5000).optional(),
      })
    )
    .min(1)
    .max(200),
});

const fleetLedgerQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  entryType: z.enum(["expense", "income"]).optional(),
  category: z.string().max(100).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});

module.exports = {
  idParamSchema,
  createFleetTruckSchema,
  updateFleetTruckSchema,
  thirdPartyTruckSchema,
  fleetQuerySchema,
  fleetLedgerEntrySchema,
  fleetLedgerBatchSchema,
  fleetLedgerQuerySchema,
};
