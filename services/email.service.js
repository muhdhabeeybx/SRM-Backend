const { Resend } = require("resend");
const { virtualAccountName } = require("../utils/helpers");
const { documentEmail, em, formatMoney, lagosDate } = require("../notifications/templates/email");
const { quantity: smsQuantity } = require("../notifications/templates/sms");

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Every send in this file goes through here.
 *
 * These templates bypassed the notification engine — they are transactional
 * documents rendered by hand — and with it they bypassed the engine's kill
 * switch and its delivery log. So the test suite, which drives real order and
 * ticket flows against fixture addresses, sent real mail on the production
 * Resend key: 100 emails to @soroman.test in one run, which is the entire free
 * tier's daily quota. Nothing in the product could send for the rest of the
 * day, and nothing recorded why, because these sends are not in
 * notification_deliveries either.
 *
 * Two guards, because either alone has a hole. EMAIL_ENABLED=false is how the
 * test script and any dry run turn sending off; the reserved-domain check is
 * what saves us when someone forgets, since a .test or .example address is
 * reserved by RFC 2606 and can never belong to a real person.
 */
const RESERVED_RECIPIENT =
  /@([^@]*\.)?(test|example|invalid|localhost)$|@([^@]*\.)?example\.(com|net|org)$/i;

const emailEnabled = () =>
  process.env.EMAIL_ENABLED !== "false" && Boolean((process.env.RESEND_API_KEY || "").trim());

const sendMail = async (payload) => {
  const to = Array.isArray(payload.to) ? payload.to : [payload.to];

  if (!emailEnabled()) {
    console.log(`[email] EMAIL_ENABLED=false — not sending "${payload.subject}" to ${to.join(", ")}`);
    return { skipped: true };
  }

  const reserved = to.filter((address) => RESERVED_RECIPIENT.test(String(address || "").trim()));
  if (reserved.length) {
    console.warn(`[email] refusing a reserved-domain recipient: ${reserved.join(", ")}`);
    return { skipped: true };
  }

  // Every bespoke email (invoices, tickets, Dangote and LPG notices) leaves
  // here, so here is where it joins the message ledger.
  const messageLog = require("./messageLog.service");
  try {
    const result = await resend.emails.send(payload);
    for (const address of to) {
      await messageLog.record({
        channel: "email",
        provider: "resend",
        providerMessageId: to.length === 1 ? result?.data?.id || "" : "",
        recipient: address,
        subject: payload.subject || "",
        status: result?.error ? "failed" : "sent",
        error: result?.error?.message || null,
        tag: { type: payload.subject ? `email: ${String(payload.subject).slice(0, 56)}` : "email" },
      });
    }
    return result;
  } catch (err) {
    for (const address of to) {
      await messageLog.record({
        channel: "email", provider: "resend", recipient: address,
        subject: payload.subject || "", status: "failed", error: err.message, tag: { type: "email" },
      });
    }
    throw err;
  }
};

// NOTE: sendPasswordSetupEmail and sendPasswordResetEmail used to live here.
// Both are now catalog entries ("account.password_setup", "account.password_reset")
// in notifications/catalog.js. The documents below stay outside the
// notification engine on purpose — an invoice, the Dangote and LPG notices — since the engine
// deliberately does not re-send them, but they are drawn by the same
// documentEmail() as every other email, so the two families look like one.

const FROM = () => process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>";

const portalLink = (path) => {
  const base = String(process.env.PORTAL_URL || process.env.CLIENT_URL || "").replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
};

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/** "45,000 Litres" in the house spelling (records say "Liters", "Litres", "litres"). */
const quantityWithUnit = (value, unit) => smsQuantity(value, unit);

/** A date the record carries as an ISO string or a Date; "" when absent or unparseable. */
const day = (value) => (value ? lagosDate(value) : "");

/** "Pickup · Kano Depot (KAN)" / "Delivery · Kano". */
const collection = ({ deliveryType, depotName, depotCode, state }) => {
  const depot = depotName ? `${depotName}${depotCode ? ` (${depotCode})` : ""}` : "";
  return deliveryType === "delivery"
    ? `Delivery${state ? ` · ${state}` : ""}`
    : `Pickup${depot ? ` · ${depot}` : ""}`;
};

const NEXT_AFTER_TRANSFER =
  "As soon as our finance team confirms your transfer, we'll email your receipt and release your order.";

const send = (to, mail, extra = {}) =>
  sendMail({ from: FROM(), to, subject: mail.subject, html: mail.html, text: mail.text, ...extra });

const sendOrderInvoiceEmail = async (email, orderData) => {
  const {
    orderNumber,
    orderDate,
    customerName,
    companyName,
    customerPhone,
    product,
    sku,
    quantity,
    unit,
    price,
    totalAmount,
    deliveryType,
    depotName,
    depotCode,
    state,
    accountNumber,
    bankName,
    accountName,
  } = orderData;

  const due = formatMoney(totalAmount);
  const first = firstName(customerName);

  const mail = documentEmail({
    subject: `Invoice for order ${orderNumber} — ${due} due`,
    subtitle: "Invoice",
    preheader: `Pay ${due} to confirm order ${orderNumber}.`,
    hero: { tone: "pending", label: "Amount due", value: due, caption: `Invoice ${orderNumber} · ${day(orderDate) || day(Date.now())}` },
    heading: first ? `Here's your invoice, ${first}.` : "Here's your invoice.",
    blocks: [
      {
        type: "text",
        html: `Thank you for your order. Pay the amount due into the account below to confirm order ${em(orderNumber)}.`,
        plain: `Thank you for your order. Pay the amount due into the account below to confirm order ${orderNumber}.`,
        last: true,
      },
      {
        type: "table",
        title: "Invoice",
        rows: [
          { label: "Order reference", value: orderNumber },
          { label: "Date", value: day(orderDate) },
          { label: "Billed to", value: customerName },
          { label: "Company", value: companyName },
          { label: "Phone", value: customerPhone },
          { label: "Product", value: [product, sku && sku !== product ? `(${sku})` : ""].filter(Boolean).join(" ") },
          { label: "Quantity", value: quantityWithUnit(quantity, unit) },
          { label: "Unit price", value: formatMoney(price) },
          { label: "Collection", value: collection({ deliveryType, depotName, depotCode, state }) },
        ],
        total: { label: "Amount due", value: due },
      },
      { type: "payTo", accountNumber, bank: bankName, accountName: accountName || virtualAccountName(customerName) },
      { type: "next", text: NEXT_AFTER_TRANSFER },
      { type: "button", url: portalLink(`/orders/${encodeURIComponent(orderNumber)}`), label: "Track your order" },
      { type: "help" },
      { type: "signoff" },
    ],
  });

  await send(email, mail);
};

const sendDangoteRequestReceivedEmail = async (email, requestData) => {
  const { requestNumber, customerName, product, quantity, quantityUnit, deliveryAddress, deliveryState } = requestData;
  const first = firstName(customerName);

  const mail = documentEmail({
    subject: `We've received your Dangote delivery request ${requestNumber}`,
    subtitle: "Dangote delivery",
    preheader: `Request ${requestNumber} is with our team for review.`,
    hero: { tone: "pending", label: "Request received", caption: `Request ${requestNumber} · Under review` },
    heading: first ? `Thank you, ${first}.` : "Thank you for your request.",
    blocks: [
      { type: "text", text: "Your Dangote delivery request is with our team for review.", last: true },
      {
        type: "table",
        title: "Request",
        rows: [
          { label: "Request number", value: requestNumber },
          { label: "Product", value: product },
          { label: "Quantity", value: quantityWithUnit(quantity, quantityUnit) },
          { label: "Delivery address", value: [deliveryAddress, deliveryState].filter(Boolean).join(", ") },
        ],
      },
      {
        type: "next",
        text:
          "We'll review your request and set the price. Once it's approved, you'll receive a confirmation " +
          "email with the full pricing and payment details.",
      },
      { type: "help" },
      { type: "signoff" },
    ],
  });

  await send(email, mail);
};

const sendDangoteOrderConfirmedEmail = async (email, requestData) => {
  const {
    requestNumber,
    customerName,
    companyName,
    customerPhone,
    product,
    quantity,
    quantityUnit,
    pricePerUnit,
    deliveryPrice,
    totalAmount,
    deliveryAddress,
    deliveryState,
    expectedArrivalDate,
    accountNumber,
    bankName,
    accountName,
  } = requestData;
  const first = firstName(customerName);
  const total = formatMoney(totalAmount);

  const mail = documentEmail({
    subject: `Dangote order ${requestNumber} confirmed — ${total} to pay`,
    subtitle: "Dangote delivery",
    preheader: `Your Dangote delivery order is approved. Pay ${total} to complete it.`,
    hero: { tone: "pending", label: "Amount to pay", value: total, caption: `Order ${requestNumber} · Confirmed` },
    heading: first ? `Your order is confirmed, ${first}.` : "Your order is confirmed.",
    blocks: [
      {
        type: "text",
        text: "We've approved your Dangote delivery request. Pay the total below to complete your order.",
        last: true,
      },
      {
        type: "table",
        title: "Order",
        rows: [
          { label: "Order reference", value: requestNumber },
          { label: "Customer", value: customerName },
          { label: "Company", value: companyName },
          { label: "Phone", value: customerPhone },
          { label: "Product", value: product },
          { label: "Quantity", value: quantityWithUnit(quantity, quantityUnit) },
          { label: "Delivery address", value: [deliveryAddress, deliveryState].filter(Boolean).join(", ") },
          { label: "Expected arrival", value: day(expectedArrivalDate) || expectedArrivalDate },
          { label: "Price per unit", value: formatMoney(pricePerUnit) },
          { label: "Delivery", value: formatMoney(deliveryPrice) },
        ],
        total: { label: "Total amount", value: total },
      },
      { type: "payTo", accountNumber, bank: bankName, accountName: accountName || virtualAccountName(customerName) },
      {
        type: "next",
        text: "As soon as our finance team confirms your transfer, we'll be in touch to arrange dispatch.",
      },
      { type: "help" },
      { type: "signoff" },
    ],
  });

  await send(email, mail);
};

const sendLpgRequestReceivedEmail = async (email, requestData) => {
  const { requestNumber, customerName, cylinderSizeKg, cylinderQuantity, deliveryAddress, deliveryState } = requestData;
  const first = firstName(customerName);

  const mail = documentEmail({
    subject: `We've received your cooking gas request ${requestNumber}`,
    subtitle: "Cooking gas",
    preheader: `Request ${requestNumber} is with our team for review.`,
    hero: { tone: "pending", label: "Request received", caption: `Request ${requestNumber} · Under review` },
    heading: first ? `Thank you, ${first}.` : "Thank you for your request.",
    blocks: [
      { type: "text", text: "Your cooking gas home delivery request is with our team for review.", last: true },
      {
        type: "table",
        title: "Request",
        rows: [
          { label: "Request number", value: requestNumber },
          { label: "Cylinder size", value: cylinderSizeKg ? `${cylinderSizeKg} kg` : "" },
          { label: "Quantity", value: cylinderQuantity ? `${cylinderQuantity} cylinder${cylinderQuantity === 1 ? "" : "s"}` : "" },
          { label: "Delivery address", value: [deliveryAddress, deliveryState].filter(Boolean).join(", ") },
        ],
      },
      {
        type: "next",
        text:
          "We'll review your request and set the price. Once it's approved, you'll receive a confirmation " +
          "email with the full pricing and payment details.",
      },
      { type: "help" },
      { type: "signoff" },
    ],
  });

  await send(email, mail);
};

const sendLpgOrderConfirmedEmail = async (email, requestData) => {
  const {
    requestNumber,
    customerName,
    stationName,
    cylinderSizeKg,
    cylinderQuantity,
    pricePerKg,
    deliveryPrice,
    totalAmount,
    deliveryAddress,
    deliveryState,
    expectedArrivalDate,
    accountNumber,
    bankName,
    accountName,
  } = requestData;
  const first = firstName(customerName);
  const total = formatMoney(totalAmount);
  const totalKg = Number(cylinderSizeKg) * Number(cylinderQuantity);
  const cylinders = cylinderQuantity ? `${cylinderQuantity} cylinder${cylinderQuantity === 1 ? "" : "s"}` : "";

  const mail = documentEmail({
    subject: `Cooking gas order ${requestNumber} confirmed — ${total} to pay`,
    subtitle: "Cooking gas",
    preheader: `Your cooking gas order is approved. Pay ${total} to complete it.`,
    hero: { tone: "pending", label: "Amount to pay", value: total, caption: `Order ${requestNumber} · Confirmed` },
    heading: first ? `Your order is confirmed, ${first}.` : "Your order is confirmed.",
    blocks: [
      {
        type: "text",
        text: "We've approved your cooking gas request. Pay the total below to complete your order.",
        last: true,
      },
      {
        type: "table",
        title: "Order",
        rows: [
          { label: "Order reference", value: requestNumber },
          { label: "Station", value: stationName },
          { label: "Cylinder size", value: cylinderSizeKg ? `${cylinderSizeKg} kg` : "" },
          { label: "Quantity", value: [cylinders, Number.isFinite(totalKg) && totalKg ? `${totalKg.toLocaleString()} kg` : ""].filter(Boolean).join(" · ") },
          { label: "Delivery address", value: [deliveryAddress, deliveryState].filter(Boolean).join(", ") },
          { label: "Expected arrival", value: day(expectedArrivalDate) || expectedArrivalDate },
          { label: "Price per kg", value: formatMoney(pricePerKg) },
          { label: "Delivery", value: formatMoney(deliveryPrice) },
        ],
        total: { label: "Total amount", value: total },
      },
      { type: "payTo", accountNumber, bank: bankName, accountName: accountName || virtualAccountName(customerName) },
      { type: "next", text: "As soon as our finance team confirms your transfer, we'll be in touch to arrange delivery." },
      { type: "help" },
      { type: "signoff" },
    ],
  });

  await send(email, mail);
};

module.exports = {
  sendOrderInvoiceEmail,
  sendDangoteRequestReceivedEmail,
  sendDangoteOrderConfirmedEmail,
  sendLpgRequestReceivedEmail,
  sendLpgOrderConfirmedEmail,
};
