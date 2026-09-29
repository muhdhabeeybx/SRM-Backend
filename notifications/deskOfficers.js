const { and, eq, inArray, arrayOverlaps } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff, pfiStaff, depotStaff } = require("../db/schema");

/**
 * Who holds a desk for one PFI — the people a step's text goes to.
 *
 * An order moves desk to desk: finance confirms the money, ticketing writes
 * the tickets, security admits and releases the trucks. Each move tells the
 * NEXT desk, and "the desk" for an order is the officers of that role assigned
 * to the order's PFI, not everybody in the company who holds the role. A
 * finance officer on PFI 39/26 has no use for PFI 42's orders.
 *
 * When nobody with the role is on the PFI, the step must not go silent — that
 * is exactly when an order gets stuck. It falls back, in order, to:
 *
 *   1. the role's company-wide holders: nobody on any PFI, and either no
 *      depots or this order's depot among theirs (the rule the order list's
 *      scope uses, lib/scopeFilter.js);
 *   2. the admins, so somebody notices the PFI has nobody on that desk.
 *
 * Suspended and deactivated accounts never count, at any tier.
 *
 * @param {object} opts
 * @param {number|null} opts.pfiId
 * @param {number|null} [opts.depotId]
 * @param {string[]} opts.roles     the desk — any one of these roles holds it
 * @returns {Promise<Array<object>>} recipient specs for notify()'s `to`
 */
const officersFor = async ({ pfiId, depotId = null, roles }) => {
  const admins = [{ roles: ["admin", "super_admin"] }];
  if (!roles?.length) return admins;

  const holders = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(arrayOverlaps(staff.roles, roles), eq(staff.isActive, true), eq(staff.suspended, false)));
  if (!holders.length) return admins;

  const ids = holders.map((h) => Number(h.id));
  const [pfiRows, depotRows] = await Promise.all([
    db.select({ staffId: pfiStaff.staffId, id: pfiStaff.pfiId }).from(pfiStaff).where(inArray(pfiStaff.staffId, ids)),
    db.select({ staffId: depotStaff.staffId, id: depotStaff.depotId }).from(depotStaff).where(inArray(depotStaff.staffId, ids)),
  ]);

  const byStaff = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(Number(r.staffId), [...(m.get(Number(r.staffId)) || []), Number(r.id)]);
    return m;
  };
  const pfisOf = byStaff(pfiRows);
  const depotsOf = byStaff(depotRows);

  if (pfiId != null) {
    const onPfi = ids.filter((id) => (pfisOf.get(id) || []).includes(Number(pfiId)));
    if (onPfi.length) return onPfi.map((staffId) => ({ staffId }));
  }

  const companyWide = ids.filter((id) => {
    if ((pfisOf.get(id) || []).length) return false;
    const depots = depotsOf.get(id) || [];
    return !depots.length || (depotId != null && depots.includes(Number(depotId)));
  });
  if (companyWide.length) return companyWide.map((staffId) => ({ staffId }));

  return admins;
};

/** The desks, by the roles that hold them. One list, so a desk is named once. */
const DESK_ROLES = Object.freeze({
  finance: ["finance"],
  tickets: ["ticketing", "dispatch"],
  gateIn: ["security_entry"],
  gateOut: ["security_exit"],
  truckSales: ["truck_sales"],
});

module.exports = { officersFor, DESK_ROLES };
