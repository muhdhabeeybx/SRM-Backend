const asyncHandler = require("express-async-handler");
const { deliveryCustomerRepo } = require("../../repositories");
const { scopedStationIds, stationVisible } = require("../../lib/stationScope");

const getFilingStations = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;

  const result = await deliveryCustomerRepo.findAll({
    type: "filling_station",
    search,
    // A person assigned stations sees only those — lib/stationScope.js.
    ids: scopedStationIds(req.user),
    page,
    limit,
  });

  const mappedStations = result.customers.map((s) => ({
    ...s,
    stationCode: s.customerCode || "",
    phone: s.phoneNumber || "",
    manager: {
      name: s.contactPerson || "",
      phone: s.contactPersonPhone || "",
      email: s.email || "",
    },
    status: s.status === "active" ? "Active" : s.status === "dormant" ? "Inactive" : "Under Maintenance",
  }));

  res.json({
    success: true,
    data: { stations: mappedStations, pagination: result.pagination },
  });
});

const getFilingStationById = asyncHandler(async (req, res) => {
  const station = await deliveryCustomerRepo.findById(req.params.id);

  if (!station || station.customerType !== "filling_station" || !stationVisible(req.user, station.id)) {
    return res.status(404).json({ success: false, message: "Filing station not found" });
  }

  const mappedStation = {
    ...station,
    stationCode: station.customerCode || "",
    phone: station.phoneNumber || "",
    manager: {
      name: station.contactPerson || "",
      phone: station.contactPersonPhone || "",
      email: station.email || "",
    },
    status: station.status === "active" ? "Active" : "Inactive",
  };

  res.json({ success: true, data: { station: mappedStation } });
});

const createFilingStation = asyncHandler(async (req, res) => {
  const {
    stationCode, name, manager, phone, altPhoneNumber, email,
    street, city, state, tankCapacity, pumpCount, creditLimit, notes,
  } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, message: "Station name is required" });
  }

  const customerCode = await deliveryCustomerRepo.generateCustomerCode("filling_station");

  const station = await deliveryCustomerRepo.create({
    customerType: "filling_station",
    customerCode: stationCode || customerCode,
    name,
    phoneNumber: phone || req.body.phoneNumber || "",
    altPhoneNumber: altPhoneNumber || req.body.alternatePhone || "",
    email: email || (manager ? manager.email : ""),
    contactPerson: manager ? manager.name : req.body.contactPerson || "",
    contactPersonPhone: manager ? manager.phone : req.body.contactPersonPhone || "",
    stationAddress: street ? `${street}, ${city || ""} ${state || ""}` : req.body.stationAddress || "",
    tankCapacity: tankCapacity ? Number(tankCapacity) : 0,
    pumpCount: pumpCount ? Number(pumpCount) : 1,
    creditLimit: String(creditLimit ? Number(creditLimit) : 0),
    status: "active",
    notes: notes || "",
    createdBy: req.user ? req.user.id : null,
  });

  res.status(201).json({
    success: true,
    message: "Filing station created successfully",
    data: { station },
  });
});

const updateFilingStation = asyncHandler(async (req, res) => {
  const station = await deliveryCustomerRepo.findById(req.params.id);

  if (!station || station.customerType !== "filling_station" || !stationVisible(req.user, station.id)) {
    return res.status(404).json({ success: false, message: "Filing station not found" });
  }

  const { name, phone, manager, street, city, state, tankCapacity, pumpCount, creditLimit, notes } = req.body;

  const updateData = {};
  if (name) updateData.name = name;
  if (phone) updateData.phoneNumber = phone;
  if (manager) {
    if (manager.name) updateData.contactPerson = manager.name;
    if (manager.phone) updateData.contactPersonPhone = manager.phone;
    if (manager.email) updateData.email = manager.email;
  }
  if (street || city || state) {
    updateData.stationAddress = `${street || ""} ${city || ""} ${state || ""}`.trim();
  }
  if (tankCapacity !== undefined) updateData.tankCapacity = Number(tankCapacity);
  if (pumpCount !== undefined) updateData.pumpCount = Number(pumpCount);
  if (creditLimit !== undefined) updateData.creditLimit = String(Number(creditLimit));
  if (notes !== undefined) updateData.notes = notes;

  const updated = await deliveryCustomerRepo.update(station.id, updateData);

  res.json({
    success: true,
    message: "Filing station updated successfully",
    data: { station: updated },
  });
});

const deleteFilingStation = asyncHandler(async (req, res) => {
  const station = await deliveryCustomerRepo.findById(req.params.id);

  if (!station || station.customerType !== "filling_station" || !stationVisible(req.user, station.id)) {
    return res.status(404).json({ success: false, message: "Filing station not found" });
  }

  await deliveryCustomerRepo.deleteById(station.id);

  res.json({ success: true, message: "Filing station deleted successfully" });
});

module.exports = {
  getFilingStations,
  getFilingStationById,
  createFilingStation,
  updateFilingStation,
  deleteFilingStation,
};
