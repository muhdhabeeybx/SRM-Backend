/**
 * A person assigned filling stations sees those stations, and no others.
 *
 * The same rule lib/scopeFilter.js applies to depots, LPG plants and PFIs:
 * full-access users and anybody with NO stations assigned are not narrowed at
 * all — an empty assignment never reads as "nothing" (see the note there on
 * why an empty page is the one outcome that must not happen by itself).
 *
 * Stations are delivery_customers rows (customer_type 'filling_station'), so
 * the ids here are delivery_customers ids, as in filling_station_staff.
 */

/** The station ids this person is confined to, or null when they are not. */
const scopedStationIds = (user) => {
  if (!user || user.canViewAllLocations) return null;
  const ids = (user.scope?.fillingStationIds || []).map(Number).filter(Number.isFinite);
  return ids.length ? ids : null;
};

/** May this person see this station (or a row belonging to it)? */
const stationVisible = (user, stationId) => {
  const ids = scopedStationIds(user);
  return ids === null || ids.includes(Number(stationId));
};

module.exports = { scopedStationIds, stationVisible };
