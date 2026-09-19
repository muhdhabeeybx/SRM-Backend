const asyncHandler = require("express-async-handler");
const { depotRepo, pfiRepo, orderRepo, auditLogRepo } = require("../../repositories");
const { getMultiDepotCapacities, getDepotCapacities } = require("../../services/pfi.service");

const getDepots = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;

  const result = await depotRepo.findAll({ search, page, limit, scopeUser: req.user });

  // Enrich with product capacities and prices
  const enrichedDepots = await Promise.all(
    result.depots.map(async (depot) => {
      const [capacities, prices, staff] = await Promise.all([
        depotRepo.getProductCapacities(depot.id),
        depotRepo.getProductPrices(depot.id),
        depotRepo.getStaff(depot.id),
      ]);
      // Real-time available stock comes from active PFIs; the configured
      // holding capacity (capacity) is a fixed maximum and never mutates.
      const pfiProducts = await getDepotCapacities(depot.id);
      const enrichedCapacities = capacities.map((pc) => {
        const prodKey = pc.productId ?? pc.product?.id ?? pc.product?._id ?? pc.product;
        const availableStock = pfiProducts[prodKey] !== undefined
          ? pfiProducts[prodKey]
          : (pfiProducts[String(prodKey)] !== undefined ? pfiProducts[String(prodKey)] : 0);
        return {
          ...pc,
          availableStock: Number(availableStock || 0),
        };
      });
      return { ...depot, productCapacities: enrichedCapacities, productPrices: prices, staff, staffIds: staff };
    })
  );

  res.json({
    success: true,
    data: { depots: enrichedDepots, pagination: result.pagination },
  });
});

const getDepotById = asyncHandler(async (req, res) => {
  const depot = await depotRepo.findById(req.params.id);

  if (!depot) {
    return res.status(404).json({ success: false, message: "Depot not found" });
  }

  const [capacities, prices, staff] = await Promise.all([
    depotRepo.getProductCapacities(depot.id),
    depotRepo.getProductPrices(depot.id),
    depotRepo.getStaff(depot.id),
  ]);

  // Real-time available stock comes from active PFIs; the configured holding
  // capacity (capacity) is a fixed maximum and never mutates.
  const pfiProducts = await getDepotCapacities(depot.id);
  const enrichedCapacities = capacities.map((pc) => {
    const prodKey = pc.productId ?? pc.product?.id ?? pc.product?._id ?? pc.product;
    const availableStock = pfiProducts[prodKey] !== undefined
      ? pfiProducts[prodKey]
      : (pfiProducts[String(prodKey)] !== undefined ? pfiProducts[String(prodKey)] : 0);
    return {
      ...pc,
      availableStock: Number(availableStock || 0),
    };
  });

  res.json({
    success: true,
    data: { depot: { ...depot, productCapacities: enrichedCapacities, productPrices: prices, staff, staffIds: staff } },
  });
});

const createDepot = asyncHandler(async (req, res) => {
  let { name, code, address, city, state, country, postcode, parkedTrucksCount, maxCapacity, status, establishedYear, productCapacities, productPrices, staffIds } = req.body;

  if ((maxCapacity === undefined || maxCapacity === null || maxCapacity === "") && Array.isArray(productCapacities) && productCapacities.length > 0) {
    maxCapacity = productCapacities.reduce((sum, pc) => sum + (Number(pc.capacity) || 0), 0);
  }

  if (!name || !code || !address || !city || !state || !country || !postcode || !maxCapacity || !establishedYear) {
    return res.status(400).json({
      success: false,
      message: "Name, code, address, city, state, country, postcode, max capacity, and established year are required",
    });
  }

  const existingDepot = await depotRepo.findByCode(code);
  if (existingDepot) {
    return res.status(400).json({
      success: false,
      message: `Depot with code "${code}" already exists`,
    });
  }

  const depot = await depotRepo.create({
    name,
    code,
    address,
    city,
    state,
    country,
    postcode,
    parkedTrucksCount: parkedTrucksCount ?? 0,
    maxCapacity,
    status: status || "Active",
    establishedYear,
  });

  // Set staff
  if (staffIds && staffIds.length > 0) {
    await depotRepo.setStaff(depot.id, staffIds);
  }

  // Set product capacities
  if (productCapacities && productCapacities.length > 0) {
    for (const pc of productCapacities) {
      await depotRepo.upsertProductCapacity(depot.id, pc.product, pc.capacity);
    }
  }

  // Set product prices
  if (productPrices && productPrices.length > 0) {
    for (const pp of productPrices) {
      await depotRepo.upsertProductPrice(depot.id, pp.product, pp.currentPrice);
    }
  }

  const [capacities, prices, staff] = await Promise.all([
    depotRepo.getProductCapacities(depot.id),
    depotRepo.getProductPrices(depot.id),
    depotRepo.getStaff(depot.id),
  ]);

  res.status(201).json({
    success: true,
    message: "Depot created successfully",
    data: { depot: { ...depot, productCapacities: capacities, productPrices: prices, staff, staffIds: staff } },
  });
});

const updateDepot = asyncHandler(async (req, res) => {
  const depot = await depotRepo.findById(req.params.id);

  if (!depot) {
    return res.status(404).json({ success: false, message: "Depot not found" });
  }

  if (req.body.code !== undefined && req.body.code !== depot.code) {
    const existingDepot = await depotRepo.findByCode(req.body.code);
    if (existingDepot) {
      return res.status(400).json({
        success: false,
        message: `Depot with code "${req.body.code}" already exists`,
      });
    }
  }

  const allowedFields = [
    "name", "code", "address", "city", "state", "country", "postcode",
    "parkedTrucksCount", "maxCapacity", "status", "establishedYear",
  ];

  const updateData = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  }

  if (updateData.maxCapacity === undefined && Array.isArray(req.body.productCapacities) && req.body.productCapacities.length > 0) {
    const computed = req.body.productCapacities.reduce((sum, pc) => sum + (Number(pc.capacity) || 0), 0);
    if (computed > 0) {
      updateData.maxCapacity = computed;
    }
  }

  await depotRepo.update(depot.id, updateData);

  // Update staff if provided
  if (req.body.staffIds !== undefined) {
    await depotRepo.setStaff(depot.id, req.body.staffIds);
  }

  // Update product capacities if provided
  if (req.body.productCapacities !== undefined) {
    await depotRepo.setProductCapacities(depot.id, req.body.productCapacities);
  }

  /**
   * Editing a depot was a way round the approval.
   *
   * This endpoint accepts productPrices and used to write them straight to
   * current_price, so anybody who could edit a depot could reprice it without
   * a second person — which would have left the gate on the pricing page
   * guarding a door with no wall beside it. They are proposals here too.
   *
   * Depot CREATE below is deliberately left alone: a depot that does not exist
   * yet is selling nothing, and its opening prices are not a change to
   * anything.
   */
  if (req.body.productPrices !== undefined) {
    await depotRepo.proposePriceChanges({
      depotId: depot.id,
      items: req.body.productPrices.map((pp) => ({
        productId: pp.product,
        price: Number(pp.currentPrice),
      })),
      staffId: req.user?.id ?? null,
    });
  }

  const [capacities, prices, staff] = await Promise.all([
    depotRepo.getProductCapacities(depot.id),
    depotRepo.getProductPrices(depot.id),
    depotRepo.getStaff(depot.id),
  ]);

  res.json({
    success: true,
    message: "Depot updated successfully",
    data: { depot: { ...depot, ...updateData, productCapacities: capacities, productPrices: prices, staff, staffIds: staff } },
  });
});

const deleteDepot = asyncHandler(async (req, res) => {
  const depot = await depotRepo.findById(req.params.id);

  if (!depot) {
    return res.status(404).json({ success: false, message: "Depot not found" });
  }

  const references = [];
  // Check for referencing PFIs and orders
  const { db } = require("../../config/db");
  const { pfis, orders } = require("../../db/schema");
  const { eq, count } = require("drizzle-orm");

  const [{ pfiCount }] = await db.select({ pfiCount: count() }).from(pfis).where(eq(pfis.locationId, depot.id));
  const [{ orderCount }] = await db.select({ orderCount: count() }).from(orders).where(eq(orders.depotId, depot.id));

  if (pfiCount > 0) references.push(`${pfiCount} PFI(s)`);
  if (orderCount > 0) references.push(`${orderCount} order(s)`);

  if (references.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Cannot delete depot: it is referenced by ${references.join(", ")}`,
    });
  }

  await depotRepo.deleteById(depot.id);

  res.json({ success: true, message: "Depot deleted successfully" });
});

const updateProductPrice = asyncHandler(async (req, res) => {
  const { productId, price } = req.body;

  if (!productId || price === undefined || price === null) {
    return res.status(400).json({ success: false, message: "productId and price are required" });
  }

  const numericPrice = Number(price);
  if (isNaN(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ success: false, message: "Price must be a valid non-negative number" });
  }

  const depot = await depotRepo.findById(req.params.id);
  if (!depot) {
    return res.status(404).json({ success: false, message: "Depot not found" });
  }

  /**
   * Asked for, not applied.
   *
   * current_price is what an order is priced from — order.service.js reads it
   * as the server price and refuses the client's — so this used to put a new
   * price in front of every customer the moment somebody typed it. It now
   * waits for a second person. See migration 0047.
   */
  const { proposed, unchanged } = await depotRepo.proposePriceChanges({
    depotId: depot.id,
    items: [{ productId, price: numericPrice }],
    staffId: req.user?.id ?? null,
  });

  const [capacities, prices, staffList] = await Promise.all([
    depotRepo.getProductCapacities(depot.id),
    depotRepo.getProductPrices(depot.id),
    depotRepo.getStaff(depot.id),
  ]);

  res.json({
    success: true,
    message: proposed.length
      ? "Price change sent for approval — it goes live once approved"
      : "That is already the price in force",
    data: {
      change: proposed[0] || null,
      unchanged: unchanged.length,
      depot: { ...depot, productCapacities: capacities, productPrices: prices, staff: staffList },
    },
  });
});

/** What is waiting, and what has happened. Both read the same table. */
const listPriceChanges = asyncHandler(async (req, res) => {
  const changes = await depotRepo.listPriceChanges({
    depotId: req.query.depotId ? Number(req.query.depotId) : null,
    status: req.query.status || null,
    limit: req.query.limit ? Number(req.query.limit) : 200,
  });
  res.json({ success: true, data: { changes } });
});

/**
 * Approve a waiting price, which is what puts it in front of customers.
 *
 * Self-approval is allowed and recorded rather than refused: the trail names
 * both ends, so somebody approving their own is visible afterwards. That was
 * the desk's call — blocking it would strand a price whenever one person is
 * on duty.
 */
const approvePriceChange = asyncHandler(async (req, res) => {
  const result = await depotRepo.approvePriceChange({
    changeId: Number(req.params.changeId),
    staffId: req.user?.id ?? null,
    note: req.body?.note || "",
  });

  if (!result.ok) {
    return res.status(result.reason === "not_found" ? 404 : 409).json({
      success: false,
      message:
        result.reason === "not_found"
          ? "That price change no longer exists"
          : `That price change was already ${result.reason}`,
    });
  }

  res.json({
    success: true,
    message: `Price is live — ${result.price.currentPrice} per unit`,
    data: { change: result.change, price: result.price },
  });
});

/** Refuse a waiting price. The live one is not touched, by definition. */
const rejectPriceChange = asyncHandler(async (req, res) => {
  const row = await depotRepo.rejectPriceChange({
    changeId: Number(req.params.changeId),
    staffId: req.user?.id ?? null,
    note: req.body?.note || "",
  });
  if (!row) {
    return res
      .status(409)
      .json({ success: false, message: "That price change is no longer pending" });
  }
  res.json({ success: true, message: "Price change rejected", data: { change: row } });
});

/**
 * Take every product off sale at every depot — all prices to 0.
 *
 * Zero is how this system records "not sold here", so this closes the whole
 * book in one action. Deliberately its own endpoint rather than the client
 * looping over depots: thirteen separate requests can half-succeed, and half
 * the depots closed is a worse state than either end of the operation.
 *
 * Every row keeps its previous price in depot_price_history, and the audit row
 * carries how many moved, so this is reversible by hand and answerable after
 * the fact.
 */
const zeroAllProductPrices = asyncHandler(async (req, res) => {
  const result = await depotRepo.zeroAllProductPrices();

  await auditLogRepo.record({
    entityType: "depot",
    entityId: 0,
    action: "depot.prices_zeroed_all",
    actor: { type: "staff", staffId: req.user.id },
    metadata: {
      updated: result.updated,
      skipped: result.skipped,
      // What they were, so the change can be undone from the log alone.
      before: result.before,
    },
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({
    success: true,
    message:
      result.updated > 0
        ? `${result.updated} price${result.updated === 1 ? "" : "s"} set to 0. Those products are now off sale everywhere.`
        : "Every price was already 0 — nothing to change.",
    data: result,
  });
});

module.exports = {
  getDepots,
  getDepotById,
  createDepot,
  updateDepot,
  deleteDepot,
  updateProductPrice,
  listPriceChanges,
  approvePriceChange,
  rejectPriceChange,
  zeroAllProductPrices,
};
