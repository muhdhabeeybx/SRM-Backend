const recipients = require("../notifications/recipients");
const smsChannel = require("../notifications/channels/sms");
const emailChannel = require("../notifications/channels/email");
const { smsCopyEmail } = require("../notifications/templates/email");
const { copiesSmsToEmail } = require("../notifications/engine");
const { toPrincipal } = require("../utils/principal");

/**
 * A text to one member of staff, from the senders that build their own
 * message rather than going through notify() — the report reminder and desk
 * nudge buttons.
 *
 * It goes where every other staff text goes: to the number or numbers the
 * person chose (main, alternate or both — recipients.staffContact), and, while
 * STAFF_SMS_EMAIL_ENABLED is on, to their email too. The phone a caller hands
 * in is used only when there is no account to look up.
 *
 * Never throws for a send that did not go; it reports it.
 *
 * @returns {Promise<{success: boolean, message?: string, sentTo: string[]}>}
 */
const textStaff = async ({ staffId = null, phone = "", name = "", text, type, title = "Soroman notice" }) => {
  let contact = null;
  const id = Number(staffId);
  if (Number.isFinite(id) && id > 0) {
    const [found] = await recipients.resolve({ staffId: id });
    contact = found?.contact || null;
  }
  if (!contact) {
    const p = String(phone || "").trim();
    contact = { name, phone: p, phones: p ? [p] : [], email: "", emails: [] };
  }
  const principal = contact && id > 0 ? toPrincipal("staff", id) : null;

  const sms = await smsChannel.send({
    contact,
    rendered: { sms: text },
    entry: { category: "operations" },
    principal,
    type,
  });

  if (principal && copiesSmsToEmail(["sms"], principal) && contact.email) {
    try {
      await emailChannel.send({
        contact,
        rendered: { title, body: text, email: smsCopyEmail({ title, text }) },
        principal,
        type,
      });
    } catch (err) {
      console.error(`[staff-text] email copy for ${type} failed:`, err.message);
    }
  }

  const sentTo = sms.filter((r) => r.status === "sent").map((r) => r.destination);
  return {
    success: sentTo.length > 0,
    message: sentTo.length ? undefined : sms.find((r) => r.error)?.error || "SMS not accepted",
    sentTo,
  };
};

module.exports = { textStaff };
