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
 * A TRANSFER: an allocation order nobody has paid for, and nobody will.
 *
 * Since 8 October 2026 an allocation is placed on credit, because it is the
 * company moving stock from a cargo to its own trucking PFI — not a sale. Its
 * litres leave the parent as "Trucked out" and are nowhere else on the
 * parent: not sold, not awaiting payment, not owed, not on the finance
 * report. The parent closes on initial stock − sold − trucked out.
 *
 * A PAID allocation order is not a transfer. PFI/47C (order 12313) was paid by
 * a bank line before the on-credit rule existed, and the user chose to leave it
 * exactly as it was matched: a sale, counted in the parent's sales value.
 *
 * Plain SQL text over a table alias, so a postgres.js query
 * (`client.unsafe(transferSql("o"))`) and a drizzle one (`sql.raw(...)`) build
 * from the same words rather than from two copies of them.
 */
const transferSql = (alias = "o") =>
  // COALESCE, or an order with no key (most of them) reads as NULL here and
  // `NOT transfer` silently drops it from whatever is being counted.
  `(COALESCE(${alias}.idempotency_key, '') LIKE '${PREFIX}%'` +
  ` AND ${alias}.payment_status::text <> 'Paid'` +
  ` AND COALESCE(${alias}.status::text, '') NOT IN ('Cancelled', 'Expired'))`;

/** The same rule over a row already in hand. */
const isTransferOrder = (order) =>
  isAllocationOrder(order) &&
  String(order?.paymentStatus ?? order?.payment_status ?? "") !== "Paid" &&
  !["Cancelled", "Expired"].includes(String(order?.status ?? ""));

module.exports = { PREFIX, orderKey, isAllocationOrder, transferSql, isTransferOrder };
