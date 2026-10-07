const z = require("zod");
const { id } = require("./fields");

/** LPG plant deliveries — services/lpgDelivery.service.js checks every field. */

const cell = z.union([z.string().max(1000), z.number(), z.null()]).optional();
const delivery = z.object({
  truckId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  truckNumber: cell,
  driverName: cell,
  pfi: cell,
  pfiId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  dateLoaded: cell,
  dateDelivered: cell,
  kgLoaded: cell,
  kgReceived: cell,
  costPerKg: cell,
  note: cell,
});

const record = z.object({
  plantId: id("Plant"),
  dryRun: z.boolean().optional(),
  rows: z.array(delivery).min(1, "No deliveries to record").max(2000, "Too many rows in one go — split the file"),
});
const list = z.object({ plant: id("Plant") });
const idParam = z.object({ id: id("Delivery") });
const update = delivery.partial();

module.exports = { record, list, idParam, update };
