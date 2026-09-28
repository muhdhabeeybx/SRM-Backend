const asyncHandler = require("express-async-handler");
const { rolesFor } = require("../../notifications/staffChoices");
const {
  lpgOrderRequestRepo,
  lpgStationRepo,
  customerRepo,
  bankAccountRepo,
} = require("../../repositories");
const {
  sendLpgRequestReceivedEmail,
  sendLpgOrderConfirmedEmail,
} = require("../../services/email.service");
// Paystack DVA creation/subaccount-switch and the station auto-split
// transfer are disabled — see the DVA block in reviewLpgOrderRequest and the
// station-transfer block in payLpgOrder below. Re-add this import if
// reinstating either:
// const { createDedicatedAccount, switchCustomerDvaToSubaccount, transferToStationSubaccount } = require("../../services/payment.service");
const { sendLpgOrderSMS } = require("../../services/sms.service");
const { notify } = require("../../notifications");
const walletService = require("../../services/wallet.service");
const lpgOrderStatus = require("../../services/lpgOrderStatus.service");
const { withRequestExpiresAt, expireIfStale } = require("../../services/requestExpiry.service");

const getLpgOrderRequests = asyncHandler(async (req, res) => {
  const { search, status, page = 1, limit = 50 } = req.query;
  const result = await lpgOrderRequestRepo.findAll({ search, status, page, limit });
  // Enrich every request with its computed expiresAt deadline
  const enriched = await withRequestExpiresAt(
    result.requests.map((r) => ({ ...r, _type: "lpg" }))
  );
  res.json({ success: true, data: { ...result, requests: enriched } });
});

const getLpgOrderRequestById = asyncHandler(async (req, res) => {
  const request = await lpgOrderRequestRepo.findByIdFull(Number(req.params.id));
  if (!request) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }
  const enriched = await withRequestExpiresAt({ ...request, _type: "lpg" });
  res.json({ success: true, data: { request: enriched } });
});

const createLpgOrderRequest = asyncHandler(async (req, res) => {
  const {
    customerId, lpgStationId, cylinderSizeKg, cylinderQuantity,
    deliveryAddress, deliveryState, deliveryLga,
  } = req.body;

  if (!customerId || !lpgStationId || !cylinderSizeKg || !cylinderQuantity || !deliveryAddress) {
    return res.status(400).json({
      success: false,
      message: "Customer, LPG station, cylinder size, cylinder quantity, and delivery address are required",
    });
  }

  const customer = await customerRepo.findById(Number(customerId));
  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  const station = await lpgStationRepo.findById(Number(lpgStationId));
  if (!station) {
    return res.status(404).json({ success: false, message: "LPG station not found" });
  }

  const request = await lpgOrderRequestRepo.create({
    customerId: customer.id,
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

  if (customer.email) {
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
      console.error("Failed to send LPG request email:", emailErr);
    }
  }

  // The "under review" email above is unchanged; these add the inbox row, the
  // push, and the desk's heads-up that a request is waiting to be priced.
  notify("lpg.request_received", {
    to: { customer },
    data: {
      requestId: request.id,
      requestNumber,
      customerName: customer.name,
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
      customerName: customer.name,
      entityType: "lpg_request",
      screen: "LpgOrderDetail",
      adminPath: `/lpg-orders/${request.id}`,
    },
  });

  const fullRequest = await lpgOrderRequestRepo.findByIdFull(request.id);

  res.status(201).json({
    success: true,
    message: "LPG cooking gas order request submitted successfully",
    data: { request: fullRequest },
  });
});

const reviewLpgOrderRequest = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { deliveryPrice, expectedArrivalDate, action } = req.body;

  const existing = await lpgOrderRequestRepo.findById(id);
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
    await lpgOrderStatus.transition(id, "Rejected", {
      actor: { type: "staff", staffId: req.user.id },
      set: { reviewedBy: req.user.id, reviewedAt: new Date() },
      action: "lpg_order.rejected",
    });
    const fullRequest = await lpgOrderRequestRepo.findByIdFull(id);
    return res.json({
      success: true,
      message: "Order request rejected",
      data: { request: fullRequest },
    });
  }

  const pricePerKg = Number(existing.pricePerKg) || 0;
  if (!pricePerKg) {
    return res.status(400).json({
      success: false,
      message: "Station price per Kg is not set. Please update the LPG station pricing first.",
    });
  }

  // Check cylinder stock before approval
  const stockResult = await lpgStationRepo.getCylinderStock(
    existing.lpgStationId,
    existing.cylinderSizeKg
  );
  if (!stockResult) {
    return res.status(400).json({
      success: false,
      message: "Cylinder stock not found for this station and size",
    });
  }
  if (stockResult.quantity < existing.cylinderQuantity) {
    return res.status(400).json({
      success: false,
      message: `Insufficient cylinder stock. Available: ${stockResult.quantity}, Requested: ${existing.cylinderQuantity}`,
    });
  }

  const totalWeightKg = Number(existing.cylinderSizeKg) * Number(existing.cylinderQuantity);
  const totalAmount = (pricePerKg * totalWeightKg) + Number(deliveryPrice || 0);

  // Decrement cylinder inventory
  const decrementResult = await lpgStationRepo.decrementCylinderQuantity(
    existing.lpgStationId,
    existing.cylinderSizeKg,
    existing.cylinderQuantity
  );
  if (!decrementResult.success) {
    return res.status(400).json({
      success: false,
      message: decrementResult.message || "Failed to update cylinder inventory",
    });
  }

  const { order: updated } = await lpgOrderStatus.transition(id, "Approved", {
    actor: { type: "staff", staffId: req.user.id },
    set: {
      deliveryPrice: String(deliveryPrice || 0),
      totalAmount: String(totalAmount),
      expectedArrivalDate: expectedArrivalDate || "",
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    },
    action: "lpg_order.approved",
    metadata: { totalAmount: String(totalAmount), cylinders: existing.cylinderQuantity },
  });

  const customer = await customerRepo.findById(existing.customerId);

  /* --- Paystack DVA funding (disabled — manual deposit only) ---------------
   * Every customer used to get a personal DVA on first LPG order approval,
   * immediately split to the station's Paystack subaccount. Wallet funding
   * is manual-deposit-only now; the station's own bank account (looked up
   * below) is what shows on the confirmation email/SMS instead. Kept for
   * reinstatement — restore this block, drop the station-bank-account lookup
   * beneath it, and uncomment the payment.service.js import above.
   *
   * let virtualAccountNumber = customer?.virtualAccountNumber || "";
   * let virtualAccountBank = customer?.virtualAccountBank || "";
   * let virtualAccountName = customer?.virtualAccountName || "";
   *
   * if (!virtualAccountNumber && customer) {
   *   try {
   *     const accountResult = await createDedicatedAccount(customer);
   *     if (accountResult.success) {
   *       virtualAccountNumber = accountResult.data.accountNumber;
   *       virtualAccountBank = accountResult.data.bankName;
   *       virtualAccountName =
   *         accountResult.data.accountName ||
   *         formatVirtualAccountName(customer.name);
   *       const updateData = {
   *         virtualAccountNumber,
   *         virtualAccountBank,
   *         virtualAccountName,
   *       };
   *       if (accountResult.data.paystackCustomerId) {
   *         updateData.paystackCustomerId = accountResult.data.paystackCustomerId;
   *       }
   *       await customerRepo.update(customer.id, updateData);
   *     } else {
   *       console.error("Failed to create DVA for customer:", accountResult.message);
   *     }
   *   } catch (dvaErr) {
   *     console.error("DVA creation error:", dvaErr.message);
   *   }
   * } else if (!virtualAccountName && customer) {
   *   virtualAccountName = formatVirtualAccountName(customer.name);
   *   await customerRepo.update(customer.id, { virtualAccountName });
   * }
   *
   * // Automatically switch customer DVA to LPG station Paystack Subaccount
   * const station = await lpgStationRepo.findById(existing.lpgStationId);
   * const stationSubaccountCode = station?.paystackSubaccountCode || station?.paystack_subaccount_code;
   * if (virtualAccountNumber && stationSubaccountCode && customer) {
   *   try {
   *     await switchCustomerDvaToSubaccount({
   *       accountNumber: virtualAccountNumber,
   *       subaccountCode: stationSubaccountCode,
   *     });
   *     await customerRepo.update(customer.id, { dvaSubaccountCode: stationSubaccountCode });
   *   } catch (dvaErr) {
   *     console.error(`[reviewLpgOrderRequest] Failed to switch DVA to subaccount for station ${station?.id}:`, dvaErr.message);
   *   }
   * }
   * --------------------------------------------------------------------- */

  // The account the customer pays into is the LPG station's own bank
  // account, set up by an admin on the dashboard (Bank Accounts, linked to
  // this station) — not a per-customer virtual account.
  const station = await lpgStationRepo.findById(existing.lpgStationId);
  const stationBankAccounts = station
    ? await bankAccountRepo.findAll({ lpgStationId: station.id, status: "Active" })
    : [];
  const stationBankAccount = stationBankAccounts.find((a) => a.isDefault) || stationBankAccounts[0];
  const virtualAccountNumber = stationBankAccount?.accountNumber || "";
  const virtualAccountBank = stationBankAccount?.bankName || "";
  const virtualAccountName = stationBankAccount?.accountName || "";

  await lpgOrderRequestRepo.update(id, {
    virtualAccountNumber,
    virtualAccountBank,
    virtualAccountName,
  });

  const fullRequest = await lpgOrderRequestRepo.findByIdFull(updated.id);

  if (fullRequest.customerEmail) {
    try {
      await sendLpgOrderConfirmedEmail(fullRequest.customerEmail, {
        requestNumber: fullRequest.requestNumber,
        customerName: fullRequest.customerName,
        stationName: fullRequest.stationName,
        cylinderSizeKg: fullRequest.cylinderSizeKg,
        cylinderQuantity: fullRequest.cylinderQuantity,
        pricePerKg: pricePerKg,
        deliveryPrice: Number(deliveryPrice || 0),
        totalAmount,
        deliveryAddress: fullRequest.deliveryAddress,
        deliveryState: fullRequest.deliveryState,
        expectedArrivalDate: expectedArrivalDate || "",
        accountNumber: virtualAccountNumber,
        bankName: virtualAccountBank,
        accountName: virtualAccountName,
      });
    } catch (emailErr) {
      console.error("Failed to send LPG confirmation email:", emailErr);
    }
  }

  if (customer?.phone) {
    try {
      await sendLpgOrderSMS(customer.phone, {
        requestNumber: fullRequest.requestNumber,
        customerName: fullRequest.customerName,
        cylinderSizeKg: fullRequest.cylinderSizeKg,
        cylinderQuantity: fullRequest.cylinderQuantity,
        totalAmount,
        accountNumber: virtualAccountNumber,
        bankName: virtualAccountBank,
        accountName: virtualAccountName,
      });
    } catch (smsErr) {
      console.error("Failed to send LPG order SMS:", smsErr);
    }
  }

  // Confirmation email and payment SMS above stay as they are; this adds the
  // inbox row and push so the approval also lands in the app.
  notify("lpg.confirmed", {
    to: { customerId: updated.customerId },
    data: {
      requestId: updated.id,
      requestNumber: fullRequest.requestNumber,
      customerName: fullRequest.customerName,
      cylinderSizeKg: fullRequest.cylinderSizeKg,
      cylinderQuantity: fullRequest.cylinderQuantity,
      totalAmount,
    },
  });

  res.json({
    success: true,
    message: "Order request approved, confirmation email and SMS sent",
    data: { request: fullRequest },
  });
});

const updateLpgOrderPaymentStatus = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { paymentStatus } = req.body;

  if (!paymentStatus || !["Unpaid", "Paid"].includes(paymentStatus)) {
    return res.status(400).json({
      success: false,
      message: "Valid payment status is required (Unpaid or Paid)",
    });
  }

  const existing = await lpgOrderRequestRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }

  const updated = await lpgOrderRequestRepo.update(id, { paymentStatus });
  const fullRequest = await lpgOrderRequestRepo.findByIdFull(updated.id);

  res.json({
    success: true,
    message: `Payment status updated to ${paymentStatus}`,
    data: { request: fullRequest },
  });
});

const updateLpgOrderCollectionStatus = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { collectionStatus } = req.body;

  if (!collectionStatus || !["Pending", "Dispatched", "Collected"].includes(collectionStatus)) {
    return res.status(400).json({
      success: false,
      message: "Valid collection status is required (Pending, Dispatched, or Collected)",
    });
  }

  const existing = await lpgOrderRequestRepo.findById(id);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Order request not found" });
  }

  const updated = await lpgOrderRequestRepo.update(id, { collectionStatus });
  const fullRequest = await lpgOrderRequestRepo.findByIdFull(updated.id);

  res.json({
    success: true,
    message: `Collection status updated to ${collectionStatus}`,
    data: { request: fullRequest },
  });
});

const getPayableLpgOrders = asyncHandler(async (req, res) => {
  const orders = await lpgOrderRequestRepo.findPayableLpgOrders();
  res.json({ success: true, data: { orders } });
});

const payLpgOrder = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  // Pre-payment guard: if the request has lapsed, expire it and refuse.
  const wasExpired = await expireIfStale({ requestId: id, type: "lpg" });
  if (wasExpired) {
    return res.status(409).json({
      success: false,
      message: "This order has expired because payment wasn't received in time.",
    });
  }

  const existing = await lpgOrderRequestRepo.findById(id);
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
    description: `Payment for LPG Order ${existing.requestNumber}`,
    reference: `LPG-PAY-${existing.id}`,
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

  const updated = await lpgOrderRequestRepo.update(id, {
    paymentStatus: "Paid",
    paymentMode: "wallet",
    paymentReference: debitResult.deposit?.reference || `LPG-PAY-${existing.id}`,
  });

  const fullRequest = await lpgOrderRequestRepo.findByIdFull(updated.id);

  // Paystack auto-split transfer (disabled — manual deposit only): the
  // station is paid directly by the customer into its own bank account, so
  // there's no merchant-balance share to push out. Re-add the
  // transferToStationSubaccount import above to reinstate:
  // try {
  //   if (fullRequest) {
  //     await transferToStationSubaccount(fullRequest);
  //   }
  // } catch (subErr) {
  //   console.error(`[payLpgOrder] station subaccount transfer failed for order ${existing.requestNumber}:`, subErr.message);
  // }

  res.json({
    success: true,
    message: `LPG order ${existing.requestNumber} paid successfully from wallet`,
    data: { request: fullRequest },
  });
});

/**
 * Cancel an order request and, if it had been approved, return its reserved
 * cylinders to the station's stock — closing the leak where an approved-then-
 * abandoned order kept inventory decremented forever. Refuses a paid order
 * (reverse the payment first) or one already in fulfilment.
 */
const cancelLpgOrderRequest = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  // The state machine locks the row, refuses an illegal move (already
  // Cancelled/Rejected → 409) or an order already in fulfilment (guard), writes
  // the Cancelled status + an audit row atomically, and reports the prior state.
  // A paid order is allowed — it is reversed below rather than blocked.
  const { order, prevState } = await lpgOrderStatus.transition(id, "Cancelled", {
    actor: { type: "staff", staffId: req.user.id },
    set: { reviewedBy: req.user.id, reviewedAt: new Date() },
    action: "lpg_order.cancelled",
    guard: (o) => {
      if (o.collectionStatus && o.collectionStatus !== "Pending") {
        return { status: 409, message: `Cannot cancel an order already ${o.collectionStatus} — the gas has left` };
      }
      return null;
    },
  });

  // An approved order had its cylinders decremented — return them to stock.
  if (prevState === "Approved") {
    await lpgStationRepo.incrementCylinderQuantity(
      order.lpgStationId,
      order.cylinderSizeKg,
      order.cylinderQuantity
    );
  }

  // A paid order is refunded to the customer's wallet (idempotent by reference),
  // and its payment marked Refunded.
  let refunded = false;
  const total = Number(order.totalAmount);
  if (order.paymentStatus === "Paid" && total > 0) {
    await walletService.credit({
      customerId: order.customerId,
      amount: total,
      description: `Refund for cancelled LPG Order ${order.requestNumber}`,
      reference: `LPG-REFUND-${order.id}`,
    });
    await lpgOrderRequestRepo.update(id, { paymentStatus: "Refunded" });
    refunded = true;
  }

  const parts = ["Order request cancelled"];
  if (prevState === "Approved") parts.push("reserved cylinders returned to stock");
  if (refunded) parts.push(`₦${total.toLocaleString()} refunded to wallet`);

  const fullRequest = await lpgOrderRequestRepo.findByIdFull(id);
  res.json({ success: true, message: parts.join("; "), data: { request: fullRequest } });
});

module.exports = {
  getLpgOrderRequests,
  getLpgOrderRequestById,
  createLpgOrderRequest,
  reviewLpgOrderRequest,
  updateLpgOrderPaymentStatus,
  updateLpgOrderCollectionStatus,
  getPayableLpgOrders,
  payLpgOrder,
  cancelLpgOrderRequest,
};
