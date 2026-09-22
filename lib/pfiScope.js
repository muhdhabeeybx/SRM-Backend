const { client } = require("../config/db");
const { scopedPfiIds } = require("./pfiBankScope");

/**
 * A person assigned to a PFI sees that PFI's world, and nothing else.
 *
 * This is the one module every area asks. It does not redefine who is
 * confined — that is scopedPfiIds in lib/pfiBankScope.js, identical to the
 * rule lib/scopeFilter.js has always applied to orders: no
 * can_view_all_locations and at least one PFI assignment. Super admins are
 * never confined (staffScope.repository gives them can_view_all_locations).
 *
 * ── Two kinds of area ──────────────────────────────────────────────────────
 *
 *   Linked to a PFI    orders, refunds, truck sales, deliveries, tickets, the
 *                      gate, customers, daily reports, the dashboard. These
 *                      are FILTERED to the person's PFIs, and a write outside
 *                      them is refused.
 *
 *   Not linked to one  contacts and leads, merging people, Dangote and LPG
 *                      requests, filing stations, the expiry and settlement
 *                      jobs. There is nothing to filter them by, so the only
 *                      answer that keeps a PFI person inside their PFI is
 *                      "not available to you" — denyPfiScoped.
 *
 * ── Why refusals say "not found" on reads ──────────────────────────────────
 *
 * Reading one record outside the person's PFI answers 404, not 403. "You may
 * not see it" confirms it exists; "not found" tells them nothing. Writes and
 * whole areas answer 403, because there the person needs to know why.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** True when this person is confined to PFIs. */
const isConfined = (user) => scopedPfiIds(user) !== null;

/**
 * Route guard for areas with no PFI link. Put it after verifyStaff.
 */
const denyPfiScoped = (req, res, next) => {
  if (!isConfined(req.user)) return next();
  return res.status(403).json({
    success: false,
    message: "This isn't available to staff assigned to a PFI.",
  });
};

/**
 * A postgres.js fragment narrowing a PFI column to this person's PFIs, or an
 * empty fragment when they are not confined. For raw SQL:
 *
 *   WHERE ... ${pfiFilter(user, "o.pfi_id")}
 *
 * The column name is fixed by the calling code, never user input.
 */
const pfiFilter = (user, column) => {
  const ids = scopedPfiIds(user);
  if (!ids) return client``;
  return client`AND ${client.unsafe(column)} = ANY(${ids}::int[])`;
};

/**
 * The allocation codes a confined person may see, or null when unrestricted.
 *
 * A delivery batch is not a row — it is every delivery_inventory row sharing
 * a code — so a truck sale reaches its PFI through its code: either the
 * batch's truck rows name the PFI (PFI-14B's trucks point at PFI/14, the
 * cargo they were drawn from), or the PFI itself holds the code (a trucking
 * PFI). Codes are compared trimmed and upper-cased, the way every delivery
 * screen groups them.
 */
const allocationCodesFor = async (user) => {
  const ids = scopedPfiIds(user);
  if (!ids) return null;
  const rows = await client`
    SELECT DISTINCT upper(trim(allocation_code)) AS code
      FROM delivery_inventory
     WHERE pfi_id = ANY(${ids}::int[]) AND nullif(trim(allocation_code), '') IS NOT NULL
    UNION
    SELECT DISTINCT upper(trim(allocation_code))
      FROM pfis
     WHERE id = ANY(${ids}::int[]) AND nullif(trim(allocation_code), '') IS NOT NULL`;
  return rows.map((r) => r.code);
};

/** Refuse (404) a single order this person may not see. */
const assertOrderVisible = async (user, orderId) => {
  const ids = scopedPfiIds(user);
  if (!ids) return;
  const [row] = await client`SELECT pfi_id FROM orders WHERE id = ${Number(orderId)}`;
  if (!row || row.pfi_id == null || !ids.includes(Number(row.pfi_id))) {
    throw httpError(404, "Order not found");
  }
};

/**
 * The customers a confined person may see: those with at least one order on
 * one of their PFIs. A customer buying from several PFIs is visible to each
 * PFI's staff, and to each only through that PFI's orders.
 */
const customerIdsFor = async (user) => {
  const ids = scopedPfiIds(user);
  if (!ids) return null;
  const rows = await client`
    SELECT DISTINCT customer_id FROM orders
     WHERE pfi_id = ANY(${ids}::int[]) AND customer_id IS NOT NULL`;
  return rows.map((r) => Number(r.customer_id));
};

/** Refuse (404) a customer this person may not see. */
const assertCustomerVisible = async (user, customerId) => {
  const allowed = await customerIdsFor(user);
  if (allowed === null) return;
  if (!allowed.includes(Number(customerId))) throw httpError(404, "Customer not found");
};

module.exports = {
  scopedPfiIds,
  isConfined,
  denyPfiScoped,
  pfiFilter,
  allocationCodesFor,
  assertOrderVisible,
  customerIdsFor,
  assertCustomerVisible,
};
