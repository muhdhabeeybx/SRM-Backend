const QRCode = require("qrcode");
const { db } = require("../config/db");
const { orderRepo, ticketRepo, customerRepo } = require("../repositories");
const { sendTicketSummarySMS } = require("./sms.service");
const { notify } = require("../notifications");

/**
 * Issue the ticket for a single truck load, idempotently, inside the caller's
 * transaction (the "mark loaded" step). One ticket per load, numbered
 * TCK-<orderSuffix>-<truckIndex>, linked by order_truck_id. Kept lean — no
 * email/SMS here; those are the per-order buyer notifications. Returns the
 * existing ticket if this load already has one, so a repeated load call is safe.
 */
const generateTicketForTruck = async (order, load, tx = db) => {
  const existing = await ticketRepo.findByOrderTruck(load.id, tx);
  if (existing) return existing;

  const suffix = order.id;
  const ticketNumber = `TCK-${suffix}-${load.truckIndex}`;

  const created = await ticketRepo.create(
    {
      ticketNumber,
      orderId: order.id,
      orderTruckId: load.id,
      status: "Active",
      qrCodeDataUrl: "placeholder",
    },
    tx
  );

  const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
  const qrCodeDataUrl = await QRCode.toDataURL(`${clientUrl}/ticket/details?id=${created.id}`, {
    margin: 1,
    width: 300,
  });

  return ticketRepo.update(created.id, { qrCodeDataUrl }, tx);
};

const generateTicketForOrder = async (orderIdOrDoc) => {
  try {
    let order;
    if (typeof orderIdOrDoc === "object" && orderIdOrDoc.id) {
      order = orderIdOrDoc;
    } else {
      order = await orderRepo.findByIdFull(orderIdOrDoc);
    }

    if (!order) {
      throw new Error("Order not found");
    }

    const existingTicket = await ticketRepo.findByOrder(order.id);
    if (existingTicket) {
      return { success: true, ticket: existingTicket, message: "Ticket already generated" };
    }

    const suffix = order.id;
    const ticketNumber = `TCK-${suffix}`;

    const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

    // Create ticket with placeholder QR
    const savedTicket = await ticketRepo.create({
      ticketNumber,
      orderId: order.id,
      status: "Active",
      qrCodeDataUrl: "placeholder",
    });

    const qrCodeUrl = `${clientUrl}/ticket/details?id=${savedTicket.id}`;
    const qrCodeDataUrl = await QRCode.toDataURL(qrCodeUrl, {
      margin: 1,
      width: 300,
    });

    const updatedTicket = await ticketRepo.update(savedTicket.id, {
      qrCodeDataUrl,
    });

    const customer = await customerRepo.findById(order.customerId);
    if (!customer) {
      throw new Error("Customer not found for this order");
    }

    const ticketData = {
      ticketNumber: updatedTicket.ticketNumber,
      qrCodeDataUrl,
      customerName: customer.name,
      companyName: customer.companyName || "",
      customerPhone: customer.phone || "",
      customerEmail: customer.email || "",
      productName: order.productName || "N/A",
      productSku: order.productSku || "",
      productCategory: order.productCategory || "",
      quantity: order.quantity,
      unit: order.productUnit || "Liters",
      unitPrice: order.price,
      orderNumber: order.orderNumber,
      orderDate: order.createdAt,
      depotName: order.depotName || "N/A",
      depotCode: order.depotCode || "",
      depotAddress: order.depotAddress || "",
      state: order.state,
      totalAmount: order.totalAmount,
      deliveryType: order.deliveryType,
      virtualAccountNumber: order.virtualAccountNumber || "",
      virtualAccountBank: order.virtualAccountBank || "",
    };

    // No ticket email: it arrived at the same moment as the payment receipt
    // (order.paid), which already carries the order, the amount and the next
    // step, so the customer was getting two emails about one payment. The SMS
    // and the in-app notice below stay.
    if (customer.phone) {
      try {
        await sendTicketSummarySMS(customer.phone, ticketData);
      } catch (smsErr) {
        console.error("Failed to send ticket SMS:", smsErr.message);
      }
    }

    // The inbox row and push, so the ticket is reachable in the app. The
    // catalog entry is APP_ONLY so nothing here is sent twice.
    notify("ticket.issued", {
      to: { customer },
      data: {
        ticketId: updatedTicket?.id,
        ticketNumber: ticketData.ticketNumber,
        orderId: order.id,
        orderNumber: order.orderNumber,
        reference: order.orderNumber,
        customerName: customer.name,
        deliveryType: order.deliveryType,
        depotName: order.depotName || "",
      },
    });

    return { success: true, ticket: updatedTicket };
  } catch (error) {
    console.error("Error in generateTicketForOrder:", error);
    return { success: false, error: error.message };
  }
};

module.exports = { generateTicketForOrder, generateTicketForTruck };
