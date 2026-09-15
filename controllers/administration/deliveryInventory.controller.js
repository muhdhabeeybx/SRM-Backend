const asyncHandler = require("express-async-handler");
const { deliveryInventoryRepo, pfiRepo, truckRepo } = require("../../repositories");

const getDeliveryInventory = asyncHandler(async (req, res) => {
  const { search, loading_status, truck_number, page = 1, limit = 500 } = req.query;

  const result = await deliveryInventoryRepo.findAll({
    search,
    loading_status,
    truck_number,
    page,
    limit,
    scopeUser: req.user,
  });

  res.json({ success: true, data: result });
});

const getDeliveryInventoryById = asyncHandler(async (req, res) => {
  const loading = await deliveryInventoryRepo.findById(req.params.id);
  if (!loading) {
    return res.status(404).json({ success: false, message: "Inventory record not found" });
  }
  res.json({ success: true, data: { loading } });
});

const createDeliveryInventory = asyncHandler(async (req, res) => {
  const pfi = req.body.pfi || req.body.pfiId;
  const allocation_code = req.body.allocation_code || req.body.allocationCode;
  const truck = req.body.truck || req.body.truckId;
  const truck_number = req.body.truck_number || req.body.truckNumber;
  const depot = req.body.depot;
  const customer = req.body.customer || req.body.customerId;
  const customer_name = req.body.customer_name || req.body.customerName;
  const quantity_allocated = req.body.quantity_allocated !== undefined
    ? req.body.quantity_allocated
    : (req.body.quantityAllocated !== undefined ? req.body.quantityAllocated : req.body.quantity);
  const rate = req.body.rate;
  const date_allocated = req.body.date_allocated || req.body.dateAllocated;
  const loading_status = req.body.loading_status || req.body.loadingStatus || "loaded";
  const location = req.body.location;
  const notes = req.body.notes;

  let pfiObj = null;
  if (pfi) {
    pfiObj = await pfiRepo.findById(pfi);
  }

  let truckObj = null;
  if (truck) {
    truckObj = await truckRepo.findById(truck);
  }

  const inventoryRecord = await deliveryInventoryRepo.create({
    pfiId: pfi ? (Number(pfi) || pfi) : null,
    pfiNumber: pfiObj ? pfiObj.pfiNumber : (req.body.pfi_number || req.body.pfiNumber || ""),
    pfiProduct: pfiObj ? (pfiObj.productName || pfiObj.productId) : (req.body.pfi_product || req.body.pfiProduct || ""),
    pfiLocation: pfiObj ? (pfiObj.locationName || "") : "",
    allocationCode: allocation_code || null,
    truckId: truck ? (Number(truck) || truck) : null,
    truckNumber: truck_number || (truckObj ? truckObj.plateNumber : ""),
    depot: depot || (pfiObj ? pfiObj.locationName : ""),
    customerId: customer ? (Number(customer) || customer) : null,
    customerName: customer_name || "",
    quantityAllocated: Number(quantity_allocated) || 0,
    rate: rate !== undefined && rate !== null && rate !== "" ? String(Number(rate) || 0) : "0",
    dateAllocated: date_allocated || new Date().toISOString().split("T")[0],
    loadingStatus: loading_status,
    location: location || "",
    notes: notes || "",
    createdBy: req.user ? `${req.user.firstName} ${req.user.surname}` : "System",
  });

  res.status(201).json({
    success: true,
    message: "Delivery inventory record created",
    data: { inventoryRecord },
  });
});

/**
 * One set of trip costs applied to several trucks — POST /delivery-inventory/costs
 *
 * Trucks on a batch usually take the same diesel at the same price on the same
 * day, and entering it twelve times is how twelve rows end up slightly
 * different. The ids are named explicitly rather than "the whole batch": a bulk
 * pass that quietly swept up a truck somebody had already costed by hand would
 * replace the careful figure with the convenient one.
 */
const setDeliveryTripCosts = asyncHandler(async (req, res) => {
  const { ids, clearBlank, ...values } = req.body;

  const actor = req.user?.name || req.user?.email || null;
  const rows = await deliveryInventoryRepo.setCosts(ids, values, { clearBlank, actor });

  if (!rows.length) {
    return res.status(400).json({
      success: false,
      message: "Nothing to apply — enter at least one figure",
    });
  }

  res.json({
    success: true,
    message: `Costs applied to ${rows.length} truck${rows.length === 1 ? "" : "s"}`,
    data: { inventory: rows, updated: rows.length },
  });
});

const updateDeliveryInventory = asyncHandler(async (req, res) => {
  const record = await deliveryInventoryRepo.findById(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, message: "Inventory record not found" });
  }

  const updated = await deliveryInventoryRepo.update(record.id, req.body);

  res.json({
    success: true,
    message: "Delivery inventory record updated",
    data: { inventoryRecord: updated },
  });
});

const deleteDeliveryInventory = asyncHandler(async (req, res) => {
  const record = await deliveryInventoryRepo.deleteById(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, message: "Inventory record not found" });
  }
  res.json({ success: true, message: "Delivery inventory deleted" });
});

module.exports = {
  getDeliveryInventory,
  getDeliveryInventoryById,
  createDeliveryInventory,
  updateDeliveryInventory,
  setDeliveryTripCosts,
  deleteDeliveryInventory,
};
