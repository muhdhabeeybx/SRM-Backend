/**
 * A person assigned filling stations sees those stations, and no others —
 * and a person assigned LPG plants sees those plants' accounts (below).
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

/**
 * The LPG plants this person is confined to, as lpg_stations ids — or null.
 *
 * An LPG plant registered as a delivery customer (customer_type 'lpg_plant',
 * migration 0061) can be linked to the lpg_stations row it is. People are
 * already assigned plants that way (lpg_station_staff), so that assignment is
 * what narrows the plant accounts too: a plant manager sees their plant's
 * account and no other plant's, with nothing new to set up.
 *
 * The same rule as stations: no plants assigned is not narrowed at all. A
 * plant not linked to any lpg_stations row — one that is not ours — is seen
 * only by people who are not confined to plants.
 */
const scopedPlantIds = (user) => {
  if (!user || user.canViewAllLocations) return null;
  const ids = (user.scope?.lpgStationIds || []).map(Number).filter(Number.isFinite);
  return ids.length ? ids : null;
};

/** May this person see this LPG plant account? Takes the customer row. */
const plantVisible = (user, plant) => {
  const ids = scopedPlantIds(user);
  if (ids === null) return true;
  return plant?.lpgStationId != null && ids.includes(Number(plant.lpgStationId));
};

module.exports = { scopedStationIds, stationVisible, scopedPlantIds, plantVisible };
