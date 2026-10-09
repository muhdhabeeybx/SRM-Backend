const asyncHandler = require("express-async-handler");
const stepNotices = require("../../services/stepNotices.service");
const { deliveryInventoryRepo, pfiRepo, truckRepo } = require("../../repositories");
const { lagosToday, localDateStr } = require("../../lib/zonedDay");
const { pfiIdForCode, codeOf } = require("../../lib/batchPfi");
const allocationTrucks = require("../../services/allocationTrucks.service");

const staffActor = (req) => ({ type: "staff", staffId: req.user?.id ?? null });

/**
 * Trip costs are stripped for anybody who cannot open Delivery Costing.
 *
 * Hiding a page is not restricting data. These rows are served to the Delivery
 * Inventory page too, which everybody can open — so without this, what product
 * costs the company and what each trip earns would be one devtools tab away
 * from every driver and gate officer on the system, while the menu item was
 * carefully hidden from them.
 *
 * The gate is the same per-person page override the dashboard reads, so the
 * two cannot disagree: whoever can see the page sees the figures, and nobody
 * else does. An explicit denial beats super admin here exactly as it does in
 * the client's canAccessRoute — "only these people" has to mean these people.
 */
const COST_FIELDS = [
  "agoLitres", "agoPrice", "agoValue",
  "feedingAllowance", "totalExpenses", "costPerLitre",
  "productPrice", "landingCost",
  "margin", "marginValue",
  "costed", "missing", "costedAt", "costedBy",
];

const COSTING_ROUTE = "/delivery-costing";

const maySeeCosts = (user) => {
  if (!user) return false;
  const override = (user.pageOverrides || []).find((o) => o.routePath === COSTING_ROUTE);
  if (override) return Boolean(override.allowed);
  return (user.roles || []).includes("super_admin");
};

/** Rate stays: it is the selling price, which the inventory page already shows. */
const stripCosts = (row) => {
  if (!row) return row;
  const out = { ...row };
  for (const f of COST_FIELDS) delete out[f];
  return out;
};

const withCostVisibility = (user, rows) =>
  maySeeCosts(user) ? rows : rows.map(stripCosts);

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

  const loadings = withCostVisibility(req.user, result.loadings || []);
  res.json({ success: true, data: { ...result, loadings, inventory: loadings } });
});

const getDeliveryInventoryById = asyncHandler(async (req, res) => {
  const loading = await deliveryInventoryRepo.findById(req.params.id);
  if (!loading) {
    return res.status(404).json({ success: false, message: "Inventory record not found" });
  }
  res.json({ success: true, data: { loading: maySeeCosts(req.user) ? loading : stripCosts(loading) } });
});

const createDeliveryInventory = asyncHandler(async (req, res) => {
  const allocation_code = req.body.allocation_code || req.body.allocationCode;
  // Allocate Trucks sends the batch code and no PFI. Without the PFI the truck
  // is hidden from everybody assigned to it — lib/batchPfi.
  const codePfi = await pfiIdForCode(allocation_code);
  const pfi = req.body.pfi || req.body.pfiId || codePfi;
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

  const values = {
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
    dateAllocated: date_allocated || lagosToday(),
    loadingStatus: loading_status,
    location: location || "",
    notes: notes || "",
    // req.user carries `name`, not firstName/surname — reading those wrote
    // "undefined undefined" on every truck added this way.
    createdBy: req.user ? (req.user.name || req.user.email || "Staff") : "System",
  };

  // A truck added to a trucking PFI that an allocation made also goes onto
  // that allocation's order, and off the cargo it came from — in the same
  // transaction, so a cargo without the litres refuses the truck.
  const inventoryRecord = await allocationTrucks.writeInStep(
    { pfiIds: [pfi, codePfi], actor: staffActor(req), adding: true },
    (tx) => deliveryInventoryRepo.create(values, tx),
  );

  // The driver hears he is loaded, the truck sales desk that he is ready to
  // sell. Never throws.
  stepNotices.trucksLoaded([inventoryRecord.id]);

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
  // Same gate as reading them. A hidden page is not an authorisation check,
  // and this endpoint writes what the margins are built from.
  if (!maySeeCosts(req.user)) {
    return res.status(403).json({
      success: false,
      message: "You do not have access to delivery costing",
    });
  }

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

  /*
   * The batch code decides the PFI when nobody chose one: a row with no PFI,
   * or one moved to another batch with the old batch's PFI still on it (the
   * edit form sends back whatever PFI the row had — it has no control for it).
   */
  const data = { ...req.body };
  const nextCode = data.allocationCode !== undefined ? data.allocationCode : record.allocationCode;
  const codeChanged = data.allocationCode !== undefined && codeOf(data.allocationCode) !== codeOf(record.allocationCode);
  const pfiAfter = data.pfiId !== undefined ? data.pfiId : record.pfiId;
  const unchosen = pfiAfter == null || pfiAfter === "" || (codeChanged && Number(pfiAfter) === Number(record.pfiId));
  if (codeOf(nextCode) && unchosen) {
    const inferred = await pfiIdForCode(nextCode);
    if (inferred && inferred !== Number(record.pfiId)) {
      const pfiObj = await pfiRepo.findById(inferred);
      data.pfiId = inferred;
      if (pfiObj?.pfiNumber) data.pfiNumber = pfiObj.pfiNumber;
    } else if (inferred) {
      data.pfiId = inferred;
    }
  }

  /*
   * A change to what the batch holds — a truck's litres, the truck itself, or
   * which batch it is on — is kept in step with an allocation's order. Other
   * edits (customer, rate, notes, release) never were part of the order and
   * run as they always did.
   */
  const litres = (v) => Math.round(Number(v) || 0);
  const qtyAfter = data.quantityAllocated !== undefined ? litres(data.quantityAllocated) : litres(record.quantityAllocated);
  const qtyChanged = qtyAfter !== litres(record.quantityAllocated);
  const moved =
    (data.pfiId !== undefined && Number(data.pfiId) !== Number(record.pfiId)) ||
    (data.allocationCode !== undefined && codeOf(data.allocationCode) !== codeOf(record.allocationCode));
  const truckChanged =
    (data.truckId !== undefined && Number(data.truckId) !== Number(record.truckId)) ||
    (data.truckNumber !== undefined && codeOf(data.truckNumber) !== codeOf(record.truckNumber));

  const write = (tx) => deliveryInventoryRepo.update(record.id, data, tx);
  const updated = qtyChanged || moved || truckChanged
    ? await allocationTrucks.writeInStep(
      {
        pfiIds: [record.pfiId, data.pfiId, await pfiIdForCode(record.allocationCode), await pfiIdForCode(nextCode)],
        actor: staffActor(req),
        adding: moved || qtyAfter > litres(record.quantityAllocated),
      },
      write,
    )
    : await write();

  res.json({
    success: true,
    message: "Delivery inventory record updated",
    data: { inventoryRecord: updated },
  });
});

const deleteDeliveryInventory = asyncHandler(async (req, res) => {
  const existing = await deliveryInventoryRepo.findById(req.params.id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Inventory record not found" });
  }
  // Taking a truck off an allocation's trucking PFI takes its pending load off
  // the order and gives the litres back to the cargo — refused once ticketed.
  const record = await allocationTrucks.writeInStep(
    { pfiIds: [existing.pfiId, await pfiIdForCode(existing.allocationCode)], actor: staffActor(req) },
    (tx) => deliveryInventoryRepo.deleteById(existing.id, tx),
  );
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
