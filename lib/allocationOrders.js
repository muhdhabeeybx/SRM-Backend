/**
 * The order a truck allocation's approval places on its parent cargo.
 *
 * It is keyed `pfi-allocation:<id>` (services/pfiAllocation.service.js), and
 * that key is on the order row itself — so every rule that must treat these
 * orders differently can tell them apart from the row it already holds,
 * without a join and without the allocations table having to exist yet.
 *
 * What is different about them: the litres they sold are the trucking PFI's
 * whole stock. Anything that hands them back to the parent — lapsing unpaid
 * overnight, a cancel, being merged away — while the trucking PFI still holds
 * them would count the same litres on two shelves. So they never lapse, and a
 * cancel or merge is refused while the trucking PFI exists.
 */
const PREFIX = "pfi-allocation:";

const orderKey = (allocationId) => `${PREFIX}${allocationId}`;

/** Accepts a drizzle row (camelCase) or a raw SQL row (snake_case). */
const isAllocationOrder = (order) =>
  String(order?.idempotencyKey ?? order?.idempotency_key ?? "").startsWith(PREFIX);

/**
 * A TRUCKING order: an allocation order that is still live — paid, part paid
 * or nothing paid yet.
 *
 * It is the company moving stock from a cargo to its own trucking PFI. Its
 * litres leave the parent as "Trucking", beside the parent's depot sales, and
 * the two add up to its Total sold. It is never a depot sale, never awaiting
 * payment, and never owed by a customer. The parent closes on initial stock −
 * depot sales − trucking, whether or not anything has been paid on it.
 *
 * It is placed on credit (since 8 October 2026), and money can be matched to
 * it like any order (since 16 October 2026) — a transfer from the company's
 * own account into the parent's, as PFI/47C's was. A payment moves only the
 * money: what is received on it, and what is still on credit. Its litres stay
 * under Trucking, so paying it never moves a figure from one heading to
 * another. Until 16 October a PAID allocation order (47C's) read as a depot
 * sale instead; it now reads as the trucking it was, and the parent's Total
 * sold is the same figure either way.
 *
 * The names keep their old wording ("transfer") so the readers that already
 * use them need no rename; the rule is the one above.
 *
 * Plain SQL text over a table alias, so a postgres.js query
 * (`client.unsafe(transferSql("o"))`) and a drizzle one (`sql.raw(...)`) build
 * from the same words rather than from two copies of them.
 */
const transferSql = (alias = "o") =>
  // COALESCE, or an order with no key (most of them) reads as NULL here and
  // `NOT transfer` silently drops it from whatever is being counted.
  `(COALESCE(${alias}.idempotency_key, '') LIKE '${PREFIX}%'` +
  ` AND COALESCE(${alias}.status::text, '') NOT IN ('Cancelled', 'Expired'))`;

/** The same rule over a row already in hand. */
const isTransferOrder = (order) =>
  isAllocationOrder(order) && !["Cancelled", "Expired"].includes(String(order?.status ?? ""));

module.exports = { PREFIX, orderKey, isAllocationOrder, transferSql, isTransferOrder };
