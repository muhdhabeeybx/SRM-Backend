const { Resend } = require("resend");
const { virtualAccountName } = require("../utils/helpers");

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// NOTE: sendPasswordSetupEmail and sendPasswordResetEmail used to live here.
// Both are now catalog entries ("account.password_setup", "account.password_reset")
// in notifications/catalog.js, so the staff invite and reset mails are rendered
// from the shared shell and recorded in notification_deliveries like every
// other send. The templates below stay hand-written on purpose: they are
// transactional documents — an invoice, a QR ticket — whose exact layout is the
// point, and the notification engine deliberately does not re-send them.

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

  const formattedAmount = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(totalAmount);

  const formattedPrice = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(price);

  const formattedDate = orderDate
    ? new Date(orderDate).toLocaleDateString("en-NG", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    : "N/A";

  await sendMail({
    from: process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>",
    to: email,
    subject: `Invoice for Order ${orderNumber} - Soroman`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                  <!-- Header -->
                  <tr>
                    <td style="background:linear-gradient(135deg,#0d9488,#0f766e);padding:32px 40px;">
                      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Soroman</h1>
                      <p style="margin:8px 0 0;color:#ccfbf1;font-size:14px;">Order Invoice</p>
                    </td>
                  </tr>
                  <!-- Invoice Info -->
                  <tr>
                    <td style="padding:40px;">
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td>
                            <p style="margin:0;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Invoice</p>
                            <h2 style="margin:4px 0 0;color:#1e293b;font-size:20px;font-weight:700;">Order ${orderNumber}</h2>
                          </td>
                          <td align="right">
                            <p style="margin:0;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Date</p>
                            <p style="margin:4px 0 0;color:#1e293b;font-size:14px;font-weight:600;">${formattedDate}</p>
                          </td>
                        </tr>
                      </table>

                      <!-- Customer Info -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Bill To</p>
                            <p style="margin:0;color:#1e293b;font-size:15px;font-weight:600;">${escapeHtml(customerName)}</p>
                            ${companyName ? `<p style="margin:2px 0 0;color:#475569;font-size:13px;">${escapeHtml(companyName)}</p>` : ""}
                            <p style="margin:2px 0 0;color:#475569;font-size:13px;">${escapeHtml(customerPhone)}</p>
                          </td>
                        </tr>
                      </table>

                      <!-- Order Details Table -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr style="background-color:#f1f5f9;">
                          <td style="padding:10px 12px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Product</td>
                          <td style="padding:10px 12px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Qty</td>
                          <td style="padding:10px 12px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Unit Price</td>
                          <td style="padding:10px 12px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;text-align:right;">Total</td>
                        </tr>
                        <tr>
                          <td style="padding:12px;border-bottom:1px solid #e2e8f0;">
                            <p style="margin:0;color:#1e293b;font-size:14px;font-weight:600;">${escapeHtml(product)}</p>
                            ${sku ? `<p style="margin:2px 0 0;color:#94a3b8;font-size:12px;">SKU: ${escapeHtml(sku)}</p>` : ""}
                          </td>
                          <td style="padding:12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;">${Number(quantity).toLocaleString()} ${unit || "Liters"}</td>
                          <td style="padding:12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;">${formattedPrice}</td>
                          <td style="padding:12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;font-weight:600;text-align:right;">${formattedAmount}</td>
                        </tr>
                      </table>

                      <!-- Total -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 0;"><span style="color:#475569;font-size:14px;">Delivery Type</span></td>
                          <td style="padding:8px 0;text-align:right;"><span style="color:#1e293b;font-size:14px;font-weight:600;text-transform:capitalize;">${deliveryType === "delivery" ? "Company Delivery" : "Self Pickup"}</span></td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;"><span style="color:#475569;font-size:14px;">Depot</span></td>
                          <td style="padding:8px 0;text-align:right;"><span style="color:#1e293b;font-size:14px;font-weight:600;">${escapeHtml(depotName)}${depotCode ? ` (${escapeHtml(depotCode)})` : ""}</span></td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;"><span style="color:#475569;font-size:14px;">State</span></td>
                          <td style="padding:8px 0;text-align:right;"><span style="color:#1e293b;font-size:14px;font-weight:600;">${escapeHtml(state)}</span></td>
                        </tr>
                        <tr style="border-top:2px solid #0d9488;">
                          <td style="padding:12px 0;"><span style="color:#1e293b;font-size:16px;font-weight:700;">Total Amount Due</span></td>
                          <td style="padding:12px 0;text-align:right;"><span style="color:#0d9488;font-size:20px;font-weight:700;">${formattedAmount}</span></td>
                        </tr>
                      </table>

                      <!-- Payment Details -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:0 0 8px;">
                            <p style="margin:0;color:#065f46;font-size:14px;font-weight:700;">Payment Details</p>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Bank: </span>
                            <span style="color:#065f46;font-size:13px;font-weight:700;">${bankName}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Account Number: </span>
                            <span style="color:#065f46;font-size:18px;font-weight:700;font-family:monospace;letter-spacing:2px;">${accountNumber}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Account Name: </span>
                            <span style="color:#065f46;font-size:13px;font-weight:700;">${escapeHtml(accountName || virtualAccountName(customerName))}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0 0;">
                            <p style="margin:0;color:#047857;font-size:12px;line-height:1.5;">Please make payment to the dedicated account above. Your payment will be confirmed automatically.</p>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;text-align:center;">
                        Thank you for your business. If you have any questions, please contact us.
                      </p>
                    </td>
                  </tr>
                  <!-- Footer -->
                  <tr>
                    <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
                      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                        &copy; ${new Date().getFullYear()} Soroman. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `,
  });
};

const sendTicketEmail = async (email, ticketData) => {
  const {
    ticketNumber,
    qrCodeDataUrl,
    customerName,
    companyName,
    customerPhone,
    customerEmail,
    productName,
    productSku,
    productCategory,
    quantity,
    unit,
    unitPrice,
    orderNumber,
    orderDate,
    depotName,
    depotCode,
    depotAddress,
    state,
    totalAmount,
    deliveryType,
    virtualAccountNumber,
    virtualAccountBank,
  } = ticketData;

  const formattedAmount = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(totalAmount);

  const formattedUnitPrice = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(unitPrice || 0);

  const formattedOrderDate = orderDate
    ? new Date(orderDate).toLocaleDateString("en-NG", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    })
    : "N/A";

  const formattedDelivery = deliveryType === "delivery" ? "Company Delivery" : "Self Pickup";

  await sendMail({
    from: process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>",
    to: email,
    subject: `Your Soroman Ticket Receipt - ${ticketNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                  <!-- Header -->
                  <tr>
                    <td style="background:linear-gradient(135deg,#0d9488,#0f766e);padding:32px 40px;text-align:center;">
                      <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:1px;">SOROMAN</h1>
                      <p style="margin:8px 0 0;color:#ccfbf1;font-size:14px;text-transform:uppercase;letter-spacing:2px;">Official Ticket Receipt</p>
                    </td>
                  </tr>
                  <!-- Body -->
                  <tr>
                    <td style="padding:40px;">
                      <div style="text-align:center;margin-bottom:32px;">
                        <p style="margin:0 0 4px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Ticket Number</p>
                        <h2 style="margin:0;color:#0d9488;font-size:24px;font-weight:800;font-family:monospace;letter-spacing:1px;">${ticketNumber}</h2>
                        <p style="margin:4px 0 0;color:#64748b;font-size:12px;">Order Ref: <strong>${orderNumber}</strong> (${formattedOrderDate})</p>
                      </div>

                      <!-- QR Code Section -->
                      <div style="text-align:center;margin-bottom:32px;background-color:#f8fafc;padding:24px;border-radius:12px;border:1px dashed #e2e8f0;">
                        <p style="margin:0 0 16px;color:#475569;font-size:14px;font-weight:600;">Present this QR Code to the administrator for verification & pickup:</p>
                        <img src="${qrCodeDataUrl}" alt="Ticket QR Code" style="width:200px;height:200px;display:inline-block;background-color:#ffffff;padding:8px;border:1px solid #e2e8f0;border-radius:8px;" />
                        <p style="margin:16px 0 0;color:#94a3b8;font-size:11px;">Keep this ticket secure. It will be scanned once to redeem your product.</p>
                      </div>

                      <!-- Ticket Summary Info -->
                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Customer Details</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Customer Name</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(customerName)}</td>
                        </tr>
                        ${companyName ? `
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Company</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(companyName)}</td>
                        </tr>` : ""}
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Phone</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(customerPhone || "N/A")}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Email</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(customerEmail || "N/A")}</td>
                        </tr>
                      </table>

                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Product Information</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Product Name</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(productName)}</td>
                        </tr>
                        ${productSku ? `
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">SKU</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;font-family:monospace;">${escapeHtml(productSku)}</td>
                        </tr>` : ""}
                        ${productCategory ? `
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Category</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(productCategory)}</td>
                        </tr>` : ""}
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Quantity Ordered</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700;color:#0d9488;">${Number(quantity).toLocaleString()} ${unit}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Unit Price</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${formattedUnitPrice}</td>
                        </tr>
                      </table>

                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Fulfillment & Payment Details</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Fulfillment Depot</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(depotName)} ${depotCode ? `(${escapeHtml(depotCode)})` : ""}</td>
                        </tr>
                        ${depotAddress ? `
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Depot Address</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(depotAddress)}</td>
                        </tr>` : ""}
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">State</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(state)}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Fulfillment Method</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;text-transform:capitalize;">${formattedDelivery}</td>
                        </tr>
                        ${virtualAccountNumber ? `
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Pay Into Bank</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(virtualAccountBank)}</td>
                        </tr>
                        <tr>
                          <td style="padding:6px 0;font-size:13px;color:#64748b;">Pay Into Account</td>
                          <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#1e293b;font-family:monospace;">${escapeHtml(virtualAccountNumber)}</td>
                        </tr>` : ""}
                        <tr style="border-top:1px solid #e2e8f0;">
                          <td style="padding:12px 0;"><span style="color:#1e293b;font-size:16px;font-weight:700;">Total Amount Paid</span></td>
                          <td style="padding:12px 0;text-align:right;"><span style="color:#0d9488;font-size:20px;font-weight:700;">${formattedAmount}</span></td>
                        </tr>
                      </table>

                      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;text-align:center;">
                        If you have any questions or require assistance, please contact our support team.
                      </p>
                    </td>
                  </tr>
                  <!-- Footer -->
                  <tr>
                    <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
                      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                        &copy; ${new Date().getFullYear()} Soroman. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `,
  });
};

const sendDangoteRequestReceivedEmail = async (email, requestData) => {
  const {
    requestNumber,
    customerName,
    product,
    quantity,
    quantityUnit,
    deliveryAddress,
    deliveryState,
  } = requestData;

  await sendMail({
    from: process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>",
    to: email,
    subject: `Dangote Delivery Order Request Received - ${requestNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                  <tr>
                    <td style="background:linear-gradient(135deg,#0d9488,#0f766e);padding:32px 40px;">
                      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Soroman</h1>
                      <p style="margin:8px 0 0;color:#ccfbf1;font-size:14px;">Dangote Delivery Order Request</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:40px;">
                      <h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Request Received</h2>
                      <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
                        Dear ${escapeHtml(customerName)},
                      </p>
                      <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
                        Your Dangote delivery order request has been received and is currently <strong style="color:#d97706;">under review</strong>. Our team will review your request and get back to you shortly.
                      </p>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Request Number</p>
                            <p style="margin:0;color:#1e293b;font-size:16px;font-weight:700;font-family:monospace;">${requestNumber}</p>
                          </td>
                        </tr>
                      </table>

                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Product</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(product)}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Quantity</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${Number(quantity).toLocaleString()} ${quantityUnit}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;">
                            <span style="color:#475569;font-size:13px;">Delivery Address</span>
                          </td>
                          <td style="padding:8px 0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(deliveryAddress)}${deliveryState ? `, ${escapeHtml(deliveryState)}` : ""}</span>
                          </td>
                        </tr>
                      </table>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #fbbf24;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td>
                            <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5;">
                              <strong>What happens next?</strong><br/>
                              Our team will review your request and set the pricing. Once approved, you will receive a confirmation email with the full order details, pricing, and payment instructions.
                            </p>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;text-align:center;">
                        Thank you for choosing Soroman. If you have any questions, please contact us.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
                      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                        &copy; ${new Date().getFullYear()} Soroman. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `,
  });
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

  const formattedTotal = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(totalAmount);

  const formattedPricePerUnit = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(pricePerUnit);

  const formattedDeliveryPrice = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(deliveryPrice || 0);

  await sendMail({
    from: process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>",
    to: email,
    subject: `Dangote Delivery Order Confirmed - ${requestNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                  <tr>
                    <td style="background:linear-gradient(135deg,#0d9488,#0f766e);padding:32px 40px;">
                      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Soroman</h1>
                      <p style="margin:8px 0 0;color:#ccfbf1;font-size:14px;">Dangote Delivery Order Confirmed</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:40px;">
                      <div style="text-align:center;margin-bottom:32px;">
                        <div style="display:inline-block;height:64px;width:64px;border-radius:50%;background-color:#d1fae5;border:2px solid #a7f3d0;line-height:64px;font-size:28px;color:#059669;">&#10003;</div>
                        <h2 style="margin:16px 0 8px;color:#1e293b;font-size:22px;font-weight:700;">Order Confirmed!</h2>
                        <p style="margin:0;color:#475569;font-size:14px;">Your Dangote delivery order request has been approved and confirmed.</p>
                      </div>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Order Reference</p>
                            <p style="margin:0;color:#1e293b;font-size:16px;font-weight:700;font-family:monospace;">${requestNumber}</p>
                          </td>
                        </tr>
                      </table>

                      <!-- Customer Info -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Customer</p>
                            <p style="margin:0;color:#1e293b;font-size:15px;font-weight:600;">${escapeHtml(customerName)}</p>
                            ${companyName ? `<p style="margin:2px 0 0;color:#475569;font-size:13px;">${escapeHtml(companyName)}</p>` : ""}
                            <p style="margin:2px 0 0;color:#475569;font-size:13px;">${escapeHtml(customerPhone || "")}</p>
                          </td>
                        </tr>
                      </table>

                      <!-- Order Details -->
                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Order Details</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Product</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(product)}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Quantity</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${Number(quantity).toLocaleString()} ${quantityUnit}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Delivery Address</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(deliveryAddress)}${deliveryState ? `, ${escapeHtml(deliveryState)}` : ""}</span>
                          </td>
                        </tr>
                        ${expectedArrivalDate ? `
                        <tr>
                          <td style="padding:8px 0;">
                            <span style="color:#475569;font-size:13px;">Expected Arrival</span>
                          </td>
                          <td style="padding:8px 0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${expectedArrivalDate}</span>
                          </td>
                        </tr>` : ""}
                      </table>

                      <!-- Pricing -->
                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Pricing & Payment</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Price Per ${quantityUnit === "Liters" ? "Litre" : "Unit"}</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${formattedPricePerUnit}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Delivery Price</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${formattedDeliveryPrice}</span>
                          </td>
                        </tr>
                        <tr style="border-top:2px solid #0d9488;">
                          <td style="padding:12px 0;">
                            <span style="color:#1e293b;font-size:16px;font-weight:700;">Total Amount</span>
                          </td>
                          <td style="padding:12px 0;text-align:right;">
                            <span style="color:#0d9488;font-size:20px;font-weight:700;">${formattedTotal}</span>
                          </td>
                        </tr>
                      </table>

                      <!-- Payment Details -->
                      ${accountNumber ? `
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:0 0 8px;">
                            <p style="margin:0;color:#065f46;font-size:14px;font-weight:700;">Payment Details</p>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Bank: </span>
                            <span style="color:#065f46;font-size:13px;font-weight:700;">${escapeHtml(bankName)}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Account Number: </span>
                            <span style="color:#065f46;font-size:18px;font-weight:700;font-family:monospace;letter-spacing:2px;">${escapeHtml(accountNumber)}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Account Name: </span>
                            <span style="color:#065f46;font-size:13px;font-weight:700;">${escapeHtml(accountName || virtualAccountName(customerName))}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0 0;">
                            <p style="margin:0;color:#047857;font-size:12px;line-height:1.5;">Please make payment of the total amount to the bank account details above to complete your order.</p>
                          </td>
                        </tr>
                      </table>
                      ` : `
                      <!-- Payment Instructions (fallback) -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin-bottom:24px;">
                        <tr>
                          <td>
                            <p style="margin:0 0 8px;color:#065f46;font-size:14px;font-weight:700;">Payment Instructions</p>
                            <p style="margin:0;color:#047857;font-size:13px;line-height:1.5;">
                              Please make payment for the confirmed amount. Once payment is verified, your order will be processed for delivery. Contact our finance team for payment details.
                            </p>
                          </td>
                        </tr>
                      </table>
                      `}

                      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;text-align:center;">
                        Thank you for your business. If you have any questions, please contact us.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
                      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                        &copy; ${new Date().getFullYear()} Soroman. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `,
  });
};

const sendLpgRequestReceivedEmail = async (email, requestData) => {
  const {
    requestNumber,
    customerName,
    cylinderSizeKg,
    cylinderQuantity,
    deliveryAddress,
    deliveryState,
  } = requestData;

  await sendMail({
    from: process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>",
    to: email,
    subject: `LPG Cooking Gas Order Request Received - ${requestNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                  <tr>
                    <td style="background:linear-gradient(135deg,#0d9488,#0f766e);padding:32px 40px;">
                      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Soroman</h1>
                      <p style="margin:8px 0 0;color:#ccfbf1;font-size:14px;">LPG Cooking Gas Order Request</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:40px;">
                      <h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Request Received</h2>
                      <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
                        Dear ${escapeHtml(customerName)},
                      </p>
                      <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
                        Your LPG cooking gas home delivery order request has been received and is currently <strong style="color:#d97706;">under review</strong>. Our team will review your request and get back to you shortly.
                      </p>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Request Number</p>
                            <p style="margin:0;color:#1e293b;font-size:16px;font-weight:700;font-family:monospace;">${requestNumber}</p>
                          </td>
                        </tr>
                      </table>

                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Cylinder Size</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${cylinderSizeKg} Kg</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Quantity</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${Number(cylinderQuantity).toLocaleString()} cylinder${Number(cylinderQuantity) > 1 ? 's' : ''}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;">
                            <span style="color:#475569;font-size:13px;">Delivery Address</span>
                          </td>
                          <td style="padding:8px 0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(deliveryAddress)}${deliveryState ? `, ${escapeHtml(deliveryState)}` : ""}</span>
                          </td>
                        </tr>
                      </table>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1px solid #fbbf24;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td>
                            <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5;">
                              <strong>What happens next?</strong><br/>
                              Our team will review your request and set the pricing. Once approved, you will receive a confirmation email with the full order details, pricing, and payment instructions.
                            </p>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;text-align:center;">
                        Thank you for choosing Soroman. If you have any questions, please contact us.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
                      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                        &copy; ${new Date().getFullYear()} Soroman. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `,
  });
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

  const formattedTotal = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(totalAmount);

  const formattedPricePerKg = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(pricePerKg);

  const formattedDeliveryPrice = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(deliveryPrice || 0);

  const totalWeightKg = Number(cylinderSizeKg) * Number(cylinderQuantity);

  await sendMail({
    from: process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>",
    to: email,
    subject: `LPG Cooking Gas Order Confirmed - ${requestNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7fa;padding:40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
                  <tr>
                    <td style="background:linear-gradient(135deg,#0d9488,#0f766e);padding:32px 40px;">
                      <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">Soroman</h1>
                      <p style="margin:8px 0 0;color:#ccfbf1;font-size:14px;">LPG Cooking Gas Order Confirmed</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:40px;">
                      <div style="text-align:center;margin-bottom:32px;">
                        <div style="display:inline-block;height:64px;width:64px;border-radius:50%;background-color:#d1fae5;border:2px solid #a7f3d0;line-height:64px;font-size:28px;color:#059669;">&#10003;</div>
                        <h2 style="margin:16px 0 8px;color:#1e293b;font-size:22px;font-weight:700;">Order Confirmed!</h2>
                        <p style="margin:0;color:#475569;font-size:14px;">Your LPG cooking gas order request has been approved and confirmed.</p>
                      </div>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Order Reference</p>
                            <p style="margin:0;color:#1e293b;font-size:16px;font-weight:700;font-family:monospace;">${requestNumber}</p>
                          </td>
                        </tr>
                      </table>

                      <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:8px;padding:16px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 12px;">
                            <p style="margin:0 0 4px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Customer</p>
                            <p style="margin:0;color:#1e293b;font-size:15px;font-weight:600;">${escapeHtml(customerName)}</p>
                          </td>
                        </tr>
                      </table>

                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Order Details</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        ${stationName ? `
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">LPG Station</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(stationName)}</span>
                          </td>
                        </tr>` : ""}
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Cylinder Size</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${cylinderSizeKg} Kg</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Quantity</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${Number(cylinderQuantity).toLocaleString()} cylinder${Number(cylinderQuantity) > 1 ? 's' : ''} (${totalWeightKg.toLocaleString()} Kg total)</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Delivery Address</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${escapeHtml(deliveryAddress)}${deliveryState ? `, ${escapeHtml(deliveryState)}` : ""}</span>
                          </td>
                        </tr>
                        ${expectedArrivalDate ? `
                        <tr>
                          <td style="padding:8px 0;">
                            <span style="color:#475569;font-size:13px;">Expected Arrival</span>
                          </td>
                          <td style="padding:8px 0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${expectedArrivalDate}</span>
                          </td>
                        </tr>` : ""}
                      </table>

                      <h3 style="margin:0 0 12px;color:#1e293b;font-size:15px;border-bottom:2px solid #f1f5f9;padding-bottom:6px;">Pricing & Payment</h3>
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Price Per Kg</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${formattedPricePerKg}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Total Weight</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${totalWeightKg.toLocaleString()} Kg</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                            <span style="color:#475569;font-size:13px;">Delivery Price</span>
                          </td>
                          <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                            <span style="color:#1e293b;font-size:13px;font-weight:600;">${formattedDeliveryPrice}</span>
                          </td>
                        </tr>
                        <tr style="border-top:2px solid #0d9488;">
                          <td style="padding:12px 0;">
                            <span style="color:#1e293b;font-size:16px;font-weight:700;">Total Amount</span>
                          </td>
                          <td style="padding:12px 0;text-align:right;">
                            <span style="color:#0d9488;font-size:20px;font-weight:700;">${formattedTotal}</span>
                          </td>
                        </tr>
                      </table>

                      ${accountNumber ? `
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin-bottom:24px;">
                        <tr>
                          <td style="padding:0 0 8px;">
                            <p style="margin:0;color:#065f46;font-size:14px;font-weight:700;">Payment Details</p>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Bank: </span>
                            <span style="color:#065f46;font-size:13px;font-weight:700;">${escapeHtml(bankName)}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Account Number: </span>
                            <span style="color:#065f46;font-size:18px;font-weight:700;font-family:monospace;letter-spacing:2px;">${escapeHtml(accountNumber)}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;">
                            <span style="color:#065f46;font-size:13px;">Account Name: </span>
                            <span style="color:#065f46;font-size:13px;font-weight:700;">${escapeHtml(accountName || virtualAccountName(customerName))}</span>
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0 0;">
                            <p style="margin:0;color:#047857;font-size:12px;line-height:1.5;">Please make payment to the dedicated account above. Your payment will be confirmed automatically.</p>
                          </td>
                        </tr>
                      </table>
                      ` : `
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:8px;padding:20px;margin-bottom:24px;">
                        <tr>
                          <td>
                            <p style="margin:0 0 8px;color:#065f46;font-size:14px;font-weight:700;">Payment Instructions</p>
                            <p style="margin:0;color:#047857;font-size:13px;line-height:1.5;">
                              Please make payment for the confirmed amount. Once payment is verified, your order will be processed for delivery. Contact our finance team for payment details.
                            </p>
                          </td>
                        </tr>
                      </table>
                      `}

                      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.5;text-align:center;">
                        Thank you for your business. If you have any questions, please contact us.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0;">
                      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                        &copy; ${new Date().getFullYear()} Soroman. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `,
  });
};

module.exports = {
  sendOrderInvoiceEmail,
  sendTicketEmail,
  sendDangoteRequestReceivedEmail,
  sendDangoteOrderConfirmedEmail,
  sendLpgRequestReceivedEmail,
  sendLpgOrderConfirmedEmail,
};
