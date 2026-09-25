const asyncHandler = require("express-async-handler");
const { lpgStationRepo } = require("../../repositories");

const getLpgStations = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;

  const result = await lpgStationRepo.findAll({ search, page, limit, scopeUser: req.user });

  const enrichedStations = await Promise.all(
    result.stations.map(async (station) => {
      const [staff, cylinders] = await Promise.all([
        lpgStationRepo.getStaff(station.id),
        lpgStationRepo.getCylinders(station.id),
      ]);
      return { ...station, staff, staffIds: staff, pfis: [], cylinders };
    })
  );

  res.json({
    success: true,
    data: { stations: enrichedStations, pagination: result.pagination },
  });
});

const getLpgStationById = asyncHandler(async (req, res) => {
  const station = await lpgStationRepo.findById(req.params.id);

  // The list is already narrowed to a person's assigned plants
  // (lpgStation.repository via scopeFilter); opening one by id is held to
  // the same rule, and an unassigned plant reads as not found.
  const assigned = req.user?.canViewAllLocations ? [] : req.user?.scope?.lpgStationIds || [];
  if (!station || (assigned.length && !assigned.map(Number).includes(Number(station.id)))) {
    return res.status(404).json({ success: false, message: "LPG station not found" });
  }

  const [staff, cylinders, priceHistory] = await Promise.all([
    lpgStationRepo.getStaff(station.id),
    lpgStationRepo.getCylinders(station.id),
    lpgStationRepo.getPriceHistory(station.id),
  ]);

  res.json({
    success: true,
    data: { station: { ...station, staff, staffIds: staff, pfis: [], cylinders, priceHistory } },
  });
});

const createLpgStation = asyncHandler(async (req, res) => {
  const { name, code, address, city, state, country, postcode, lpgCapacityKg, pricePerKg, status, establishedYear, staffIds, cylinders } = req.body;

  if (!name || !code || !address || !city || !state || !country || !postcode || !lpgCapacityKg || !establishedYear) {
    return res.status(400).json({
      success: false,
      message: "Name, code, address, city, state, country, postcode, LPG capacity (Kg), and established year are required",
    });
  }

  const existingStation = await lpgStationRepo.findByCode(code);
  if (existingStation) {
    return res.status(400).json({
      success: false,
      message: `LPG station with code "${code}" already exists`,
    });
  }

  const station = await lpgStationRepo.create({
    name,
    code,
    address,
    city,
    state,
    country,
    postcode,
    lpgCapacityKg,
    pricePerKg: pricePerKg ? String(pricePerKg) : "0",
    status: status || "Active",
    establishedYear,
  });

  // Log initial price to history
  if (pricePerKg && Number(pricePerKg) > 0) {
    try {
      await lpgStationRepo.logPriceChange(station.id, pricePerKg);
    } catch (logErr) {
      console.error("Failed to log initial LPG price:", logErr);
    }
  }

  if (staffIds && staffIds.length > 0) {
    await lpgStationRepo.setStaff(station.id, staffIds);
  }

  if (cylinders && cylinders.length > 0) {
    await lpgStationRepo.setCylinders(station.id, cylinders);
  }

  const [staff, stationCylinders] = await Promise.all([
    lpgStationRepo.getStaff(station.id),
    lpgStationRepo.getCylinders(station.id),
  ]);

  res.status(201).json({
    success: true,
    message: "LPG station created successfully",
    data: { station: { ...station, staff, staffIds: staff, cylinders: stationCylinders } },
  });
});

const updateLpgStation = asyncHandler(async (req, res) => {
  const station = await lpgStationRepo.findById(req.params.id);

  if (!station) {
    return res.status(404).json({ success: false, message: "LPG station not found" });
  }

  if (req.body.code !== undefined && req.body.code !== station.code) {
    const existingStation = await lpgStationRepo.findByCode(req.body.code);
    if (existingStation) {
      return res.status(400).json({
        success: false,
        message: `LPG station with code "${req.body.code}" already exists`,
      });
    }
  }

  const allowedFields = [
    "name", "code", "address", "city", "state", "country", "postcode",
    "lpgCapacityKg", "pricePerKg", "status", "establishedYear",
  ];

  const updateData = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  }

  await lpgStationRepo.update(station.id, updateData);

  // Log price change to history
  if (updateData.pricePerKg !== undefined && String(updateData.pricePerKg) !== String(station.pricePerKg || 0)) {
    try {
      await lpgStationRepo.logPriceChange(station.id, updateData.pricePerKg);
    } catch (logErr) {
      console.error("Failed to log LPG price change:", logErr);
    }
  }

  if (req.body.staffIds !== undefined) {
    await lpgStationRepo.setStaff(station.id, req.body.staffIds);
  }

  if (req.body.cylinders !== undefined) {
    await lpgStationRepo.setCylinders(station.id, req.body.cylinders);
  }

  const [staff, stationCylinders, priceHistory] = await Promise.all([
    lpgStationRepo.getStaff(station.id),
    lpgStationRepo.getCylinders(station.id),
    lpgStationRepo.getPriceHistory(station.id),
  ]);

  res.json({
    success: true,
    message: "LPG station updated successfully",
    data: { station: { ...station, ...updateData, staff, staffIds: staff, cylinders: stationCylinders, priceHistory } },
  });
});

const deleteLpgStation = asyncHandler(async (req, res) => {
  const station = await lpgStationRepo.findById(req.params.id);

  if (!station) {
    return res.status(404).json({ success: false, message: "LPG station not found" });
  }

  await lpgStationRepo.deleteById(station.id);

  res.json({ success: true, message: "LPG station deleted successfully" });
});

module.exports = { getLpgStations, getLpgStationById, createLpgStation, updateLpgStation, deleteLpgStation };
