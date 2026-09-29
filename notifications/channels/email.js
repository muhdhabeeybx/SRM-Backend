const { Resend } = require("resend");

/**
 * Transactional email, over Resend — the provider services/email.service.js
 * already uses, so there is one sender reputation and one dashboard.
 *
 * The client is built lazily and re-built when the key changes, matching the
 * call-time-config convention in services/sms.service.js: a test or a redeploy
 * can swap the key without a restart, and a missing key is caught per send
 * rather than throwing at require() time and taking the whole app down.
 */

let client = null;
let clientKey = null;

const apiKey = () => (process.env.RESEND_API_KEY || "").trim();

const getClient = () => {
  const key = apiKey();
  if (!client || clientKey !== key) {
    client = new Resend(key);
    clientKey = key;
  }
  return client;
};

const isEnabled = () => process.env.EMAIL_ENABLED !== "false" && Boolean(apiKey());

const from = () =>
  process.env.EMAIL_FROM || "Soroman Dashboard <onboarding@resend.dev>";

/**
 * Resend allows 10 requests a second per account, and the engine dispatches
 * recipients in concurrent batches — so a batch of ten landed on the limit and
 * anything sharing the second went over it. That produced 236 "Too many
 * requests" failures in five days: real, dropped emails, on a limit that is
 * simply a matter of pacing.
 *
 * A gap between sends is enough. Every send waits its turn on one shared
 * promise chain, so concurrency upstream no longer decides the request rate —
 * the sends still overlap on the network, they just start far enough apart.
 * The cap is per account, which is why this lives in the channel rather than
 * the engine: every caller shares one provider budget.
 */
const RATE_LIMIT_PER_SECOND = Number(process.env.EMAIL_RATE_LIMIT_PER_SECOND || 8);
const MIN_GAP_MS = RATE_LIMIT_PER_SECOND > 0 ? Math.ceil(1000 / RATE_LIMIT_PER_SECOND) : 0;

let sendGate = Promise.resolve();
let lastSendAt = 0;

/** Resolves when this caller is clear to make its request. */
const takeSlot = () => {
  if (MIN_GAP_MS <= 0) return Promise.resolve();
  const turn = sendGate.then(async () => {
    const wait = lastSendAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSendAt = Date.now();
  });
  // The queue must keep moving even if a turn rejects, or one failure would
  // wedge every send behind it for the life of the process.
  sendGate = turn.catch(() => {});
  return turn;
};

/**
 * A very loose check — real validation is the provider's job, and rejecting an
 * address Resend would have accepted is worse than letting it try. This only
 * catches the empty and obviously-not-an-address cases so they are recorded as
 * `skipped` (nothing to send to) rather than `failed` (the provider refused).
 */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

/**
 * RFC 2606 reserves these for documentation and testing, so an address on one
 * can never reach a person — but the provider still accepts it, still bills it
 * and still counts it against the daily quota. The test suite's fixture
 * accounts live on @soroman.test, and one run of it spent an entire day's
 * sending allowance, after which nothing real could go out.
 */
const RESERVED_RECIPIENT =
  /@([^@]*\.)?(test|example|invalid|localhost)$|@([^@]*\.)?example\.(com|net|org)$/i;

/**
 * @returns {Promise<Array<{destination, status, providerMessageId, error}>>}
 */
const sendOnce = async ({ contact, rendered }) => {
  const to = String(contact?.email || "").trim();

  if (!looksLikeEmail(to)) {
    return [{ destination: to, status: "skipped", error: "No email address on file" }];
  }
  if (!isEnabled()) {
    return [
      {
        destination: to,
        status: "skipped",
        error: apiKey() ? "Email disabled (EMAIL_ENABLED=false)" : "RESEND_API_KEY is not configured",
      },
    ];
  }
  if (RESERVED_RECIPIENT.test(to)) {
    return [{ destination: to, status: "skipped", error: "Reserved domain — not a deliverable address" }];
  }

  const email = rendered.email;
  if (!email?.html) {
    return [{ destination: to, status: "skipped", error: "No email template for this type" }];
  }

  try {
    await takeSlot();
    const { data, error } = await getClient().emails.send({
      from: from(),
      to,
      subject: email.subject || rendered.title,
      html: email.html,
      ...(email.text ? { text: email.text } : {}),
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
      // Attachments are opt-in per template and only the scheduled reports use
      // them. Resend takes `{ filename, content }` with content as a Buffer or
      // base64 string, which is what report.service hands over.
      ...(Array.isArray(email.attachments) && email.attachments.length
        ? { attachments: email.attachments }
        : {}),
    });

    // Resend reports failures in the response body, not by throwing — a send
    // that returns `{ error }` and is treated as success is a message nobody
    // ever receives and nobody ever notices.
    if (error) {
      return [
        { destination: to, status: "failed", providerMessageId: "", error: error.message || String(error) },
      ];
    }

    return [{ destination: to, status: "sent", providerMessageId: data?.id || "", error: null }];
  } catch (err) {
    return [{ destination: to, status: "failed", providerMessageId: "", error: err.message }];
  }
};

/**
 * The send, and its line in the message ledger (services/messageLog.service).
 * Skipped sends went nowhere, so only sent and failed ones are written.
 */
const send = async (args) => {
  const results = await sendOnce(args);
  const { contact, rendered, principal, type } = args;
  for (const r of results) {
    if (r.status !== "sent" && r.status !== "failed") continue;
    await require("../../services/messageLog.service").record({
      channel: "email",
      provider: "resend",
      providerMessageId: r.providerMessageId || "",
      recipient: r.destination || "",
      subject: rendered?.email?.subject || rendered?.title || "",
      body: rendered?.email?.text || rendered?.body || "",
      status: r.status,
      error: r.error || null,
      tag: {
        type,
        audience: principal?.type === "staff" ? "staff" : principal?.type === "customer" ? "customer" : undefined,
        staffId: principal?.type === "staff" ? principal.id : null,
        customerId: principal?.type === "customer" ? principal.id : null,
        recipientName: contact?.name || "",
      },
    });
  }
  return results;
};

module.exports = { send, isEnabled, looksLikeEmail };
