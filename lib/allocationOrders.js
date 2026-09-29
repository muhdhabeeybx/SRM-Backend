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

module.exports = { PREFIX, orderKey, isAllocationOrder };
