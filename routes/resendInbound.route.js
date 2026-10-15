const express = require("express");
const { Resend } = require("resend");
const router = express.Router();
const { webhookEventRepo } = require("../repositories");
const staffMessageEmail = require("../services/staffMessageEmail.service");

/**
 * Mail Resend receives for us — today, replies to staff message emails
 * (services/staffMessageEmail.service.js).
 *
 * Set up in the Resend dashboard: receiving on the domain named by
 * STAFF_MESSAGE_REPLY_DOMAIN, and a webhook for `email.received` pointing at
 *   https://<api-host>/api/webhooks/resend-inbound
 * whose signing secret (whsec_…) goes in RESEND_INBOUND_WEBHOOK_SECRET.
 *
 * Resend signs with Svix over the exact bytes it sent, so the body is read raw
 * and verified before it is parsed; anything unsigned or forged is refused.
 * Delivery is at least once — receive() is idempotent on the email's id — and
 * an answer other than 2xx makes Resend try again, so only a failure worth
 * retrying (the email could not be fetched) answers 500.
 *
 * Each event is kept in webhook_events with what became of it, so a reply that
 * did not appear in a conversation can be traced to why.
 */
router.post("/", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const secret = String(process.env.RESEND_INBOUND_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.error("[resend-inbound] RESEND_INBOUND_WEBHOOK_SECRET is not set — refusing");
    return res.sendStatus(503);
  }

  let event;
  try {
    event = new Resend(process.env.RESEND_API_KEY || "re_unset").webhooks.verify({
      payload: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || ""),
      headers: {
        id: req.get("svix-id") || "",
        timestamp: req.get("svix-timestamp") || "",
        signature: req.get("svix-signature") || "",
      },
      webhookSecret: secret,
    });
  } catch {
    return res.sendStatus(401);
  }

  if (event?.type !== "email.received") return res.sendStatus(200);

  let record = null;
  try {
    record = await webhookEventRepo.create({ event: "resend.email.received", payload: event, status: "pending" });
  } catch (err) {
    console.error("[resend-inbound] could not log the event:", err.message);
  }
  const finish = (status, error = "") =>
    record ? webhookEventRepo.update(record.id, { status, error, processedAt: new Date() }).catch(() => {}) : null;

  try {
    const result = await staffMessageEmail.receive(event.data);
    await finish("processed", result.status === "posted" ? "" : `${result.status}: ${result.reason || ""}`.trim());
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[resend-inbound] failed:", err.message);
    await finish("failed", err.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
