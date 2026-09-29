const { route, MESSAGE_CLASS } = require("../../services/sms.service");

/**
 * SMS, over Termii — through services/sms.service.js rather than around it, so
 * the API shape, the phone normalisation, the SMS_ENABLED kill switch and the
 * route/sender policy all stay in one place.
 *
 * Which Termii route a notification takes is decided from its catalog entry,
 * not fixed here: see `messageClassFor` below.
 */

/**
 * Which Termii route this notification is entitled to, read off its catalog
 * category.
 *
 * Everything the platform sends is transactional except the marketing
 * category — an order confirmation, a payment receipt, a loading ticket, a
 * security notice and a depot-closure announcement are all things the customer
 * needs and did not choose to receive as advertising. Those go down the `dnd`
 * route first, which is the only one that reaches the roughly one-in-three
 * Nigerian numbers on the Do-Not-Disturb register.
 *
 * `marketing` is the exception and stays on `generic`. A DND registration IS
 * the opt-out from promotional SMS; routing promos around it is what gets a
 * sender ID's DND approval pulled, and the OTPs share that approval. The split
 * is why the admin broadcast carries a category at all — an outage notice sent
 * as `system` reaches a DND-registered customer, an advert sent as `marketing`
 * correctly does not.
 *
 * Anything with no category — a caller that sent a bare type, or an entry
 * still being written — is treated as transactional. Getting a promo onto the
 * cheaper, more restricted route by mistake is a wasted send; getting a
 * payment instruction onto it is a customer who never learns where to pay.
 */
const PROMOTIONAL_CATEGORIES = new Set(["marketing"]);

const messageClassFor = (entry) =>
  PROMOTIONAL_CATEGORIES.has(entry?.category)
    ? MESSAGE_CLASS.PROMOTIONAL
    : MESSAGE_CLASS.TRANSACTIONAL;

/**
 * A single GSM-7 SMS is 160 characters, and 153 per part once concatenated.
 * Termii bills per part, so an unbounded template is an unbounded invoice —
 * this caps the damage at four parts and makes truncation visible rather than
 * letting a runaway template quietly cost money.
 */
const MAX_LENGTH = Number(process.env.NOTIFY_SMS_MAX_LENGTH || 612);

const truncate = (text) => {
  const s = String(text || "").trim();
  return s.length <= MAX_LENGTH ? s : `${s.slice(0, MAX_LENGTH - 1)}…`;
};

/**
 * @returns {Promise<Array<{destination, status, providerMessageId, error}>>}
 */
const send = async ({ contact, rendered, entry, principal, type }) => {
  const phone = String(contact?.phone || "").trim();

  if (!phone) {
    return [{ destination: "", status: "skipped", error: "No phone number on file" }];
  }

  const text = truncate(rendered.sms);
  if (!text) {
    return [{ destination: phone, status: "skipped", error: "No SMS template for this type" }];
  }

  const result = await route(phone, text, {
    messageClass: messageClassFor(entry),
    // For the message ledger: what this was and who it was for. The campaign,
    // when there is one, is joined in later from this send's delivery row.
    tag: {
      type,
      audience: principal?.type === "staff" ? "staff" : principal?.type === "customer" ? "customer" : undefined,
      staffId: principal?.type === "staff" ? principal.id : null,
      customerId: principal?.type === "customer" ? principal.id : null,
      recipientName: contact?.name || "",
    },
  });

  if (result.success) {
    return [
      { destination: phone, status: "sent", providerMessageId: result.messageId || "", error: null },
    ];
  }

  return [
    {
      destination: phone,
      status: "failed",
      providerMessageId: "",
      error: result.message || "All Termii channels failed",
    },
  ];
};

module.exports = { send, messageClassFor, MAX_LENGTH };
