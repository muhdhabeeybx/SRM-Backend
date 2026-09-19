const axios = require("axios");
const { virtualAccountName } = require("../utils/helpers");
const { toSmsRecipient } = require("../utils/phone");
// How a Soroman text is written — plain sentences, nothing in brackets, and
// N rather than ₦ so the body stays in GSM-7. Shared with the catalog
// templates so the two senders cannot drift into two voices again.
const { money, quantity: qty, rateClause, payTo, greet } = require("../notifications/templates/sms");

// Termii v3 API. Config is read at call time inside sendSMSTermii — not frozen
// at module load — so a deploy or a test can override the key, sender, or
// enabled flag per-send, and a missing key is caught on each attempt.

// Was a second hand-rolled Nigeria-only normaliser that agreed with
// utils/helpers by coincidence. Termii wants E.164 digits without the `+`,
// which is a rendering of one parse rather than a separate parser.
const formatPhoneForTermii = toSmsRecipient;

const CHANNELS = {
  GENERIC: "generic",
  DND: "dnd",
};

/**
 * What KIND of message this is — the one input the route decision needs.
 *
 * Termii's two routes are not a cheap one and an expensive one to be tried in
 * turn; they carry different traffic under different rules:
 *
 *   generic        promotional. Skips numbers on Nigeria's Do-Not-Disturb
 *                  register entirely, and on MTN is blocked 8PM–8AM WAT.
 *   dnd            transactional. The only route that reaches a DND-registered
 *                  handset — and reserved, by Termii and the NCC, for messages
 *                  the customer's own action asked for.
 *
 * Roughly a third of Nigerian mobile numbers are on the DND register, so a
 * transactional message sent `generic` is one a third of customers never see.
 * That is what this classification exists to stop.
 */
const MESSAGE_CLASS = {
  /** The customer's own action produced it: OTPs, orders, payments, tickets,
   *  expiries, security notices, and operational news they cannot opt out of. */
  TRANSACTIONAL: "transactional",
  /** We chose to send it: promotions, campaigns, anything marketing. */
  PROMOTIONAL: "promotional",
};

/**
 * One sender ID, on every route and every message.
 *
 * Termii approves a sender ID per route, and the account previously leaned on
 * Termii's shared "N-Alert" for the DND leg because the branded ID was not
 * whitelisted for it. That is a deliberate trade nobody should make by
 * accident: a text from "N-Alert" is unbranded and unrecognisable, and a
 * customer who cannot tell who sent their payment instructions is a customer
 * who ignores it.
 *
 * So everything now goes out as the brand. If Termii has not whitelisted it
 * for DND, the DND leg is accepted ("Successfully Sent") and then rejected by
 * the carrier — visible in the delivery log as a `rejected` DLR, and the
 * generic leg still runs behind it. Watch the log after deploying this; a run
 * of `sender_id` or `rejected` reasons on the dnd channel means the
 * whitelisting has not landed yet.
 */
const sender = () => process.env.TERMII_SENDER_ID || "Soroman";

/**
 * Promotional traffic on the DND route: off, and it should stay off.
 *
 * A number on the DND register has told the regulator it does not want
 * marketing. Routing promos through `dnd` would technically reach it, and is
 * exactly the abuse that gets a sender ID's DND approval revoked — taking the
 * OTPs down with it. The switch exists so the decision is one env var rather
 * than a deploy, not because it is a good idea.
 */
const promoOnDnd = () => process.env.TERMII_PROMO_ON_DND === "true";

const sendSMSTermii = async (
  phone,
  sms,
  channel = CHANNELS.GENERIC,
  from = process.env.TERMII_SENDER_ID || "Soroman"
) => {
  if (process.env.SMS_ENABLED === "false") {
    // Reported as a distinct outcome, NOT as success. Returning { success: true }
    // here made a disabled sender indistinguishable from a delivered message:
    // the OTP path saw `sent`, told the customer a code was on its way, and
    // nothing ever arrived. Callers that legitimately want a no-op in dev can
    // branch on `disabled`; everything else now sees an honest failure.
    console.warn("[SMS] SMS_ENABLED=false — no message sent");
    return { success: false, disabled: true, message: "SMS sending is disabled (SMS_ENABLED=false)" };
  }

  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) {
    console.error(
      "[SMS] TERMII_API_KEY is not configured — set it on the deployment, not just in local .env"
    );
    return { success: false, message: "SMS API key not configured" };
  }

  const response = await axios.post(
    // Termii's send endpoint is /api/sms/send. The bare /sms/send path 404s,
    // which is what surfaced as "Termii ... channel error ... status code 404".
    //
    // Base URL defaults to v4 — Termii assigns each account its own regional
    // base URL, and this account is on v4. An account whose deployment forgot
    // to set TERMII_BASE_URL was silently posting to the stale v3 host and
    // getting 401 Unauthorized (auth, not the key), so real OTPs never sent.
    // Set TERMII_BASE_URL explicitly per environment; this default is the
    // safety net, not the source of truth.
    `${process.env.TERMII_BASE_URL || "https://v4.api.termii.com"}/api/sms/send`,
    {
      to: formatPhoneForTermii(phone),
      from,
      sms,
      type: "plain",
      channel,
      api_key: apiKey,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  if (response.data.message === "Successfully Sent" || response.data.code === "ok") {
    // Termii's own id for this message, carried back so the delivery row can
    // hold it. Without it a delivery receipt has nothing to match against, and
    // "delivered" stays permanently unknowable — which is exactly how the log
    // ended up with 12,084 rows and not one of them marked delivered.
    return { success: true, messageId: response.data.message_id || "" };
  }

  return { success: false, message: response.data.message || "SMS sending failed" };
};

/**
 * The ordered attempts for a message of this class: which route, under which
 * sender ID. Transactional walks dnd → generic so a DND-registered customer is
 * reached first and everyone else still gets the message if DND declines.
 * Promotional gets the one route it is allowed on.
 */
const routePlan = (messageClass) => {
  const from = sender();
  const generic = { channel: CHANNELS.GENERIC, from };
  if (messageClass === MESSAGE_CLASS.PROMOTIONAL && !promoOnDnd()) return [generic];
  return [{ channel: CHANNELS.DND, from }, generic];
};

/**
 * Send one message down its route plan, stopping at the first acceptance.
 *
 * The single walk every caller in the codebase now shares — the notification
 * engine's SMS channel, the bespoke order/ticket senders, and the OTP path —
 * so the route/sender pairing can never again be right in one place and wrong
 * in the other three.
 *
 * Never throws. Termii soft-fails as `{ success: false }` without raising, so
 * a caller relying on try/catch alone would read a refusal as a delivery.
 *
 * @param {object} [options]
 * @param {string} [options.messageClass] one of MESSAGE_CLASS; transactional by default
 * @returns {Promise<{success: boolean, channel?: string, sender?: string,
 *                    messageId?: string, disabled?: boolean, message?: string}>}
 */
const route = async (phone, sms, { messageClass = MESSAGE_CLASS.TRANSACTIONAL } = {}) => {
  const attempts = [];

  for (const step of routePlan(messageClass)) {
    try {
      const result = await sendSMSTermii(phone, sms, step.channel, step.from);
      if (result.success) {
        return {
          success: true,
          channel: step.channel,
          sender: step.from,
          messageId: result.messageId || "",
        };
      }
      // The kill switch is not a route failure — trying the second leg would
      // only produce the same refusal twice, and "dnd: … | generic: …" in the
      // delivery log reads as a DND problem when it is an ops one.
      if (result.disabled) return result;
      attempts.push(`${step.channel}: ${result.message || "failed"}`);
    } catch (error) {
      // Termii reports the real reason in the response body, not the status —
      // a 402 is "Insufficient balance" only if you unwrap response.data.
      const detail = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message || "Termii error";
      attempts.push(`${step.channel}: ${detail}`);
    }
  }

  return { success: false, message: attempts.join(" | ") || "All Termii channels failed" };
};

/**
 * The Termii wallet, read straight from the provider.
 *
 * The `balance` echoed inside a send response is unreliable — some routes
 * return 0 — so this is the authoritative figure, and it is a read that bills
 * nothing. 346 sends on the live book failed with "Insufficient balance"
 * because nobody could see the wallet from the dashboard; this is what puts it
 * in front of the person about to press Send.
 *
 * Never throws. A balance that cannot be read must not stop a broadcast — it
 * is a courtesy reading beside the compose box, not a precondition.
 *
 * @returns {Promise<{ok: boolean, balance: number|null, currency: string, error: string|null}>}
 */
const getTermiiBalance = async () => {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) {
    return { ok: false, balance: null, currency: "", error: "SMS API key not configured" };
  }

  try {
    const base = process.env.TERMII_BASE_URL || "https://v4.api.termii.com";
    const response = await axios.get(`${base}/api/get-balance`, {
      params: { api_key: apiKey },
      timeout: 10_000,
    });
    const data = response.data || {};
    return {
      ok: true,
      balance: data.balance === undefined || data.balance === null ? null : Number(data.balance),
      currency: data.currency || "",
      error: null,
    };
  } catch (error) {
    // A 401 here means the key is wrong for THIS base URL — Termii assigns
    // each account its own regional host, and the same key 401s on the others.
    const detail =
      error.response?.status === 401
        ? "Termii rejected the key — check TERMII_BASE_URL matches the account"
        : error.response?.data?.message || error.message || "Could not reach Termii";
    return { ok: false, balance: null, currency: "", error: detail };
  }
};

/**
 * OTP sender.
 *
 * A named alias for the transactional route rather than a policy of its own —
 * kept because "the code did not arrive" is the failure everyone reaches for
 * this function to explain, and a stack trace through `route` alone says less.
 * It once pinned its own sender ID; there is only one sender ID now.
 */
const sendSMSWithFallback = async (phone, sms) =>
  route(phone, sms, { messageClass: MESSAGE_CLASS.TRANSACTIONAL });

/**
 * The route walk every bespoke sender below shares.
 *
 * All of them are transactional — an order the customer placed, a ticket they
 * are collecting, an expiry on their own order — so all of them go dnd first.
 * They previously went generic first, which meant a DND-registered customer's
 * payment instructions were billed and dropped.
 */
const deliver = async (phone, sms, label) => {
  const result = await route(phone, sms, { messageClass: MESSAGE_CLASS.TRANSACTIONAL });
  if (result.success) return { success: true, message: `${label} sent successfully` };

  console.warn(`Termii failed during ${label}:`, result.message);
  return { success: false, message: result.message || "All Termii channels failed" };
};

/**
 * A PFI has been raised and is waiting for somebody to release it.
 *
 * Goes to PFI_REVIEW_PHONE, not to a role: the review desk is one person's
 * job here, and deriving it from a role would page every super_admin for
 * every batch. Unset means the feature is simply not notifying — that is a
 * configuration state, not an error, and it must never stop a PFI being
 * raised. See raisePfi in pfi.service.js, which ignores what this returns.
 */
const sendPfiReviewSMS = async (phone, { pfiNumber, pfiType, locationName, productName, raisedBy }) => {
  const sms =
    `New ${pfiType} PFI ${pfiNumber} has been raised${raisedBy ? ` by ${raisedBy}` : ""}` +
    `${productName ? ` for ${productName}` : ""}${locationName ? ` at ${locationName}` : ""}. ` +
    `It is not trading yet. Assign its bank account and officers on the dashboard to activate it.`;

  return deliver(phone, sms, "PFI review notice");
};

const sendOrderSummarySMS = async (phone, orderData) => {
  const { customerName, product, quantity, unit, price, totalAmount, accountNumber, bankName, accountName } = orderData;

  const sms =
    `${greet(customerName)}we have received your order of ${qty(quantity, unit)} of ${product}` +
    `${rateClause(price, unit)}. ` +
    `Please pay ${money(totalAmount)} to ${payTo({
      accountName: accountName || virtualAccountName(customerName),
      accountNumber,
      bankName,
    })}. Thank you for your patronage.`;

  return deliver(phone, sms, "Order SMS");
};

const sendTicketSummarySMS = async (phone, ticketData) => {
  const { ticketNumber, customerName, productName, quantity, unit, depotName, deliveryType, orderNumber } = ticketData;

  // Delivery orders have nothing to "present at the depot" — the same order-level
  // ticket exists so the load can pass the gate, but the buyer isn't collecting
  // it. Telling a delivery customer to redeem a pickup QR is wrong, so the copy
  // branches on deliveryType.
  const sms =
    deliveryType === "delivery"
      ? `${greet(customerName)}your order of ${qty(quantity, unit)} of ${productName} from ${depotName || "our depot"} is confirmed and being prepared for delivery. We will keep you posted. Thank you for your patronage.`
      : `${greet(customerName)}your loading ticket for ${qty(quantity, unit)} of ${productName} at ${depotName || "our depot"} is ready. Thank you for your patronage.`;

  return deliver(phone, sms, "Ticket SMS");
};

const sendDangoteDeliveryOrderSMS = async (phone, orderData) => {
  const { requestNumber, customerName, product, quantity, quantityUnit, totalAmount, accountNumber, bankName, accountName } = orderData;

  const sms =
    `${greet(customerName)}your Dangote delivery order ${requestNumber} for ` +
    `${qty(quantity, quantityUnit)} of ${product} has been approved. ` +
    `Please pay ${money(totalAmount)} to ${payTo({
      accountName: accountName || virtualAccountName(customerName),
      accountNumber,
      bankName,
    })}. Thank you for your patronage.`;

  return deliver(phone, sms, "Dangote delivery order SMS");
};

const sendLpgOrderSMS = async (phone, orderData) => {
  const { requestNumber, customerName, cylinderSizeKg, cylinderQuantity, totalAmount, accountNumber, bankName, accountName } = orderData;

  const cylinders = `${cylinderQuantity} x ${cylinderSizeKg}Kg cylinder${Number(cylinderQuantity) === 1 ? "" : "s"}`;
  const sms =
    `${greet(customerName)}your LPG order ${requestNumber} for ${cylinders} has been approved. ` +
    `Please pay ${money(totalAmount)} to ${payTo({
      accountName: accountName || virtualAccountName(customerName),
      accountNumber,
      bankName,
    })}. Thank you for your patronage.`;

  return deliver(phone, sms, "LPG order SMS");
};

const sendOrderExpiredSMS = async (phone, { orderNumber, customerName }) => {
  const sms =
    `${greet(customerName)}your order ${orderNumber} has expired because payment was not received in time. ` +
    `The price is no longer held. Please place a new order at today's price whenever you are ready.`;

  return deliver(phone, sms, "Order expiry SMS");
};

const sendDangoteOrderExpiredSMS = async (phone, { requestNumber, customerName }) => {
  const sms =
    `${greet(customerName)}your Dangote delivery order ${requestNumber} has expired because payment was not ` +
    `received in time. The price is no longer held. Please send a new request at today's price whenever you are ready.`;

  return deliver(phone, sms, "Dangote expiry SMS");
};

const sendLpgOrderExpiredSMS = async (phone, { requestNumber, customerName }) => {
  const sms =
    `${greet(customerName)}your LPG order ${requestNumber} has expired because payment was not received in time. ` +
    `The price is no longer held. Please place a new order at today's price whenever you are ready.`;

  return deliver(phone, sms, "LPG expiry SMS");
};

module.exports = { sendSMSTermii, route, getTermiiBalance, sendSMSWithFallback, sendPfiReviewSMS, sendOrderSummarySMS, sendTicketSummarySMS, sendDangoteDeliveryOrderSMS, sendLpgOrderSMS, sendOrderExpiredSMS, sendDangoteOrderExpiredSMS, sendLpgOrderExpiredSMS, CHANNELS, MESSAGE_CLASS };
