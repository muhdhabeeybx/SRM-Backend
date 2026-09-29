const catalog = require("./catalog");
const recipients = require("./recipients");
const staffChoices = require("./staffChoices");
const inAppChannel = require("./channels/inApp");
const pushChannel = require("./channels/push");
const emailChannel = require("./channels/email");
const smsChannel = require("./channels/sms");
const notificationPreferenceRepo = require("../repositories/notificationPreference.repository");
const notificationDeliveryRepo = require("../repositories/notificationDelivery.repository");
const { principalKey } = require("../utils/principal");

/**
 * The notification engine.
 *
 * One entry point — `notify(type, { to, data })` — serving the mobile app, the
 * admin dashboard and the web portal alike. It decides WHO hears about
 * something (recipients), WHETHER they want to (preferences, quiet hours),
 * HOW they hear (channels) and records WHAT actually happened (deliveries).
 * Copy and routing live in ./catalog.js; business code supplies only facts.
 *
 * Two invariants shape everything below:
 *
 *   1. A notification must never break the business operation that triggered
 *      it. An order that committed has committed; a Termii outage cannot be
 *      allowed to turn that into a 500. Every failure path here therefore
 *      logs and continues.
 *
 *   2. Every attempt is recorded. "The customer says they weren't told" is
 *      answerable from `notification_deliveries` — including the sends that
 *      were deliberately suppressed by someone's own preferences.
 */

const CHANNEL_KEYS = {
  in_app: "inApp",
  push: "push",
  email: "email",
  sms: "sms",
};

const SENDERS = {
  push: pushChannel.send,
  email: emailChannel.send,
  sms: smsChannel.send,
};

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Templates are caller-fed and must never take the engine down, so each one is
 * called behind a guard. A template that throws degrades that one field to a
 * fallback and leaves the rest of the notification intact.
 */
const safely = (label, fn, fallback, data) => {
  if (typeof fn !== "function") return fallback;
  try {
    const value = fn(data);
    return value === undefined || value === null ? fallback : value;
  } catch (err) {
    console.error(`[notify] template "${label}" threw:`, err.message);
    return fallback;
  }
};

const clampString = (value, max) => {
  const s = String(value ?? "");
  return s.length <= max ? s : s.slice(0, max);
};

/**
 * Turn a catalog entry plus data into the concrete strings each channel sends.
 *
 * Rendered per recipient rather than once per notify(): the dedupe key must be
 * scoped to the recipient, and personalised copy (a greeting by name) reads
 * from the recipient's own contact record.
 */
const render = (type, entry, data, { principal, contact }) => {
  const d = {
    ...data,
    // Templates greet by whichever name they know; give them the recipient's
    // real one when the caller didn't supply it explicitly.
    customerName: data.customerName ?? contact?.name ?? "",
    recipientName: contact?.name ?? "",
  };

  const title = clampString(safely(`${type}.title`, entry.title, "Notification", d), 255) || "Notification";
  const body = String(safely(`${type}.body`, entry.body, "", d));
  const entity = safely(`${type}.entity`, entry.entity, {}, d) || {};

  const rawDedupe = safely(`${type}.dedupe`, entry.dedupe, null, d) || data.dedupeKey || null;
  // Scoped to the recipient. A shared key would make the partial unique index
  // on `dedupe_key` admit the FIRST recipient of a broadcast and silently drop
  // everyone else — the fan-out would look successful and reach one person.
  const dedupeKey =
    rawDedupe && principal ? clampString(`${principalKey(principal)}|${rawDedupe}`, 160) : rawDedupe ? clampString(rawDedupe, 160) : null;

  return {
    type,
    category: entry.category,
    priority: data.priority || entry.priority || "normal",
    title,
    body,
    data: safely(`${type}.data`, entry.data, {}, d) || {},
    entity: {
      type: clampString(entity.type || "", 64),
      id: clampString(entity.id ?? "", 64),
    },
    actionUrl: safely(`${type}.actionUrl`, entry.actionUrl, null, d),
    imageUrl: safely(`${type}.imageUrl`, entry.imageUrl, null, d),
    dedupeKey,
    // Per-channel overrides. A null SMS/email means "this type has nothing to
    // say on that channel" and the channel records `skipped` rather than
    // inventing copy from the in-app title.
    sms: safely(`${type}.sms`, entry.sms, null, d) ?? defaultSmsText(title, body),
    email: safely(`${type}.email`, entry.email, null, d),
    push: safely(`${type}.push`, entry.push, null, d),
  };
};

/**
 * When a type declares SMS but supplies no bespoke text, fall back to the
 * in-app copy. Better a plain sentence than a silent non-delivery — and the
 * catalog can always override it.
 */
const defaultSmsText = (title, body) => {
  const text = [title, body].filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
  return text || null;
};

// ─── Quiet hours ────────────────────────────────────────────────────────────

const DEFAULT_TZ = () => process.env.NOTIFY_DEFAULT_TZ || "Africa/Lagos";

/**
 * Minutes past midnight in a given IANA zone.
 *
 * `hourCycle: "h23"` rather than `hour12: false` — the latter renders midnight
 * as "24" in several ICU versions, which would put 00:15 outside a
 * 22:00–07:00 window and let a 3 a.m. SMS through.
 */
const minutesInZone = (date, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    // An invalid timezone string must not suppress notifications — treat it as
    // "outside quiet hours" and let the message through.
    return -1;
  }
};

/** Windows may wrap midnight (22:00 → 07:00 is start 1320, end 420). */
const inQuietHours = (settings, now = new Date()) => {
  if (!settings?.quietHoursEnabled) return false;
  const minutes = minutesInZone(now, settings.timezone || DEFAULT_TZ());
  if (minutes < 0) return false;

  const { quietHoursStart: start, quietHoursEnd: end } = settings;
  if (start === end) return false; // a zero-length window silences nothing
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

// Only the channels that make a noise on a device. An in-app row is silent by
// nature and an email lands in an inbox nobody is woken by.
const QUIET_HOURS_CHANNELS = new Set(["push", "sms"]);

// ─── Channel gating ─────────────────────────────────────────────────────────

/**
 * Decide which channels a given recipient actually gets, and why the others
 * were dropped. Returns `{ allowed: [...], suppressed: [{channel, reason}] }`
 * so the suppressions can be recorded rather than vanishing.
 */
/**
 * Staff email, paused.
 *
 * Every order and every payment emailed all twelve staff, which came to ~580
 * emails a day against a plan that allows 100 — so the allowance was gone by
 * mid-morning and everything after it, including the Reports Hub's own send,
 * came back "daily sending quota exceeded". Customers were losing their mail
 * to a queue of internal notices.
 *
 * Off by default rather than behind an env var someone has to remember to set,
 * because the point is that it takes effect in production today. Set
 * STAFF_EMAIL_ENABLED=true to bring it back.
 *
 * Two things keep emailing staff regardless:
 *
 *   - anything `mandatory` — the password setup and reset mails. Nobody can be
 *     invited or recover an account without them, and they are two sends a
 *     week, not two thousand.
 *   - the `reports` category — the daily report and the Reports Hub button are
 *     a person asking for an email and expecting it to arrive.
 *
 * Staff lose no information: in-app and push are untouched, so the dashboard
 * bell still shows every order and payment. Only the mailbox copy stops.
 */
const STAFF_EMAIL_ALWAYS = new Set(["reports"]);
const staffEmailEnabled = () => process.env.STAFF_EMAIL_ENABLED === "true";

const staffEmailPaused = (entry, principal) =>
  principal?.type === "staff" &&
  !entry.mandatory &&
  !STAFF_EMAIL_ALWAYS.has(entry.category) &&
  !staffEmailEnabled();

const gateChannels = ({ entry, rendered, principal, contact, prefs, settings, override, force }) => {
  const requested = override?.length ? override : entry.channels || [];
  const allowed = [];
  const suppressed = [];

  const categoryPref = prefs?.[entry.category];
  const urgent = rendered.priority === "urgent";
  const quiet = !urgent && inQuietHours(settings);

  for (const channel of requested) {
    // A recipient with no account has no inbox and no devices — only an
    // address. Silently dropping these would be misleading in the log.
    if (!principal && (channel === "in_app" || channel === "push")) {
      suppressed.push({ channel, reason: "Recipient has no account" });
      continue;
    }
    if (channel === "email" && !contact?.email) {
      suppressed.push({ channel, reason: "No email address on file" });
      continue;
    }
    // Recorded, not silently dropped: "why did I stop getting these?" has to
    // be answerable from the delivery log.
    if (channel === "email" && staffEmailPaused(entry, principal)) {
      suppressed.push({ channel, reason: "Staff email paused (STAFF_EMAIL_ENABLED)" });
      continue;
    }
    if (channel === "sms" && !contact?.phone) {
      suppressed.push({ channel, reason: "No phone number on file" });
      continue;
    }

    // Security notices and credentials in transit are not opt-outable: someone
    // who muted "security" and was then taken over would have muted their only
    // warning. `force` is the operator's equivalent for a one-off send.
    if (!entry.mandatory && !force) {
      const key = CHANNEL_KEYS[channel];
      if (categoryPref && categoryPref[key] === false) {
        suppressed.push({ channel, reason: `Muted: ${entry.category}` });
        continue;
      }
      if (settings) {
        if (channel === "push" && settings.pushEnabled === false) {
          suppressed.push({ channel, reason: "Push disabled in settings" });
          continue;
        }
        if (channel === "email" && settings.emailEnabled === false) {
          suppressed.push({ channel, reason: "Email disabled in settings" });
          continue;
        }
        if (channel === "sms" && settings.smsEnabled === false) {
          suppressed.push({ channel, reason: "SMS disabled in settings" });
          continue;
        }
      }
      if (quiet && QUIET_HOURS_CHANNELS.has(channel)) {
        // Dropped, not deferred. A queue of overnight buzzes that all fire at
        // 07:00 is worse than the notification arriving only in the inbox —
        // and the in-app row is still there to be read.
        suppressed.push({ channel, reason: "Quiet hours" });
        continue;
      }
    }

    allowed.push(channel);
  }

  return { allowed, suppressed };
};

// ─── Delivery to one recipient ──────────────────────────────────────────────

const deliverToRecipient = async ({ type, entry, data, recipient, override, force, campaignId }) => {
  const { principal, contact } = recipient;
  const rendered = render(type, entry, data, recipient);

  // Stamped onto every delivery row this recipient produces. `recipientName`
  // is denormalised on purpose: a broadcast to leads has no principal at all,
  // so without it the log can only ever show a bare phone number — which is
  // what made "who did we message on Tuesday?" unanswerable.
  const stamp = { campaignId: campaignId || null, recipientName: contact?.name || "" };

  let prefs = null;
  let settings = null;
  if (principal && !entry.mandatory && !force) {
    // Both are "deviation" tables — a principal who never opened the settings
    // screen has no rows, and that is the fast, common path.
    [prefs, settings] = await Promise.all([
      notificationPreferenceRepo.findAllAsMap(principal).catch(() => null),
      notificationPreferenceRepo.getSettings(principal).catch(() => null),
    ]);
  }

  const { allowed, suppressed } = gateChannels({
    entry,
    rendered,
    principal,
    contact,
    prefs,
    settings,
    override,
    force,
  });

  // The inbox row comes first: it is the anchor every delivery row points at,
  // and its dedupe key is what makes the whole fan-out idempotent.
  let notification = null;
  if (allowed.includes("in_app") && entry.inbox !== false && principal) {
    const result = await inAppChannel.create({ principal, rendered, entry, type });
    if (result.duplicate) {
      // Already sent to this recipient. Stopping here — rather than only
      // skipping the inbox row — is what stops a retried job or a
      // double-fired event from sending a second SMS.
      return { principal, duplicate: true, notification: null, channels: {} };
    }
    notification = result.notification;
    rendered.notificationId = notification?.id;
    await inAppChannel.publish(principal, notification);
  }

  const outcomes = {};

  // Record the suppressions before sending anything, so "why didn't they get
  // the SMS?" is answerable even when every other channel succeeded.
  await Promise.all(
    suppressed.map(({ channel, reason }) =>
      notificationDeliveryRepo.record(
        {
          ...stamp,
          notificationId: notification?.id || null,
          principal,
          type,
          channel,
          destination: channel === "email" ? contact?.email || "" : channel === "sms" ? contact?.phone || "" : "",
        },
        // A missing address is a data gap; a muted category is the recipient's
        // own choice. The delivery status keeps them apart.
        /No .* on file|no account/i.test(reason) ? "skipped" : "suppressed",
        reason
      )
    )
  );

  if (allowed.includes("in_app")) {
    outcomes.in_app = notification ? "sent" : entry.inbox === false ? "skipped" : "duplicate";
  }

  // Outbound channels run concurrently — a slow Termii call must not delay the
  // email, and neither can fail the other.
  //
  // `channelErrors` carries the provider's own words back to the caller. The
  // outcome strings alone say "failed" without saying why, so a caller that
  // reports the result to a person — the Reports Hub's "Email report" button —
  // had nothing to show but a generic apology, while the real answer ("the
  // soromannl.com domain is not verified") sat in the delivery log where
  // nobody was looking.
  const channelErrors = {};
  const outbound = allowed.filter((c) => c !== "in_app");
  await Promise.all(
    outbound.map(async (channel) => {
      const sender = SENDERS[channel];
      if (!sender) return;

      let results;
      try {
        results = await sender({ principal, contact, rendered, entry, type });
      } catch (err) {
        // A channel that throws instead of returning is a bug in the channel;
        // record it as a failure rather than losing the whole notification.
        console.error(`[notify] channel "${channel}" threw for ${type}:`, err.message);
        results = [{ destination: "", status: "failed", error: err.message }];
      }

      outcomes[channel] = results.every((r) => r.status === "sent")
        ? "sent"
        : results.some((r) => r.status === "sent")
          ? "partial"
          : results[0]?.status || "failed";

      const firstError = results.find((r) => r.error)?.error;
      if (firstError) channelErrors[channel] = firstError;

      await Promise.all(
        results.map(async (r) => {
          const opened = await notificationDeliveryRepo.start({
            ...stamp,
            notificationId: notification?.id || null,
            principal,
            type,
            channel,
            destination: r.destination,
          });
          if (!opened) return;
          if (r.status === "sent") {
            return notificationDeliveryRepo.markSent(opened.id, {
              providerMessageId: r.providerMessageId,
            });
          }
          if (r.status === "failed") {
            return notificationDeliveryRepo.markFailed(opened.id, r.error);
          }
          return notificationDeliveryRepo.markResolved(opened.id, r.status, r.error || "");
        })
      );
    })
  );

  return { principal, duplicate: false, notification, channels: outcomes, channelErrors, suppressed };
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Deliver now, synchronously, and report what happened.
 *
 * This is what the queue worker calls, and what tests call when they need to
 * assert on the outcome. Business code should call `notify()` instead.
 *
 * @param {string} type            a catalog key, e.g. "order.released"
 * @param {object} opts
 * @param {object|Array} opts.to   recipient spec(s) — see ./recipients.js
 * @param {object} [opts.data]     the template's data contract
 * @param {string[]} [opts.channels] restrict to these channels
 * @param {boolean} [opts.force]   ignore preferences and quiet hours
 * @param {number} [opts.campaignId] the broadcast these sends belong to, so
 *                                 every resulting delivery row can be grouped
 *                                 back under one campaign. Null for the
 *                                 transactional types, which have none.
 */
const dispatch = async (type, { to, data = {}, channels, force = false, campaignId = null } = {}) => {
  const entry = catalog.getTypeOrDefault(type);
  if (!catalog.isKnownType(type)) {
    // Loud, but still delivered: a typo'd type reaches the recipient as a
    // readable row and shows up in the log, instead of disappearing.
    console.warn(`[notify] unknown notification type "${type}" — using fallback template`);
  }

  // Resolution is the one step whose failure would take out EVERY recipient at
  // once, so it is caught and named here rather than surfacing as a bare
  // rejection that notify()'s swallow turns into silence. A broken recipient
  // query once meant role broadcasts reached nobody while every log line still
  // looked healthy.
  let resolved;
  try {
    resolved = await recipients.resolve(to);
  } catch (err) {
    console.error(`[notify] could not resolve recipients for "${type}":`, err.message);
    return { type, recipients: 0, delivered: 0, duplicates: 0, results: [], error: err.message };
  }

  // Each person's own choice of notices, ticked by an admin on Manage Users
  // (./staffChoices.js): somebody switched off is dropped from every channel,
  // somebody switched on is added, and an order notice reaches only those
  // whose PFIs or depots hold the order. If the choices cannot be read, the send
  // goes to the recipients as resolved — a notice reaching one person too
  // many is better than one reaching nobody.
  try {
    resolved = await staffChoices.apply(type, resolved, data);
  } catch (err) {
    console.error(`[notify] could not apply staff notification choices for "${type}":`, err.message);
  }

  if (!resolved.length) {
    return { type, recipients: 0, delivered: 0, duplicates: 0, results: [] };
  }

  // Recipients are delivered in bounded-concurrency batches, not one at a
  // time: each recipient can cost up to two sequential Termii round trips
  // (see notifications/channels/sms.js's generic→dnd fallback), so a serial
  // loop over an "allStaff" or large-list broadcast summed those seconds
  // across every recipient and blew past the dashboard's request timeout —
  // invisible when SMS_ENABLED=false short-circuited every attempt, real as
  // soon as it did actual network I/O. The cap keeps a big broadcast from
  // opening dozens of simultaneous provider connections at once.
  const DISPATCH_CONCURRENCY = Number(process.env.NOTIFY_DISPATCH_CONCURRENCY || 10);
  const results = [];
  for (let i = 0; i < resolved.length; i += DISPATCH_CONCURRENCY) {
    const batch = resolved.slice(i, i + DISPATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (recipient) => {
        try {
          return await deliverToRecipient({ type, entry, data, recipient, override: channels, force, campaignId });
        } catch (err) {
          // One recipient's failure must not cost the others their notification.
          console.error(
            `[notify] delivery to ${recipient.principal ? principalKey(recipient.principal) : recipient.contact.email || recipient.contact.phone} failed for ${type}:`,
            err.message
          );
          return { principal: recipient.principal, error: err.message, channels: {} };
        }
      })
    );
    results.push(...batchResults);
  }

  return {
    type,
    recipients: resolved.length,
    delivered: results.filter((r) => !r.duplicate && !r.error).length,
    duplicates: results.filter((r) => r.duplicate).length,
    results,
  };
};

module.exports = {
  dispatch,
  render,
  gateChannels,
  staffEmailPaused,
  inQuietHours,
  minutesInZone,
  defaultSmsText,
  CHANNEL_KEYS,
};
