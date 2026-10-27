const { client } = require("../config/db");
const { scopedStationIds, scopedPlantIds } = require("./stationScope");

/**
 * What a truck given to a station cost us, for the people who run that
 * station (the owner, 26 Oct 2026: David Andrew, confined to the seven
 * filling stations, read "Not costed" on every PFI of his stations).
 *
 * Trip costs reach only those who may open Delivery Costing
 * (deliveryInventory.controller maySeeCosts). A station's profit is its
 * takings less what its trucks cost us landed, so somebody confined to
 * stations or LPG plants is given exactly that — the landed cost, product
 * price and cost per litre — on the trucks their own stations were given,
 * and nothing else: not the diesel, feeding or haulage behind it, not the
 * margins, and not any other station's or batch's trucks.
 *
 * A truck is a station's the way its page reads it (lib/station-account
 * loadingsForStation): assigned to the station, or carrying a sale to it on
 * the same plate and day.
 */
const STATION_COST_FIELDS = ["landingCost", "productPrice", "costPerLitre"];

/** The station (delivery customer) ids this person runs, or null when they run none. */
async function ownStationIds(user) {
  const stations = scopedStationIds(user) || [];
  const plants = scopedPlantIds(user);
  const ids = [...stations];
  if (plants) {
    const rows = await client`
      SELECT id FROM delivery_customers
       WHERE customer_type = 'lpg_plant' AND lpg_station_id = ANY(${plants}::int[])`;
    ids.push(...rows.map((r) => Number(r.id)));
  }
  return ids.length ? [...new Set(ids.map(Number))] : null;
}

/** Does this person run any station or plant — what the dashboard needs to show those costs. */
const runsStations = (user) => Boolean(scopedStationIds(user) || scopedPlantIds(user));

const plateKey = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();

/** The ids among these inventory rows that this person's own stations were given. */
async function ownStationLoadIds(user, rows) {
  const ids = await ownStationIds(user);
  if (!ids || !rows.length) return new Set();
  const cycles = await client`
    SELECT DISTINCT upper(regexp_replace(COALESCE(truck_number, ''), '[[:space:]]', '', 'g')) AS plate,
           left(COALESCE(date_loaded, ''), 10) AS day
      FROM delivery_sales
     WHERE customer_id = ANY(${ids}::int[])`;
  const onSale = new Set(cycles.map((c) => `${c.plate}||${c.day}`));
  const own = new Set(ids);
  const out = new Set();
  for (const r of rows) {
    if (!r) continue;
    const mine = (r.customerId != null && own.has(Number(r.customerId)))
      || onSale.has(`${plateKey(r.truckNumber)}||${String(r.dateAllocated || "").slice(0, 10)}`);
    if (mine) out.add(Number(r.id));
  }
  return out;
}

module.exports = { STATION_COST_FIELDS, ownStationLoadIds, runsStations };
