const asyncHandler = require("express-async-handler");
const { client } = require("../../config/db");
const { deliveryCustomerRepo, deliveryNoteRepo } = require("../../repositories");
const { CUSTOMER_TYPES, isStationType, TYPE_LABEL } = require("../../lib/customerTypes");

/**
 * The lpg_stations row an LPG plant customer is linked to, checked.
 *
 * It must exist, and it must not already be another customer's: the link is
 * what puts a plant's vendor costs on its account and what lets a plant
 * manager see it, and two accounts sharing one plant would each take both.
 * The unique index in migration 0061 is the backstop; this is the message.
 *
 * Returns an error string, or null when the link is fine (or absent).
 */
const linkProblem = async (lpgStationId, customerId = null) => {
  if (lpgStationId == null) return null;
  const [plant] = await client`SELECT id, name FROM lpg_stations WHERE id = ${Number(lpgStationId)}`;
  if (!plant) return "That LPG plant does not exist";
  const holder = await deliveryCustomerRepo.findByLpgStationId(plant.id);
  if (holder && (customerId == null || Number(holder.id) !== Number(customerId))) {
    return `${plant.name} is already registered, as ${holder.name}`;
  }
  return null;
};

const createDeliveryCustomer = asyncHandler(async (req, res) => {
  const {
    customerType, name, phoneNumber, altPhoneNumber, email,
    homeAddress, officeAddress, passportPhoto,
    contactPerson, contactPersonPhone, stationAddress,
    tankCapacity, pumpCount, creditLimit, notes, lpgStationId, bankDetails,
  } = req.body;

  if (!customerType || !CUSTOMER_TYPES.includes(customerType)) {
    return res.status(400).json({
      success: false,
      message: "Invalid or missing customerType. Must be 'customer', 'filling_station' or 'lpg_plant'",
    });
  }

  if (!name || !phoneNumber) {
    return res.status(400).json({
      success: false,
      message: "Name and primary phone number are required",
    });
  }

  const customerCode = await deliveryCustomerRepo.generateCustomerCode(customerType);

  const customerData = {
    customerType,
    customerCode,
    name,
    phoneNumber,
    altPhoneNumber: altPhoneNumber || "",
    email: email || "",
    creditLimit: String(creditLimit || 0),
    notes: notes || "",
    bankDetails: bankDetails || {},
    createdBy: req.user ? req.user.id : null,
  };

  if (customerType === "customer") {
    customerData.homeAddress = homeAddress || "";
    customerData.officeAddress = officeAddress || "";
    customerData.passportPhoto = passportPhoto || "";
  } else if (isStationType(customerType)) {
    // A filling station and an LPG plant keep the same site fields: who runs
    // it, where it is, how much it holds and how many points it sells from.
    customerData.contactPerson = contactPerson || "";
    customerData.contactPersonPhone = contactPersonPhone || "";
    customerData.stationAddress = stationAddress || officeAddress || "";
    customerData.tankCapacity = tankCapacity || 0;
    customerData.pumpCount = pumpCount || 1;
  }

  if (customerType === "lpg_plant" && lpgStationId != null) {
    const problem = await linkProblem(lpgStationId);
    if (problem) return res.status(409).json({ success: false, message: problem });
    customerData.lpgStationId = Number(lpgStationId);
  }

  const newCustomer = await deliveryCustomerRepo.create(customerData);

  res.status(201).json({
    success: true,
    message: `${TYPE_LABEL[customerType]} created successfully`,
    data: newCustomer,
  });
});

/**
 * One customer, with the sales totals the directory list carries.
 *
 * The dashboard's profile page and its edit form both read a customer by id —
 * opened from a link rather than from the list, there is nothing else to read
 * it from.
 */
const getDeliveryCustomerById = asyncHandler(async (req, res) => {
  const customer = await deliveryCustomerRepo.findOneWithSalesAggregation(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, message: "Delivery customer not found" });
  }
  res.json({ success: true, data: customer });
});

const getDeliveryCustomers = asyncHandler(async (req, res) => {
  const { type, search, status, page = 1, limit = 50 } = req.query;

  const result = await deliveryCustomerRepo.findAllWithSalesAggregation({
    type,
    search,
    status,
    page,
    limit,
  });

  res.json({ success: true, data: result });
});

const createDeliveryNote = asyncHandler(async (req, res) => {
  const { customerId, product, quantityDelivered, unit, driver, truck, depotOfLoading, deliveryAddress, remarks } = req.body;

  const customer = await deliveryCustomerRepo.findById(customerId);
  if (!customer) {
    return res.status(404).json({ success: false, message: "Delivery Customer not found" });
  }

  const noteNumber = await deliveryNoteRepo.generateNoteNumber();

  const deliveryNote = await deliveryNoteRepo.create({
    deliveryNoteNumber: noteNumber,
    customerId: customer.id,
    customerTypeSnapshot: customer.customerType,
    deliveryAddress: deliveryAddress || customer.stationAddress || customer.homeAddress || "",
    contactPersonOnSite: {
      name: isStationType(customer.customerType) ? customer.contactPerson : customer.name,
      phone: isStationType(customer.customerType) ? customer.contactPersonPhone : customer.phoneNumber,
    },
    product,
    quantityDelivered,
    unit: unit || "Liters",
    driver: driver || {},
    truck: truck || {},
    depotOfLoading: depotOfLoading || "",
    remarks: remarks || "",
    createdBy: req.user ? req.user.id : null,
  });

  await deliveryCustomerRepo.update(customer.id, {
    lastTransactionDate: new Date(),
  });

  res.status(201).json({
    success: true,
    message: "Delivery Note created successfully",
    data: deliveryNote,
  });
});

const updateDeliveryCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customer = await deliveryCustomerRepo.findById(id);
  if (!customer) {
    return res.status(404).json({ success: false, message: "Delivery customer not found" });
  }

  const data = { ...req.body };
  const type = data.customerType || customer.customerType;
  if (type !== "lpg_plant") {
    // Only a plant is linked to a plant. A customer re-classified away from
    // one lets the plant go, so it can be registered again.
    if (customer.lpgStationId != null || data.lpgStationId != null) data.lpgStationId = null;
  } else if (data.lpgStationId != null) {
    const problem = await linkProblem(data.lpgStationId, customer.id);
    if (problem) return res.status(409).json({ success: false, message: problem });
  }

  const updated = await deliveryCustomerRepo.update(id, data);

  res.json({
    success: true,
    message: "Customer updated successfully",
    data: updated,
  });
});

const deleteDeliveryCustomer = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customer = await deliveryCustomerRepo.findById(id);
  if (!customer) {
    return res.status(404).json({ success: false, message: "Delivery customer not found" });
  }

  await deliveryCustomerRepo.deleteById(id);

  res.json({
    success: true,
    message: "Customer deleted successfully",
  });
});

module.exports = {
  createDeliveryCustomer,
  getDeliveryCustomerById,
  getDeliveryCustomers,
  createDeliveryNote,
  updateDeliveryCustomer,
  deleteDeliveryCustomer,
};
