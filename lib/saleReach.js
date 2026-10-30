const { client } = require("../config/db");
const { allocationCodesFor } = require("./pfiScope");
const { scopedStationIds, scopedPlantIds } = require("./stationScope");

/**
 * What of the truck sales and station books one person may see.
 *
 * Each assignment adds what it covers:
 *
 *   PFIs       every row on their batches (lib/pfiScope allocationCodesFor),
 *              whoever it was sold to
 *   stations   every row at a filling station of theirs, on any PFI
 *   plants     every row at an LPG plant of theirs, on any PFI
 *
 * Somebody assigned none of these is not narrowed at all, as everywhere else
 * (lib/scopeFilter.js: an empty assignment never reads as "nothing").
 *
 * ── Why a union ───────────────────────────────────────────────────────────
 *
 * It used to be both at once: a person given a PFI and a station saw that
 * station's rows on that PFI only. That left the stations' and plants' finance
 * desks blind (the owner, 30 Oct 2026). Oladaride Bilkis banks the seven
 * filling stations, whose trucks come off a different batch every week, and
 * saw only PFI-47B's; Adetona Saheed banks the plants, whose rows sit on
 * PFI-33B, PFI-42B or no batch at all, and saw none of them. A station's
 * account is the station's, whatever batch filled its tanks.
 *
 * Somebody given stations alone (David Andrew) is unchanged: the stations'
 * rows, and nothing on any batch beyond them.
 */

const codeKey = (v) => String(v || "").trim().toUpperCase();

/** The delivery_customers ids of the stations and plants this person is assigned, or null when none. */
async function placeIdsFor(user) {
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

/**
 * `codes`  the batch codes their PFIs give them, or null when no PFI narrows them
 * `places` their stations' and plants' customer ids, or null when they have none
 * `open`   neither narrows them: everything
 */
async function reachFor(user) {
  const [codes, places] = await Promise.all([allocationCodesFor(user), placeIdsFor(user)]);
  return { codes, places, open: codes === null && places === null };
}

const customerOf = (row) => {
  const v = row?.customerId ?? row?.customer_id ?? null;
  return v == null || v === "" ? null : Number(v);
};

/** Is this row (a sale, or one about to be written) inside this reach? */
function rowInReach(reach, row) {
  if (reach.open) return true;
  if (!row) return false;
  if (reach.codes !== null && reach.codes.includes(codeKey(row.allocationCode ?? row.allocation_code))) return true;
  const customer = customerOf(row);
  return reach.places !== null && customer != null && reach.places.includes(customer);
}

/**
 * May this person write this row? Inside their reach — or, for somebody no PFI
 * narrows, a row at no customer at all, which writes always let through
 * (a station's own rows name it; this keeps what stood before).
 */
function writeInReach(reach, row) {
  return rowInReach(reach, row) || (reach.codes === null && customerOf(row) == null);
}

module.exports = { placeIdsFor, reachFor, rowInReach, writeInReach };
