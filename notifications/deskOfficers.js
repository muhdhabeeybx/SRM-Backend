const { and, eq, inArray, arrayOverlaps } = require("drizzle-orm");
const { db } = require("../config/db");
const { staff, pfis, pfiStaff } = require("../db/schema");

/**
 * Who holds a desk for one PFI — the people a step's text goes to.
 *
 * An order moves desk to desk: finance confirms the money, ticketing writes
 * the tickets, security admits and releases the trucks. Each move tells the
 * NEXT desk, and "the desk" is, in order:
 *
 *   1. the officer the PFI names for that job, and nobody else — a sales
 *      manager on the PFI who also holds the finance role is not its finance;
 *   2. where that job's slot is empty, whoever holds the role and is assigned
 *      to this PFI on Manage Users. Slots for ticketing, the gates and stock
 *      only came with migration 0096, so many desks are still held this way.
 *
 * It stops there. Nobody else on the company's books is told, and neither are
 * the admins (the owner, 30 Oct 2026: too many messages, sent to people who had
 * nothing to do with them). A desk with nobody on it texts nobody; the bell and
 * the work queues still show the work.
 *
 * Suspended and deactivated accounts are never told.
 *
 * @param {object} opts
 * @param {number|null} opts.pfiId
 * @param {{slots: string[], roles: string[]}} opts.desk  one of DESKS below
 * @returns {Promise<Array<object>>} recipient specs for notify()'s `to`
 */
const officersFor = async ({ pfiId, desk }) => {
  if (pfiId == null) return [];
  const live = and(eq(staff.isActive, true), eq(staff.suspended, false));

  const [pfi] = await db.select().from(pfis).where(eq(pfis.id, Number(pfiId))).limit(1);
  const named = [...new Set(desk.slots.map((key) => Number(pfi?.[key])).filter((id) => Number.isInteger(id) && id > 0))];
  const officers = named.length
    ? await db.select({ id: staff.id }).from(staff).where(and(inArray(staff.id, named), live))
    : [];
  if (officers.length) return officers.map((p) => ({ staffId: Number(p.id) }));

  const assigned = await db
    .select({ id: staff.id })
    .from(staff)
    .innerJoin(pfiStaff, eq(pfiStaff.staffId, staff.id))
    .where(and(eq(pfiStaff.pfiId, Number(pfiId)), arrayOverlaps(staff.roles, desk.roles), live));
  return assigned.map((p) => ({ staffId: Number(p.id) }));
};

/** The desks: the PFI slots that name them (lib/pfiSlots.js), and the roles that hold them. One list, so a desk is named once. */
const DESKS = Object.freeze({
  finance: { slots: ["auditOfficerId"], roles: ["finance"] },
  tickets: { slots: ["ticketingOfficerId"], roles: ["ticketing", "dispatch"] },
  gateIn: { slots: ["gateEntryOfficerId"], roles: ["security_entry"] },
  gateOut: { slots: ["securityExitOfficerId"], roles: ["security_exit"] },
  truckSales: { slots: ["salesManagerId", "truckSalesOfficerId"], roles: ["truck_sales"] },
  // Picks the gantry tickets a paid order is sold on (gantry PFIs on a ticket register).
  stock: { slots: ["stockOfficerId"], roles: ["stock_officer"] },
});

module.exports = { officersFor, DESKS };
