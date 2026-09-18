require("dotenv").config();
const express = require("express");
const app = express();
app.set("trust proxy", 1);
const path = require("path");
const { logger } = require("./middleware/logger");
const errorHandler = require("./middleware/errorHandler");
const cors = require("cors");
const corsOptions = require("./config/corsOptions");
const { mobileCorsBypass } = require("./config/corsOptions");
const helmet = require("helmet");

// Middleware
app.use(helmet());
app.use(logger);

// Webhooks (Meta, Paystack) are server-to-server POSTs with NO Origin header
// and a raw body. They must be mounted:
//   - BEFORE cors(): the CORS policy rejects no-Origin requests with 403, which
//     would kill every webhook at the door (before the HMAC check ever runs).
//   - BEFORE express.json(): so their own raw-body parsers run and the HMAC
//     verify callbacks actually fire over the exact bytes the sender signed.
app.use("/api/webhooks", require("./routes/webhook.route"));
app.use("/api/whatsapp/webhook", require("./routes/whatsappWebhook.route"));
// Termii delivery reports. Mounted here with the other webhooks, above the
// auth middleware — a provider callback carries no session.
app.use("/api/webhooks/termii", require("./routes/termiiWebhook.route"));

app.use(mobileCorsBypass);
// Skip cors() for requests already handled by the mobile bypass — otherwise
// the cors library would still reject them (it can't see mobile headers).
const corsMiddleware = cors(corsOptions);
app.use((req, res, next) => {
  if (req._mobileCorsBypassed) return next();
  corsMiddleware(req, res, next);
});
// The Reports Hub's "Email report" used to base64 its whole workbook into the
// request body, and express.json()'s 100kb default rejected that with a 413
// before any route ran — invisible from the client, which only saw the send
// fail. The client no longer sends it, but a tab opened before the deploy
// still will, so the larger limit stays: the body is accepted and the
// attachment ignored rather than the send breaking mid-rollout. Parsed here,
// ahead of the global parser, so it applies to this endpoint and nothing else
// — once a body is parsed, express.json() below sees req._body and passes it
// through untouched.
app.use("/api/daily-reports/email", express.json({ limit: "25mb" }));
app.use(express.json());
// `res.cookie` is built in, but `req.cookies` is not and never was — parsing
// the Cookie header has always been cookie-parser's job, in Express 4 as well.
// Required here because the refresh token travels in an httpOnly cookie.
app.use(require("cookie-parser")());

// Express 5 leaves req.body undefined when no body was parsed (v4 defaulted
// to {}). Controllers destructure req.body directly, so restore the v4 shape.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Routes
app.use("/api/auth", require("./routes/administration/auth.route"));
app.use("/api/admin", require("./routes/administration/staff.route"));
app.use("/api/dashboard", require("./routes/administration/dashboard.route"));
app.use("/api/trucks", require("./routes/administration/truck.route"));
app.use("/api/drivers", require("./routes/administration/driver.route"));
app.use("/api/depots", require("./routes/administration/depot.route"));
app.use("/api/lpg-stations", require("./routes/administration/lpgStation.route"));
app.use("/api/filing-stations", require("./routes/administration/filingStation.route"));
app.use("/api/products", require("./routes/administration/product.route"));
app.use("/api/pfis", require("./routes/administration/pfi.route"));
app.use("/api/expenses", require("./routes/administration/expense.route"));
app.use("/api/customers", require("./routes/administration/customer.route"));
app.use("/api/contacts", require("./routes/administration/contact.route"));
// Customers and contacts as one book. Both routes above stay — they own
// creating, editing and converting a record; this one owns finding it.
app.use("/api/people", require("./routes/administration/people.route"));
app.use("/api/delivery-customers", require("./routes/administration/deliveryCustomer.route"));
app.use("/api/delivery-inventory", require("./routes/administration/deliveryInventory.route"));
app.use("/api/delivery-sales", require("./routes/administration/deliverySale.route"));
app.use("/api/orders", require("./routes/administration/order.route"));
app.use("/api/tickets", require("./routes/administration/ticket.route"));
app.use("/api/deposits", require("./routes/administration/deposit.route"));
app.use("/api/expected-payments", require("./routes/administration/expectedPayment.route"));
app.use("/api/bank-accounts", require("./routes/administration/bankAccount.route"));
app.use("/api/vendors", require("./routes/administration/vendor.route"));
app.use("/api/finance-report", require("./routes/administration/financeReport.route"));
// Sales and money per batch per day — the CFO's own sheet. See
// services/cfoReport.service.js for how every column is arrived at.
app.use("/api/cfo-report", require("./routes/administration/cfoReport.route"));
app.use("/api/bank-statements", require("./routes/administration/bankStatement.route"));
app.use("/api/settlements", require("./routes/administration/settlement.route"));
app.use("/api/order-expiry", require("./routes/administration/orderExpiry.route"));

// ERP modules
app.use("/api/fleet", require("./routes/administration/fleet.route"));
app.use("/api/daily-reports", require("./routes/administration/dailyReport.route"));
app.use("/api/incidents", require("./routes/administration/incident.route"));
app.use("/api/offline-sales", require("./routes/administration/offlineSale.route"));
app.use("/api/reports", require("./routes/administration/reporting.route"));
app.use("/api/commissions", require("./routes/administration/commission.route"));
app.use("/api/customer-licenses", require("./routes/administration/customerLicense.route"));
app.use("/api/uploads", require("./routes/administration/upload.route"));
// Staff notifications: every signed-in staff member's own inbox, preferences
// and push devices, plus the admin-only broadcast and delivery-log endpoints.
app.use("/api/notifications", require("./routes/administration/notification.route"));
app.use("/api/message-templates", require("./routes/administration/messageTemplate.route"));
// The price advisory the messaging composer's {{prices}} shortcode renders.
app.use("/api/price-list", require("./routes/administration/priceList.route"));

// Dangote orders
app.use("/api", require("./routes/administration/dangoteOrder.route"));

// LPG cooking gas orders
app.use("/api", require("./routes/administration/lpgOrder.route"));

// Event consumers: audit writes every business event; the notification engine
// reacts to the ones customers and staff should hear about. Registered once,
// here, so requiring app.js in tests wires the same pipeline as production.
require("./services/audit.service").registerAuditListener();
require("./notifications/listeners").registerNotificationListeners();

// Customer-facing portal. Note it sits one character from the staff-only
// /api/customers above — a readability hazard, not a routing bug: Express
// matches mounts at segment boundaries, order-independently.
app.use("/api/customer/auth", require("./routes/portal/auth.route"));
// Additional sign-in methods (password, PIN, Google, Apple, passkeys) beyond
// the default phone+OTP flow above. Same path prefix, same cookie scope.
app.use("/api/customer/auth", require("./routes/portal/identity.route"));
app.use("/api/customer/orders", require("./routes/portal/order.route"));
app.use("/api/customer/profile", require("./routes/portal/profile.route"));
app.use("/api/customer/dashboard", require("./routes/portal/dashboard.route"));
// Public: live depot prices for the marketing site and the portal's order
// form — no account needed to see what's on sale, exactly as on WhatsApp.
app.use("/api/catalog", require("./routes/portal/catalog.route"));
// Public: open LPG (cooking gas) stations with price + cylinder stock.
app.use("/api/lpg-catalog", require("./routes/portal/lpgCatalog.route"));
// Customer-facing LPG cooking-gas order requests (create/list/view own).
app.use("/api/customer/lpg-orders", require("./routes/portal/lpgOrder.route"));
// Public: active Dangote bulk products for the quote wizard's picker.
app.use("/api/dangote-catalog", require("./routes/portal/dangoteCatalog.route"));
// Customer-facing Dangote bulk quote requests (create/list/view own).
app.use("/api/customer/dangote-orders", require("./routes/portal/dangoteOrder.route"));
// Customer-facing license register (list/add own, upload signature).
app.use("/api/customer/licenses", require("./routes/portal/license.route"));
// Customer-facing Cloudinary cleanup — delete a file the customer uploaded
// (e.g. replacing a licence document before saving it).
app.use("/api/customer/uploads", require("./routes/portal/upload.route"));
// Customer-facing wallet ledger — paginated credit/debit history behind the
// dashboard balance.
app.use("/api/customer/wallet", require("./routes/portal/wallet.route"));
// Customer-facing commission history — earned/pending/paid commissions.
app.use("/api/customer/commissions", require("./routes/portal/commission.route"));
// Customer-facing notifications — the mobile app's inbox and push device
// registration, the web portal's bell menu, and the live SSE stream behind
// both. Same handlers as the staff mount above, scoped to req.customer.
app.use("/api/customer/notifications", require("./routes/portal/notification.route"));
// Public: sanitised order tracking by reference — movement only, no price or
// buyer identity. The order number is the shared secret.
app.use("/api/tracking", require("./routes/portal/tracking.route"));

// Public: device-aware store redirect behind the "Download mobile app"
// button in WhatsApp — the one URL the bot sends for every device.
app.use("/app", require("./routes/appRedirect.route"));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Dashboard server is running" });
});

// 404 Handler
// Express 5 (path-to-regexp v8) dropped the bare "*" wildcard. "/{*splat}" is
// the braced form, which — unlike "/*splat" — also matches the root path "/".
app.all("/{*splat}", (req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Error handling middleware
app.use(errorHandler);

module.exports = app;
