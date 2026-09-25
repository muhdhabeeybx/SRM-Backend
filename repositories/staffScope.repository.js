const { eq, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const {
  staff,
  depots,
  lpgStations,
  pfis,
  depotStaff,
  lpgStationStaff,
  pfiStaff,
  fillingStationStaff,
  deliveryCustomers,
  staffPageOverrides,
} = require("../db/schema");

/**
 * The scope + page-override context authenticateStaff attaches to every
 * request. A single round of three id-only queries — cheap, and simpler than
 * one query with two joins fanning out the row count.
 */
const getAuthContext = async (staffId) => {
  const [staffRow, depotRows, stationRows, pfiRows, overrideRows, fillingRows] = await Promise.all([
    db.select({ canViewAllLocations: staff.canViewAllLocations, roles: staff.roles }).from(staff).where(eq(staff.id, staffId)).limit(1),
    db.select({ depotId: depotStaff.depotId }).from(depotStaff).where(eq(depotStaff.staffId, staffId)),
    db.select({ lpgStationId: lpgStationStaff.lpgStationId }).from(lpgStationStaff).where(eq(lpgStationStaff.staffId, staffId)),
    db.select({ pfiId: pfiStaff.pfiId }).from(pfiStaff).where(eq(pfiStaff.staffId, staffId)),
    db.select({ routePath: staffPageOverrides.routePath, allowed: staffPageOverrides.allowed })
      .from(staffPageOverrides)
      .where(eq(staffPageOverrides.staffId, staffId)),
    db.select({ id: fillingStationStaff.deliveryCustomerId }).from(fillingStationStaff).where(eq(fillingStationStaff.staffId, staffId)),
  ]);

  // A super_admin sees everything by role, regardless of the
  // can_view_all_locations flag. That flag is a per-user location filter for
  // ordinary staff; a super admin who happens to have it unset (or who has no
  // depot/PFI assignments) must never be scoped down to nothing. This mirrors
  // Django's is_superuser bypass and is the single place scope is derived, so
  // it covers every scoped resource at once.
  const roles = staffRow[0]?.roles || [];
  const isSuperAdmin = roles.includes("super_admin");

  return {
    canViewAllLocations: isSuperAdmin || (staffRow[0]?.canViewAllLocations ?? true),
    scope: {
      depotIds: depotRows.map((r) => r.depotId),
      lpgStationIds: stationRows.map((r) => r.lpgStationId),
      pfiIds: pfiRows.map((r) => r.pfiId),
      fillingStationIds: fillingRows.map((r) => r.id),
    },
    pageOverrides: overrideRows,
  };
};

/** Same shape, plus resolved names — what the staff admin list/detail screens show. */
const getScopeWithNames = async (staffId) => {
  const [depotRows, stationRows, pfiRows, fillingRows] = await Promise.all([
    db.select({ id: depots.id, name: depots.name })
      .from(depotStaff)
      .innerJoin(depots, eq(depotStaff.depotId, depots.id))
      .where(eq(depotStaff.staffId, staffId)),
    db.select({ id: lpgStations.id, name: lpgStations.name })
      .from(lpgStationStaff)
      .innerJoin(lpgStations, eq(lpgStationStaff.lpgStationId, lpgStations.id))
      .where(eq(lpgStationStaff.staffId, staffId)),
    db.select({ id: pfis.id, pfiNumber: pfis.pfiNumber })
      .from(pfiStaff)
      .innerJoin(pfis, eq(pfiStaff.pfiId, pfis.id))
      .where(eq(pfiStaff.staffId, staffId)),
    db.select({ id: deliveryCustomers.id, name: deliveryCustomers.name })
      .from(fillingStationStaff)
      .innerJoin(deliveryCustomers, eq(fillingStationStaff.deliveryCustomerId, deliveryCustomers.id))
      .where(eq(fillingStationStaff.staffId, staffId)),
  ]);

  return {
    depotIds: depotRows.map((r) => r.id),
    depotNames: depotRows.map((r) => r.name),
    lpgStationIds: stationRows.map((r) => r.id),
    lpgStationNames: stationRows.map((r) => r.name),
    pfiIds: pfiRows.map((r) => r.id),
    pfiNumbers: pfiRows.map((r) => r.pfiNumber),
    fillingStationIds: fillingRows.map((r) => r.id),
    fillingStationNames: fillingRows.map((r) => r.name),
  };
};

/** Batched version of getScopeWithNames for the admin list screen (one query per join table, not N). */
const getScopeWithNamesForStaffIds = async (staffIds) => {
  if (!staffIds.length) return new Map();

  const [depotRows, stationRows, pfiRows, fillingRows] = await Promise.all([
    db.select({ staffId: depotStaff.staffId, id: depots.id, name: depots.name })
      .from(depotStaff)
      .innerJoin(depots, eq(depotStaff.depotId, depots.id))
      .where(inArray(depotStaff.staffId, staffIds)),
    db.select({ staffId: lpgStationStaff.staffId, id: lpgStations.id, name: lpgStations.name })
      .from(lpgStationStaff)
      .innerJoin(lpgStations, eq(lpgStationStaff.lpgStationId, lpgStations.id))
      .where(inArray(lpgStationStaff.staffId, staffIds)),
    db.select({ staffId: pfiStaff.staffId, id: pfis.id, pfiNumber: pfis.pfiNumber })
      .from(pfiStaff)
      .innerJoin(pfis, eq(pfiStaff.pfiId, pfis.id))
      .where(inArray(pfiStaff.staffId, staffIds)),
    db.select({ staffId: fillingStationStaff.staffId, id: deliveryCustomers.id, name: deliveryCustomers.name })
      .from(fillingStationStaff)
      .innerJoin(deliveryCustomers, eq(fillingStationStaff.deliveryCustomerId, deliveryCustomers.id))
      .where(inArray(fillingStationStaff.staffId, staffIds)),
  ]);

  const byStaff = new Map(
    staffIds.map((id) => [id, {
      depotIds: [], depotNames: [], lpgStationIds: [], lpgStationNames: [], pfiIds: [], pfiNumbers: [],
      fillingStationIds: [], fillingStationNames: [],
    }])
  );
  for (const r of depotRows) {
    const entry = byStaff.get(r.staffId);
    entry.depotIds.push(r.id);
    entry.depotNames.push(r.name);
  }
  for (const r of stationRows) {
    const entry = byStaff.get(r.staffId);
    entry.lpgStationIds.push(r.id);
    entry.lpgStationNames.push(r.name);
  }
  for (const r of pfiRows) {
    const entry = byStaff.get(r.staffId);
    entry.pfiIds.push(r.id);
    entry.pfiNumbers.push(r.pfiNumber);
  }
  for (const r of fillingRows) {
    const entry = byStaff.get(r.staffId);
    entry.fillingStationIds.push(r.id);
    entry.fillingStationNames.push(r.name);
  }
  return byStaff;
};

const getPageOverrides = async (staffId) => {
  const rows = await db
    .select({ routePath: staffPageOverrides.routePath, allowed: staffPageOverrides.allowed })
    .from(staffPageOverrides)
    .where(eq(staffPageOverrides.staffId, staffId));
  return rows;
};

/**
 * Batched version of getPageOverrides for the admin list screen.
 *
 * The list feeds the edit form directly via router state (no per-row detail
 * fetch), so it has to carry the same fields getAdminById does — leaving this
 * out means a save made from a list-opened edit, which starts from an empty
 * override map, silently wipes any overrides the row never showed it.
 */
const getPageOverridesForStaffIds = async (staffIds) => {
  const byStaff = new Map(staffIds.map((id) => [id, []]));
  if (!staffIds.length) return byStaff;

  const rows = await db
    .select({ staffId: staffPageOverrides.staffId, routePath: staffPageOverrides.routePath, allowed: staffPageOverrides.allowed })
    .from(staffPageOverrides)
    .where(inArray(staffPageOverrides.staffId, staffIds));

  for (const r of rows) {
    byStaff.get(r.staffId)?.push({ routePath: r.routePath, allowed: r.allowed });
  }
  return byStaff;
};

/** Replaces this staff member's rows in all four scope join tables. */
const setScope = async (staffId, { depotIds = [], lpgStationIds = [], pfiIds = [], fillingStationIds = [] } = {}) => {
  await db.transaction(async (tx) => {
    await tx.delete(depotStaff).where(eq(depotStaff.staffId, staffId));
    if (depotIds.length) {
      await tx.insert(depotStaff).values(depotIds.map((depotId) => ({ depotId, staffId })));
    }

    await tx.delete(lpgStationStaff).where(eq(lpgStationStaff.staffId, staffId));
    if (lpgStationIds.length) {
      await tx.insert(lpgStationStaff).values(lpgStationIds.map((lpgStationId) => ({ lpgStationId, staffId })));
    }

    await tx.delete(pfiStaff).where(eq(pfiStaff.staffId, staffId));
    if (pfiIds.length) {
      await tx.insert(pfiStaff).values(pfiIds.map((pfiId) => ({ pfiId, staffId })));
    }

    await tx.delete(fillingStationStaff).where(eq(fillingStationStaff.staffId, staffId));
    if (fillingStationIds.length) {
      await tx.insert(fillingStationStaff).values(
        fillingStationIds.map((deliveryCustomerId) => ({ deliveryCustomerId, staffId })),
      );
    }
  });
};

/** Replaces this staff member's page overrides. `overrides` is [{routePath, allowed}]. */
const setPageOverrides = async (staffId, overrides = []) => {
  await db.transaction(async (tx) => {
    await tx.delete(staffPageOverrides).where(eq(staffPageOverrides.staffId, staffId));
    if (overrides.length) {
      await tx.insert(staffPageOverrides).values(
        overrides.map((o) => ({ staffId, routePath: o.routePath, allowed: !!o.allowed }))
      );
    }
  });
};

module.exports = {
  getAuthContext,
  getScopeWithNames,
  getScopeWithNamesForStaffIds,
  getPageOverrides,
  getPageOverridesForStaffIds,
  setScope,
  setPageOverrides,
};
