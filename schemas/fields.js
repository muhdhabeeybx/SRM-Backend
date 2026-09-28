const z = require("zod");

/**
 * Shared field types.
 *
 * Every helper takes a human `label` and generates its own messages from it.
 * Zod's defaults are accurate but written for a developer reading a stack
 * trace — "Invalid input: expected string, received undefined" tells an end
 * user nothing about what to do. Generating from a label keeps the wording
 * consistent across ~20 schemas without hand-writing several hundred strings,
 * and means a field renamed in one place cannot drift from its message.
 *
 * Zod 4 replaced v3's `required_error` / `invalid_type_error` with a single
 * `error` parameter. Given a function it receives the issue, and
 * `iss.input === undefined` is what distinguishes "you left this out" from
 * "you sent the wrong sort of thing" — a distinction the caller can act on.
 */

/** "you left it out" vs "you sent the wrong type", from one label. */
const typeError = (label, expected) => (iss) =>
  iss.input === undefined ? `${label} is required` : `${label} must be ${expected}`;

/**
 * Coercion here is deliberately narrower than `z.coerce`. Zod's built-in
 * coercion applies JavaScript's `Number()` semantics, which accepts far more
 * than anyone intends:
 *
 *   z.coerce.number().parse("")     ->  0
 *   z.coerce.number().parse(null)   ->  0
 *   z.coerce.number().parse(true)   ->  1
 *   z.coerce.number().parse([])     ->  0
 *   z.coerce.number().parse([5])    ->  5
 *   z.coerce.number().parse("0x10") ->  16
 *
 * So `{"quantity": []}` becomes an order for zero litres, and `{"balance":
 * true}` becomes one naira. Every one of those is silently accepted.
 *
 * `numberLike` accepts only a real finite number, or a string that actually
 * looks like one. Clients still get the convenience of sending "500" from a
 * form field; they do not get null, booleans or arrays turning into numbers
 * behind their back.
 */
const numberLike = (label) =>
  z.union(
    [
      z.number().finite(),
      z
        .string()
        .trim()
        .regex(/^-?\d+(\.\d+)?$/, `${label} must be a number`)
        .transform(Number),
    ],
    { error: typeError(label, "a number") }
  );

/** A database id: positive integer. Rejects "abc" before it reaches Postgres. */
const id = (label = "id") =>
  numberLike(label).pipe(
    z.number().int(`${label} must be a whole number`).positive(`${label} must be a valid id`)
  );

/** Litres, units — a whole positive count. For orders, which are sold in whole litres. */
const quantity = (label = "Quantity") =>
  numberLike(label).pipe(
    z
      .number()
      .int(`${label} must be a whole number`)
      .positive(`${label} must be greater than zero`)
  );

/**
 * A measured volume — litres off a pump meter or a dip — which is not a whole
 * number: a filling station's day reads 12,345.67 litres, and making the desk
 * round it made the sheet disagree with the meter.
 *
 * Up to three decimal places, the finest any meter here reads. Positive, and
 * capped well above any real day so a slipped key is caught.
 */
const volume = (label = "Volume") =>
  numberLike(label).pipe(
    z
      .number()
      .positive(`${label} must be greater than zero`)
      .max(100_000_000, `${label} is too large`)
      .refine((n) => Number.isInteger(Math.round(n * 1000 * 1e6) / 1e6), `${label} can have at most 3 decimal places`)
  );

/**
 * Money for a Postgres `numeric(15,2)` column.
 *
 * Kept in string space end to end rather than round-tripped through a float:
 * the driver takes a string, and passing a JS number risks precision loss on
 * the way in. `multipleOf(0.01)` is not used — it is unreliable at floating
 * point boundaries, which is exactly where money errors hide.
 *
 * numeric(15,2) is 15 digits of precision with 2 after the point, so at most
 * 13 before it. Anything larger is rejected here rather than by the database.
 */
const MAX_INTEGER_DIGITS = 13;

const money = (label = "Amount", { min = 0 } = {}) => {
  let inner = z
    .string()
    .regex(
      /^\d+(\.\d{1,2})?$/,
      `${label} must be a positive amount with at most 2 decimal places`
    )
    .refine(
      (s) => s.split(".")[0].replace(/^0+(?=\d)/, "").length <= MAX_INTEGER_DIGITS,
      `${label} is too large`
    );

  // Only when a floor above zero is required. The regex already excludes
  // negatives, so a `>= 0` refine would fire alongside it and report the same
  // field twice — two messages for one mistake reads as two mistakes.
  if (min > 0) {
    inner = inner.refine((s) => Number(s) >= min, `${label} must be at least ${min}`);
  }

  return z
    .union([z.number().finite(), z.string().trim()], { error: typeError(label, "an amount") })
    .transform((v) => (typeof v === "number" ? v.toFixed(2) : v))
    // Normalise so the driver always receives the same shape.
    .pipe(inner.transform((s) => Number(s).toFixed(2)));
};

/** Text that must actually contain something. */
const requiredString = (label, max = 255) =>
  z
    .string({ error: typeError(label, "text") })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

/** Absent, or non-empty once trimmed. Absent becomes "" for the database. */
const optionalString = (label, max = 255) =>
  z
    .string({ error: typeError(label, "text") })
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .optional()
    .transform((v) => v ?? "");

/** An optional email, or the empty string that several columns default to. */
const optionalEmail = (label = "Email") =>
  z
    .string({ error: typeError(label, "text") })
    .trim()
    .max(255, `${label} must be 255 characters or fewer`)
    .email(`${label} must be a valid email address`)
    .optional()
    .or(z.literal(""));

/**
 * An enum whose message lists what is actually allowed, rather than leaving
 * the caller to guess from a rejection.
 */
const enumOf = (label, values) =>
  z.enum(values, {
    error: (iss) =>
      iss.input === undefined
        ? `${label} is required`
        : `${label} must be one of: ${values.join(", ")}`,
  });

/** Pagination shared by every list endpoint. */
// 1000, not the old 500: the dashboard's list pages ask for a page of 1000
// so a desk can see a whole book at once rather than clicking through it.
// Repositories still clamp to their own ceiling on top of this.
const pagination = z.object({
  page: numberLike("Page")
    .pipe(z.number().int("Page must be a whole number").positive("Page must be 1 or greater"))
    .optional()
    .default(1),
  limit: numberLike("Limit")
    .pipe(
      z
        .number()
        .int("Limit must be a whole number")
        .positive("Limit must be 1 or greater")
        .max(1000, "Limit cannot exceed 1000")
    )
    .optional()
    .default(50),
});

/** Free-text search box — bounded, never required. */
const searchTerm = z.string().trim().max(200, "Search term is too long").optional();

module.exports = {
  typeError,
  numberLike,
  id,
  quantity,
  volume,
  money,
  requiredString,
  optionalString,
  optionalEmail,
  enumOf,
  pagination,
  searchTerm,
  MAX_INTEGER_DIGITS,
};
