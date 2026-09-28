const asyncHandler = require("express-async-handler");
const { inArray } = require("drizzle-orm");
const { db } = require("../../config/db");
const { lpgStations } = require("../../db/schema");
const { deliveryCustomerRepo } = require("../../repositories");
const { scopedPlantIds, plantVisible } = require("../../lib/stationScope");

/**
 * LPG plants as delivery customers — the register /lpg/plants reads.
 *
 * The filling-station register's twin (filingStation.controller.js), for
 * customers of type 'lpg_plant' (migration 0061). Plants are registered and
 * edited through /delivery-customers like any other customer; this is the
 * read side, narrowed for a person assigned plants to the plants they hold.
 *
 * Each row names the lpg_stations plant it is linked to, when it is one of
 * Soroman's own, so the page can say which plant an account belongs to and
 * fetch that plant's costs.
 */

/** Adds `lpgStation: { id, name, code }` to each row that has a link. */
const withLinkedPlant = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.lpgStationId).filter((v) => v != null))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, lpgStation: null }));
  const plants = await db
    .select({ id: lpgStations.id, name: lpgStations.name, code: lpgStations.code })
    .from(lpgStations)
    .where(inArray(lpgStations.id, ids));
  const byId = new Map(plants.map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, lpgStation: byId.get(r.lpgStationId) || null }));
};

const getLpgPlants = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 500 } = req.query;

  const result = await deliveryCustomerRepo.findAll({
    type: "lpg_plant",
    search,
    // A person assigned plants sees only those — lib/stationScope.js.
    lpgStationIds: scopedPlantIds(req.user),
    page,
    limit,
  });

  res.json({
    success: true,
    data: { plants: await withLinkedPlant(result.customers), pagination: result.pagination },
  });
});

const getLpgPlantById = asyncHandler(async (req, res) => {
  const plant = await deliveryCustomerRepo.findById(req.params.id);

  if (!plant || plant.customerType !== "lpg_plant" || !plantVisible(req.user, plant)) {
    return res.status(404).json({ success: false, message: "LPG plant not found" });
  }

  const [row] = await withLinkedPlant([plant]);
  res.json({ success: true, data: { plant: row } });
});

module.exports = { getLpgPlants, getLpgPlantById };
