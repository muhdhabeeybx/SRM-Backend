const asyncHandler = require("express-async-handler");
const { rolesFor } = require("../../notifications/staffChoices");
const {
  dangoteProductRepo,
  dangoteOrderRequestRepo,
  customerRepo,
  customerLicenseRepo,
} = require("../../repositories");
const {
  sendDangoteRequestReceivedEmail,
  sendDangoteOrderConfirmedEmail,
} = require("../../services/email.service");
const { sendDangoteDeliveryOrderSMS } = require("../../services/sms.service");
const { notify } = require("../../notifications");
const walletService = require("../../services/wallet.service");
const dangoteOrderStatus = require("../../services/dangoteOrderStatus.service");
const { withRequestExpiresAt, expireIfStale } = require("../../services/requestExpiry.service");

// ── Dangote Products ──────────────────────────────────────────────────────

const getDangoteProducts = asyncHandler(async (req, res) => {
  const { search, status, page = 1, limit = 50 } = req.query;
  const result = await dangoteProductRepo.findAll({ search, status, page, limit });
  res.json({ success: true, data: result });
});

const getDangoteProductsActive = asyncHandler(async (req, res) => {
  const products = await dangoteProductRepo.findAllActive();
  res.json({ success: true, data: { products } });
});

const getDangoteProductById = asyncHandler(async (req, res) => {
  const product = await dangoteProductRepo.findById(Number(req.params.id));
  if (!product) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }
  res.json({ success: true, data: { product } });
});

const createDangoteProduct = asyncHandler(async (req, res) => {
  const { name, sku, category, unit, description, plants, status } = req.body;

  if (!name || !sku || !category) {
    return res.status(400).json({
      success: false,
      message: "Name, SKU, and category are required",
    });
  }

  const product = await dangoteProductRepo.create({
    name,
    sku: sku.toUpperCase(),
    category,
    unit: unit || "Tons",
    description: description || "",
    plants: typeof plants === "string" ? plants : JSON.stringify(plants || []),
    status: status || "Active",
  });

  res.status(201).json({ success: true, message: "Product created", data: { product } });
});

const updateDangoteProduct = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await dangoteProductRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Product not found" });
  }

  const updateData = { ...req.body };
  if (updateData.sku) updateData.sku = updateData.sku.toUpperCase();
  if (updateData.plants && typeof updateData.plants !== "string") {
    updateData.plants = JSON.stringify(updateData.plants);
  }

  const product = await dangoteProductRepo.update(id, updateData);
  res.json({ success: true, message: "Product updated", data: { product } });
});

// ── Dangote Order Requests ────────────────────────────────────────────────

const getDangoteOrderRequests = asyncHandler(async (req, res) => {
  const { search, status, paymentStatus, payable, page = 1, limit = 50 } = req.query;
  const result = await dangoteOrderRequestRepo.findAll({ search, status, paymentStatus, payable, page, limit });
  // Enrich every request with its computed expiresAt deadline
  const enriched = await withRequestExpiresAt(
    result.requests.map((r) => ({ ...r, _type: "dangote" }))
  );
  res.json({ success: true, data: { ...result, requests: enriched } });
});

const getDangoteOrderRequestById = asyncHandler(async (req, res) => {
  const request = await dangoteOrderRequestRepo.findByIdFull(Number(req.params.id));
  if (!request) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }
  const enriched = await withRequestExpiresAt({ ...request, _type: "dangote" });
  res.json({ success: true, data: { request: enriched } });
});

const createDangoteOrderRequest = asyncHandler(async (req, res) => {
  const {
    customerId, product, quantity, quantityUnit,
    deliveryAddress, deliveryState, deliveryLga,
    paymentReference, paymentMode,
    companyName, licenseId,
  } = req.body;

  if (!customerId || !product || !quantity || !deliveryAddress) {
    return res.status(400).json({
      success: false,
      message: "Customer, product, quantity, and delivery address are required",
    });
  }

  const customer = await customerRepo.findById(Number(customerId));
  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  const request = await dangoteOrderRequestRepo.create({
    customerId: customer.id,
    companyName: companyName || "",
    licenseId: licenseId ? Number(licenseId) : null,
    product,
    quantity: Number(quantity),
    quantityUnit: quantityUnit || "Tons",
    deliveryAddress,
    deliveryState: deliveryState || "",
    deliveryLga: deliveryLga || "",
    status: "Pending Review",
    paymentReference: paymentReference || "",
    paymentMode: paymentMode || "",
  });
  // create() overwrites the insert filler with INITIALS+id — use that everywhere
  // so email / push / staff alerts match the ref the API returns.
  const requestNumber = request.requestNumber;

  // Send "under review" email to customer
  if (customer.email) {
    try {
      await sendDangoteRequestReceivedEmail(customer.email, {
        requestNumber,
        customerName: customer.name,
        product,
        quantity: Number(quantity),
        quantityUnit: quantityUnit || "Tons",
        deliveryAddress,
        deliveryState,
      });
    } catch (emailErr) {
      console.error("Failed to send Dangote request email:", emailErr);
    }
  }

  // The "under review" email above is unchanged; these add the inbox row, the
  // push, and the desk's heads-up that a request is waiting to be priced.
  notify("dangote.request_received", {
    to: { customer },
    data: {
      requestId: request.id,
      requestNumber,
      customerName: customer.name,
      product,
      quantity: Number(quantity),
      quantityUnit: quantityUnit || "Tons",
    },
  });
  notify("staff.request_submitted", {
    to: { roles: rolesFor("requests_submitted") },
    data: {
      requestId: request.id,
      requestNumber,
      kind: "Dangote",
      customerName: customer.name,
      entityType: "dangote_request",
      screen: "DangoteOrderDetail",
      adminPath: `/dangote-orders/${request.id}`,
    },
  });

  const fullRequest = await dangoteOrderRequestRepo.findByIdFull(request.id);

  res.status(201).json({
    success: true,
    message: "Dangote delivery order request submitted successfully",
    data: { request: fullRequest },
  });
});

const reviewDangoteOrderRequest = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const {
    pricePerUnit,
    deliveryPrice,
    expectedArrivalDate,
    action,
    bankName,
    accountName,
    accountNumber,
    virtualAccountBank,
    virtualAccountName,
    virtualAccountNumber,
  } = req.body;

  const existing = await dangoteOrderRequestRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }

  if (existing.status !== "Pending Review") {
    return res.status(409).json({
      success: false,
      message: `Request is already ${existing.status}`,
    });
  }

  if (action === "reject") {
    await dangoteOrderStatus.transition(id, "Rejected", {
      actor: { type: "staff", staffId: req.user.id },
      set: { reviewedBy: req.user.id, reviewedAt: new Date() },
      action: "dangote_order.rejected",
    });
    const fullRequest = await dangoteOrderRequestRepo.findByIdFull(id);
    // A decline was previously silent — the customer had to notice the status
    // change themselves. They now hear about it in the app and by SMS.
    notify("dangote.rejected", {
      to: { customerId: existing.customerId },
      data: {
        requestId: id,
        requestNumber: fullRequest.requestNumber,
        customerName: fullRequest.customerName,
      },
    });
    return res.json({
      success: true,
      message: "Order request rejected",
      data: { request: fullRequest },
    });
  }

  // Approve
  if (!pricePerUnit) {
    return res.status(400).json({
      success: false,
      message: "Price per unit is required for approval",
    });
  }

  const finalBankName = (bankName || virtualAccountBank || "").trim();
  const finalAccountName = (accountName || virtualAccountName || "").trim();
  const finalAccountNumber = (accountNumber || virtualAccountNumber || "").trim();

  if (!finalBankName || !finalAccountName || !finalAccountNumber) {
    return res.status(400).json({
      success: false,
      message: "Bank name, account name, and account number are required for approval",
    });
  }

  // Check licence status before allowing approval
  if (existing.licenseId) {
    const license = await customerLicenseRepo.findById(existing.licenseId);
    if (license && license.status !== "approved") {
      return res.status(400).json({
        success: false,
        message: "Cannot approve order: the associated licence must be approved first",
      });
    }
  }

  const totalAmount = (Number(pricePerUnit) * existing.quantity) + Number(deliveryPrice || 0);

  const { order: updated } = await dangoteOrderStatus.transition(id, "Approved", {
    actor: { type: "staff", staffId: req.user.id },
    set: {
      pricePerUnit: String(pricePerUnit),
      deliveryPrice: String(deliveryPrice || 0),
      totalAmount: String(totalAmount),
      expectedArrivalDate: expectedArrivalDate || "",
      virtualAccountNumber: finalAccountNumber,
      virtualAccountBank: finalBankName,
      virtualAccountName: finalAccountName,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    },
    action: "dangote_order.approved",
    metadata: { totalAmount: String(totalAmount) },
  });

  // Store bank details on the request record
  await dangoteOrderRequestRepo.update(id, {
    virtualAccountNumber: finalAccountNumber,
    virtualAccountBank: finalBankName,
    virtualAccountName: finalAccountName,
  });

  const fullRequest = await dangoteOrderRequestRepo.findByIdFull(updated.id);

  // Send confirmation email with bank payment details
  if (fullRequest.customerEmail) {
    try {
      await sendDangoteOrderConfirmedEmail(fullRequest.customerEmail, {
        requestNumber: fullRequest.requestNumber,
        customerName: fullRequest.customerName,
        companyName: fullRequest.companyName,
        customerPhone: fullRequest.customerPhone,
        product: fullRequest.product,
        quantity: fullRequest.quantity,
        quantityUnit: fullRequest.quantityUnit,
        pricePerUnit: Number(pricePerUnit),
        deliveryPrice: Number(deliveryPrice || 0),
        totalAmount,
        deliveryAddress: fullRequest.deliveryAddress,
        deliveryState: fullRequest.deliveryState,
        expectedArrivalDate: expectedArrivalDate || "",
        accountNumber: finalAccountNumber,
        bankName: finalBankName,
        accountName: finalAccountName,
      });
    } catch (emailErr) {
      console.error("Failed to send Dangote confirmation email:", emailErr);
    }
  }

  // Send SMS with order summary and payment details
  const customer = await customerRepo.findById(existing.customerId);
  if (customer?.phone) {
    try {
      await sendDangoteDeliveryOrderSMS(customer.phone, {
        requestNumber: fullRequest.requestNumber,
        customerName: fullRequest.customerName,
        product: fullRequest.product,
        quantity: fullRequest.quantity,
        quantityUnit: fullRequest.quantityUnit,
        totalAmount,
        accountNumber: finalAccountNumber,
        bankName: finalBankName,
        accountName: finalAccountName,
      });
    } catch (smsErr) {
      console.error("Failed to send Dangote delivery SMS:", smsErr);
    }
  }

  // Confirmation email and payment SMS above stay as they are; this adds the
  // inbox row and push so the approval also lands in the app.
  notify("dangote.confirmed", {
    to: { customerId: updated.customerId },
    data: {
      requestId: updated.id,
      requestNumber: fullRequest.requestNumber,
      customerName: fullRequest.customerName,
      product: fullRequest.product,
      quantity: fullRequest.quantity,
      quantityUnit: fullRequest.quantityUnit,
      totalAmount,
    },
  });

  res.json({
    success: true,
    message: "Order request approved, confirmation email and SMS sent",
    data: { request: fullRequest },
  });
});

const updateDangoteOrderPaymentStatus = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { paymentStatus } = req.body;

  if (!paymentStatus || !["Unpaid", "Paid"].includes(paymentStatus)) {
    return res.status(400).json({
      success: false,
      message: "Valid payment status is required (Unpaid or Paid)",
    });
  }

  const existing = await dangoteOrderRequestRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }

  const updated = await dangoteOrderRequestRepo.update(id, { paymentStatus });
  const fullRequest = await dangoteOrderRequestRepo.findByIdFull(updated.id);

  res.json({
    success: true,
    message: `Payment status updated to ${paymentStatus}`,
    data: { request: fullRequest },
  });
});

const updateDangoteOrderCollectionStatus = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { collectionStatus } = req.body;

  if (!collectionStatus || !["Pending", "Dispatched", "Collected"].includes(collectionStatus)) {
    return res.status(400).json({
      success: false,
      message: "Valid collection status is required (Pending, Dispatched, or Collected)",
    });
  }

  const existing = await dangoteOrderRequestRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }

  const updated = await dangoteOrderRequestRepo.update(id, { collectionStatus });
  const fullRequest = await dangoteOrderRequestRepo.findByIdFull(updated.id);

  res.json({
    success: true,
    message: `Collection status updated to ${collectionStatus}`,
    data: { request: fullRequest },
  });
});

/** Staff desk list: approved unpaid quotes whose wallet balance covers the total. */
const getPayableDangoteOrders = asyncHandler(async (req, res) => {
  const orders = await dangoteOrderRequestRepo.findPayableDangoteOrders();
  res.json({ success: true, data: { orders } });
});

/**
 * Staff finance: settle an approved unpaid Dangote quote from the customer's
 * wallet balance. Customer self-serve wallet pay is removed; this desk path stays.
 */
const payDangoteOrder = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const wasExpired = await expireIfStale({ requestId: id, type: "dangote" });
  if (wasExpired) {
    return res.status(409).json({
      success: false,
      message: "This order has expired because payment wasn't received in time.",
    });
  }

  const existing = await dangoteOrderRequestRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }
  if (existing.paymentStatus === "Paid") {
    return res.status(409).json({ success: false, message: "Order is already paid" });
  }
  if (existing.status === "Expired") {
    return res.status(409).json({ success: false, message: "This order has expired." });
  }
  if (existing.status !== "Approved") {
    return res.status(409).json({ success: false, message: `Cannot pay an order in ${existing.status} status` });
  }

  const totalAmount = Number(existing.totalAmount);
  if (!totalAmount || totalAmount <= 0) {
    return res.status(400).json({ success: false, message: "Order total is invalid" });
  }

  const customer = await customerRepo.findById(existing.customerId);
  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  const debitResult = await walletService.debit({
    customerId: customer.id,
    amount: totalAmount,
    description: `Payment for Dangote Order ${existing.requestNumber}`,
    reference: `DNG-PAY-${existing.id}`,
  });

  if (!debitResult.success) {
    if (debitResult.insufficient) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Required: ₦${totalAmount.toLocaleString()}, Available: ₦${Number(customer.balance).toLocaleString()}`,
      });
    }
    return res.status(400).json({ success: false, message: debitResult.message || "Payment failed" });
  }

  const updated = await dangoteOrderRequestRepo.update(id, {
    paymentStatus: "Paid",
    paymentMode: "wallet",
    paymentReference: debitResult.deposit?.reference || `DNG-PAY-${existing.id}`,
  });

  const fullRequest = await dangoteOrderRequestRepo.findByIdFull(updated.id);

  res.json({
    success: true,
    message: `Dangote order ${existing.requestNumber} paid successfully from wallet`,
    data: { request: fullRequest },
  });
});

module.exports = {
  getDangoteProducts,
  getDangoteProductsActive,
  getDangoteProductById,
  createDangoteProduct,
  updateDangoteProduct,
  getDangoteOrderRequests,
  getDangoteOrderRequestById,
  createDangoteOrderRequest,
  reviewDangoteOrderRequest,
  updateDangoteOrderPaymentStatus,
  updateDangoteOrderCollectionStatus,
  getPayableDangoteOrders,
  payDangoteOrder,
};
