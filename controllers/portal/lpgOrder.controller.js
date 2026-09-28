const asyncHandler = require("express-async-handler");
const { rolesFor } = require("../../notifications/staffChoices");
const { lpgOrderRequestRepo, lpgStationRepo, customerRepo } = require("../../repositories");
const { sendLpgRequestReceivedEmail } = require("../../services/email.service");
const { notify } = require("../../notifications");
const { withRequestExpiresAt } = require("../../services/requestExpiry.service");

/**
 * GET /api/lpg-catalog — public, read-only: open LPG stations with their price
 * per Kg and the cylinder sizes currently in stock. The customer-facing sibling
 * of /api/catalog, so the Cooking Gas flow can show real stations and prices.
 */
const getLpgCatalog = asyncHandler(async (req, res) => {
  const { stations } = await lpgStationRepo.findAll({ status: "Active", limit: 100 });

  const catalog = await Promise.all(
    stations.map(async (station) => {
      const cylinders = await lpgStationRepo.getCylinders(station.id);
      return {
        id: station.id,
        name: station.name,
        state: station.state,
        city: station.city,
        pricePerKg: Number(station.pricePerKg),
        cylinders: cylinders
          .filter((c) => c.quantity > 0)
          .map((c) => ({ sizeKg: c.cylinderSizeKg, available: c.quantity })),
      };
    })
  );

  res.json({ success: true, data: { stations: catalog } });
});

/**
 * POST /api/customer/lpg-orders — the signed-in customer places their OWN LPG
 * cooking-gas request. The customer id comes from the token, never the body.
 * It lands as Pending Review; staff review, price delivery, and approve it
 * through the same admin flow.
 */
const createMyLpgOrder = asyncHandler(async (req, res) => {
  const { lpgStationId, cylinderSizeKg, cylinderQuantity, deliveryAddress, deliveryState, deliveryLga } =
    req.body;

  const station = await lpgStationRepo.findById(Number(lpgStationId));
  if (!station) {
    return res.status(404).json({ success: false, message: "LPG station not found" });
  }

  const request = await lpgOrderRequestRepo.create({
    customerId: req.customer.id,
    lpgStationId: Number(lpgStationId),
    cylinderSizeKg: Number(cylinderSizeKg),
    cylinderQuantity: Number(cylinderQuantity),
    deliveryAddress,
    deliveryState: deliveryState || "",
    deliveryLga: deliveryLga || "",
    pricePerKg: String(station.pricePerKg || 0),
    status: "Pending Review",
  });
  // create() overwrites the insert filler with INITIALS+id — use that everywhere
  // so email / push / staff alerts match the ref the API returns.
  const requestNumber = request.requestNumber;

  const customer = await customerRepo.findById(req.customer.id);
  if (customer?.email) {
    try {
      await sendLpgRequestReceivedEmail(customer.email, {
        requestNumber,
        customerName: customer.name,
        cylinderSizeKg: Number(cylinderSizeKg),
        cylinderQuantity: Number(cylinderQuantity),
        deliveryAddress,
        deliveryState,
      });
    } catch (emailErr) {
      console.error("Failed to send LPG request email:", emailErr.message);
    }
  }

  // Acknowledgement in the app, plus the desk's heads-up. The email above is
  // unchanged — the catalog entry is APP_ONLY so nothing is sent twice.
  notify("lpg.request_received", {
    to: { customerId: req.customer.id },
    data: {
      requestId: request.id,
      requestNumber,
      customerName: customer?.name,
      cylinderSizeKg: Number(cylinderSizeKg),
      cylinderQuantity: Number(cylinderQuantity),
    },
  });
  notify("staff.request_submitted", {
    to: { roles: rolesFor("requests_submitted") },
    data: {
      requestId: request.id,
      requestNumber,
      kind: "LPG",
      customerName: customer?.name,
      entityType: "lpg_request",
      screen: "LpgOrderDetail",
      adminPath: `/lpg-orders/${request.id}`,
    },
  });

  const full = await lpgOrderRequestRepo.findByIdFull(request.id);
  res.status(201).json({
    success: true,
    message: "LPG cooking gas order request submitted",
    data: { request: full },
  });
});

/** GET /api/customer/lpg-orders — the customer's own requests, newest first. */
const listMyLpgOrders = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, status } = req.query;
  const result = await lpgOrderRequestRepo.findAll({
    customerId: req.customer.id,
    status,
    page,
    limit,
  });
  const requests = await withRequestExpiresAt(
    result.requests.map((r) => ({ ...r, _type: "lpg" }))
  );
  res.json({ success: true, data: { ...result, requests } });
});

/** GET /api/customer/lpg-orders/:id — one of the customer's own requests. */
const getMyLpgOrder = asyncHandler(async (req, res) => {
  const request = await lpgOrderRequestRepo.findByIdFull(Number(req.params.id));
  if (!request || request.customerId !== req.customer.id) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }
  const enriched = await withRequestExpiresAt({ ...request, _type: "lpg" });
  res.json({ success: true, data: { request: enriched } });
});

module.exports = { getLpgCatalog, createMyLpgOrder, listMyLpgOrders, getMyLpgOrder };
