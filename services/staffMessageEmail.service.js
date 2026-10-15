const crypto = require("crypto");
const { Resend } = require("resend");
const { client } = require("../config/db");
const { staffContact } = require("../notifications/recipients");
const { documentEmail, escapeHtml } = require("../notifications/templates/email");

/**
 * Staff messages by email, both ways (migration 0087).
 *
 * The owner's choice (15 Oct 2026): a conversation happens in the dashboard
 * and in people's inboxes at once, and every word of it is kept here.
 *
 *   OUT  Every message is emailed, text and all, to the recipient's main
 *        address, alternate, or both — whatever they chose (staff.email_to,
 *        recipients.staffContact). It goes straight through Resend, not the
 *        notification engine, so the STAFF_EMAIL_ENABLED pause on staff
 *        notices does not stop it. STAFF_MESSAGE_EMAIL_ENABLED=false does.
 *
 *   IN   The email's Reply-To is an address of its own for that conversation
 *        at STAFF_MESSAGE_REPLY_DOMAIN, signed so it cannot be guessed. Resend
 *        receives the reply and posts it to /api/webhooks/resend-inbound
 *        (routes/resendInbound.route.js); the text above the quoted email
 *        becomes a message from the replier, which is then emailed on to the
 *        other person like any other. Until the domain is set, the email says
 *        to answer in the dashboard instead.
 *
 * A reply is taken only from an address on the replier's own account (main or
 * alternate), and never from mail that failed DMARC — the reply address alone
 * is not proof of who wrote it, since it travels inside every forwarded copy.
 */

const enabled = () => process.env.STAFF_MESSAGE_EMAIL_ENABLED !== "false";
const replyDomain = () => String(process.env.STAFF_MESSAGE_REPLY_DOMAIN || "").trim().replace(/^@/, "").toLowerCase();

/** Replaceable in tests; the real thing everywhere else. */
let resendClient = null;
const deps = {
  sendMail: (payload) => require("./email.service").sendMail(payload),
  getReceived: async (emailId) => {
    resendClient = resendClient || new Resend(process.env.RESEND_API_KEY);
    return resendClient.emails.receiving.get(emailId);
  },
};

const clean = (v) => String(v ?? "").trim();
const nameOf = (row) =>
  [row.first_name ?? row.firstName, row.surname].map(clean).filter(Boolean).join(" ") || `Staff #${row.id}`;

// ─── The reply address ──────────────────────────────────────────────────────

/**
 * The key reply addresses are signed with. Its own variable where one is set,
 * else derived from the staff token secret, which every deployment has.
 */
const replyKey = () => {
  const own = clean(process.env.STAFF_MESSAGE_REPLY_SECRET);
  const base = own || clean(process.env.STAFF_ACCESS_TOKEN_SECRET);
  if (!base) throw new Error("No secret to sign staff message reply addresses with");
  return crypto.createHash("sha256").update(`staff-message-reply:${base}`).digest();
};

const sign = (replierId, otherId) =>
  crypto.createHmac("sha256", replyKey()).update(`${replierId}.${otherId}`).digest("hex").slice(0, 16);

/** Where `replierId` answers `otherId`: "chat-12-34-<sig>@<domain>", or null with no domain. */
const replyAddress = (replierId, otherId) => {
  const domain = replyDomain();
  if (!domain) return null;
  return `chat-${Number(replierId)}-${Number(otherId)}-${sign(replierId, otherId)}@${domain}`;
};

/** The conversation a reply address names, or null when it is not one of ours or not genuine. */
const parseReplyAddress = (address) => {
  const m = clean(address).toLowerCase().match(/^(?:.*<)?chat-(\d+)-(\d+)-([0-9a-f]{16})@([^>\s]+)>?$/);
  if (!m) return null;
  const [, a, b, sig, domain] = m;
  if (replyDomain() && domain !== replyDomain()) return null;
  const replierId = Number(a);
  const otherId = Number(b);
  if (!replierId || !otherId || replierId === otherId) return null;
  const expected = sign(replierId, otherId);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { replierId, otherId };
};

// ─── Out: a message, as an email ────────────────────────────────────────────

/** "Soroman Energy <orders@soromannl.com>" → "orders@soromannl.com". */
const fromAddress = () => {
  const from = clean(process.env.EMAIL_FROM) || "Soroman Dashboard <onboarding@resend.dev>";
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
};

const adminLink = (path) => {
  const base = clean(process.env.ADMIN_URL || process.env.CLIENT_URL).replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
};

/** The whole staff row the contact rules read — main, alternate and the choice between them. */
const loadContactRow = async (id) => {
  const [row] = await client`
    SELECT id, first_name, surname, email, alt_email, email_to, phone_number, alt_phone_number, sms_to,
           roles, is_active
      FROM staff WHERE id = ${id}
  `;
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    surname: row.surname,
    email: row.email,
    altEmail: row.alt_email,
    emailTo: row.email_to,
    phoneNumber: row.phone_number,
    altPhoneNumber: row.alt_phone_number,
    smsTo: row.sms_to,
    roles: row.roles,
    isActive: row.is_active,
  };
};

/** The email for one message, from `sender` to the person reading it. */
const messageEmail = ({ message, sender, reply }) => {
  const senderName = nameOf(sender);
  const lines = String(message.body || "");
  return documentEmail({
    // The same subject for every message from one person, so a mailbox
    // threads the conversation the way the dashboard does.
    subject: `Message from ${senderName}`,
    subtitle: "Message",
    preheader: lines.replace(/\s+/g, " ").slice(0, 140),
    heading: `${senderName} sent you a message`,
    blocks: [
      {
        type: "text",
        html: escapeHtml(lines).replace(/\r?\n/g, "<br>"),
        plain: lines,
      },
      {
        type: "note",
        text: reply
          ? "Reply to this email and your answer goes straight into your conversation on the Soroman dashboard."
          : "Replies to this email are not delivered — answer on the Soroman dashboard.",
      },
      { type: "button", url: adminLink(`/messages?with=${Number(sender.id)}`), label: "Open the conversation" },
    ],
  });
};

/**
 * Email one message to its recipient, and record on the row what happened:
 * when it went and to which addresses, or why it did not. Never throws — the
 * message is already in the conversation whatever the mailbox does.
 */
const emailMessage = async (messageId) => {
  try {
    const [message] = await client`
      SELECT id, sender_id, recipient_id, body FROM staff_messages WHERE id = ${messageId}
    `;
    if (!message || !message.sender_id || !message.recipient_id) return { sent: false, reason: "no message" };
    if (!enabled()) return { sent: false, reason: "STAFF_MESSAGE_EMAIL_ENABLED=false" };

    const [sender, recipient] = await Promise.all([
      loadContactRow(message.sender_id),
      loadContactRow(message.recipient_id),
    ]);
    if (!sender || !recipient) return { sent: false, reason: "account gone" };

    const to = staffContact(recipient).emails;
    if (!to.length) {
      await client`UPDATE staff_messages SET email_error = 'No email address on the account' WHERE id = ${message.id}`;
      return { sent: false, reason: "no address" };
    }

    const reply = replyAddress(message.recipient_id, message.sender_id);
    const mail = messageEmail({ message, sender, reply });
    const pair = [Number(message.sender_id), Number(message.recipient_id)].sort((x, y) => x - y);
    const thread = `<staff-chat-${pair[0]}-${pair[1]}@${fromAddress().split("@")[1] || "soroman"}>`;
    const senderName = nameOf(sender).replace(/["<>]/g, "");

    const result = await deps.sendMail({
      from: `${senderName} via Soroman <${fromAddress()}>`,
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(reply ? { replyTo: reply } : {}),
      headers: { References: thread, "In-Reply-To": thread },
    });

    if (result?.skipped) return { sent: false, reason: "email off" };
    if (result?.error) {
      await client`UPDATE staff_messages SET email_error = ${String(result.error.message || "Email failed").slice(0, 500)} WHERE id = ${message.id}`;
      return { sent: false, reason: result.error.message };
    }
    await client`
      UPDATE staff_messages
         SET emailed_at = now(), emailed_to = ${to.join(", ")}, email_error = NULL
       WHERE id = ${message.id}
    `;
    return { sent: true, to };
  } catch (err) {
    console.error("[staff-messages] email failed:", err.message);
    await client`UPDATE staff_messages SET email_error = ${String(err.message).slice(0, 500)} WHERE id = ${messageId}`
      .catch(() => {});
    return { sent: false, reason: err.message };
  }
};

// ─── In: a reply, as a message ──────────────────────────────────────────────

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, "&");

/** An HTML email as plain text, with the quoted email (a blockquote) dropped. */
const htmlToText = (html) => {
  let s = String(html || "");
  const dataUri = s.match(/^data:text\/html[^,]*;base64,(.*)$/s);
  if (dataUri) s = Buffer.from(dataUri[1], "base64").toString("utf8");
  else if (/^data:text\/html[^,]*,/.test(s)) s = decodeURIComponent(s.replace(/^data:text\/html[^,]*,/, ""));
  return decodeEntities(
    s
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<div[^>]*class="?gmail_quote[\s\S]*$/i, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
};

/** Where the quoted email begins, in the forms the common mail apps write it. */
const QUOTE_STARTS = [
  /^[ \t>]*On\s[^\n]*(?:\n[^\n]*)?\swrote:[ \t]*$/im, // Gmail, Apple Mail, most phones
  /^[ \t]*-{2,}\s*Original Message\s*-{2,}/im, // Outlook, older
  /^[ \t]*\*?From:\*?[^\n]*\n[ \t]*\*?(?:Sent|Date):/im, // Outlook's header block
  /^[ \t]*_{8,}[ \t]*$/m, // Outlook's rule above it
  /^[ \t]*Sent from my [^\n]+$/im, // a phone's signature
  /^[ \t]*Get Outlook for [^\n]+$/im,
];

/**
 * What the replier actually wrote: the email's text above the quoted message
 * it answers, without quoted (">") lines. Empty when there is nothing new.
 */
const replyText = ({ text, html }) => {
  let s = clean(text) ? String(text) : htmlToText(html);
  s = s.replace(/\r\n?/g, "\n");
  let cut = s.length;
  for (const re of QUOTE_STARTS) {
    const m = s.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  return s
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const bare = (address) => {
  const s = clean(address).toLowerCase();
  const m = s.match(/<([^>]+)>/);
  return m ? m[1] : s;
};

/**
 * One received email (the `data` of Resend's `email.received` event). Returns
 * what became of it: { status: 'posted' | 'duplicate' | 'ignored', ... }.
 * Throws only on a failure worth the provider retrying (fetching the email).
 */
const receive = async (data) => {
  const emailId = clean(data?.email_id);
  if (!emailId) return { status: "ignored", reason: "no email id" };

  const [seen] = await client`SELECT id FROM staff_messages WHERE inbound_email_id = ${emailId}`;
  if (seen) return { status: "duplicate", messageId: Number(seen.id) };

  const addresses = [...(data.to || []), ...(data.cc || []), ...(data.received_for || [])];
  const route = addresses.map(parseReplyAddress).find(Boolean);
  if (!route) return { status: "ignored", reason: "not addressed to a conversation" };

  const [replier, other] = await Promise.all([loadContactRow(route.replierId), loadContactRow(route.otherId)]);
  if (!replier || !other) return { status: "ignored", reason: "account gone" };

  const { data: email, error } = await deps.getReceived(emailId);
  if (error || !email) throw new Error(`Could not fetch received email ${emailId}: ${error?.message || "no data"}`);

  const from = bare(email.from || data.from);
  const own = [replier.email, replier.altEmail].map(bare).filter(Boolean);
  if (!own.includes(from)) {
    return { status: "ignored", reason: `${from} is not an address on ${nameOf(replier)}'s account` };
  }
  const auth = email.authentication || {};
  if (auth.dmarc === "fail" || (auth.spf === "fail" && auth.dkim === "fail")) {
    return { status: "ignored", reason: "the email failed sender authentication" };
  }

  let body = replyText({ text: email.text, html: email.html });
  if (!body) return { status: "ignored", reason: "nothing written above the quoted email" };
  const { MAX_BODY, send } = require("./staffMessages.service");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - 1)}…`;

  try {
    const { message } = await send(route.replierId, route.otherId, body, { via: "email", inboundEmailId: emailId });
    return { status: "posted", messageId: message.id };
  } catch (err) {
    // The same email delivered twice at once: the unique index let one in.
    if (err.code === "23505") return { status: "duplicate" };
    if (err.status && err.status < 500) return { status: "ignored", reason: err.message };
    throw err;
  }
};

module.exports = {
  emailMessage,
  receive,
  replyAddress,
  parseReplyAddress,
  replyText,
  messageEmail,
  deps,
};
