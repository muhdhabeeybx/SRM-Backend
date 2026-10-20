const { z } = require("zod");
const { numberLike, id, optionalString } = require("./fields");

/**
 * The AGO stock ledger (services/agoStock.service.js). Litres to two decimal
 * places, the column's own precision, and capped well above any tank so a
 * slipped key is caught here rather than taking the book down by a million.
 */
const litres = (label = "AGO litres") =>
  numberLike(label).pipe(
    z
      .number()
      .positive(`${label} must be more than nothing`)
      .max(10_000_000, `${label} is too large`)
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, `${label} can have at most 2 decimal places`),
  );

const day = (label = "Date") => z.string({ error: `${label} is required` }).date(`${label} is not a date`);
const description = optionalString("Description", 1000);
/** Left out means "as it is" — optionalString would make it "" and wipe it. */
const keepOrSet = (label) => z.string({ error: `${label} must be text` }).trim().max(1000, `${label} must be 1000 characters or fewer`).optional();

const entryParam = z.object({ entryId: z.coerce.number().int().positive() });

const stockBody = z.object({
  kind: z.enum(["opening", "received", "adjust_in", "adjust_out"], { error: "Say what kind of stock entry this is" }),
  entryDate: day(),
  litres: litres(),
  description,
});

const giveBody = z.object({
  entryDate: day(),
  /** Said once for the batch; a truck's own description beats it. */
  description,
  trucks: z
    .array(
      z
        .object({
          /** A load on Delivery Inventory. */
          tripId: id("Trip").optional(),
          /** A fleet truck on no trip — then what it carried and its PFI, if any. */
          truckId: id("Truck").optional(),
          truckQty: litres("Truck's quantity").nullish(),
          pfiId: id("PFI").nullish(),
          litres: litres(),
          description: keepOrSet("Description"),
        })
        .refine((t) => Boolean(t.tripId) !== Boolean(t.truckId), "Pick each truck from a PFI, or one truck on no PFI"),
    )
    .min(1, "Give AGO to at least one truck")
    .max(200, "At most 200 trucks at once"),
});

const changeBody = z.object({
  kind: z.enum(["top_up", "retrieved"], { error: "Say whether this is a top-up or a retrieval" }),
  entryDate: day(),
  litres: litres(),
  description,
});

const updateBody = z
  .object({
    entryDate: day().optional(),
    litres: litres().optional(),
    description: keepOrSet("Description"),
    /** AGO given only: the trip it was for. */
    tripId: id("Trip").optional(),
    /** AGO given to a truck on no trip: what it carried. */
    truckQty: litres("Truck's quantity").nullish(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change");

module.exports = { entryParam, stockBody, giveBody, changeBody, updateBody };
