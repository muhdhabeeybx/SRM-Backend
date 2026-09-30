/**
 * The message ledger: every SMS, email and WhatsApp message the platform sent,
 * and what each SMS cost. See db/migrations/0064.
 *
 * ── Writing ────────────────────────────────────────────────────────────────
 *
 * `record` is called at the provider boundary — sms.service route, email
 * sendMail and the engine's email channel, whatsapp sendReply — which are the
 * only doors a message can leave by. It never throws and never blocks a send:
 * a ledger that cannot be written must not become a message that cannot go.
 *
 * ── Costing ────────────────────────────────────────────────────────────────
 *
 * Termii's send response carries no charge, and the balance it echoes is
 * unreliable (some routes return 0). Its message history carries `amount` per
 * message, so `syncTermii` walks that history newest-first and writes the
 * charge onto the row with the same message id — or adds the row, when the
 * history holds a message the ledger never saw: everything before the ledger
 * existed, and anything sent from Termii's own dashboard.
 *
 * ── Who it went to ─────────────────────────────────────────────────────────
 *
 * `classify` matches each still-unknown row's phone or address against staff,
 * customers, stations, drivers and contacts, and labels the rest from the
 * notification engine's own delivery log where the message id matches.
 */
const axios = require("axios");
const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { messageLog } = require("../db/schema");

const TZ = "Africa/Lagos";
const AUDIENCES = ["customer", "staff", "driver", "station", "contact", "unknown"];
const CATEGORIES = ["transactional", "campaign", "otp"];
const CHANNELS = ["sms", "email", "whatsapp"];

const clip = (v, n) => String(v ?? "").slice(0, n);

/**
 * A live one-time code must never sit in a table the dashboard can read — it
 * would let whoever opens the log sign in as the customer. The digits after
 * "code is" / "OTP" are masked in every body, from the app and from Termii's
 * history alike, so an old code is masked the same way as a new one.
 */
const CODE_PATTERN = /((?:code|otp|pin|token)(?:\s+is)?\s*[:\-]?\s*)\d{4,8}/gi;
const redact = (body) => String(body ?? "").replace(CODE_PATTERN, "$1••••••");
const looksLikeOtp = (body) => /\b(verification|deletion|one[- ]time)\s+code\b|\botp\b/i.test(String(body || ""));

let warnedMissingTable = false;

/**
 * One message, as it left. Never throws.
 *
 * @param {object} m
 * @param {"sms"|"email"|"whatsapp"} m.channel
 * @param {string} m.provider  termii | resend | meta
 * @param {object} [m.tag]     what the caller knows: type, category, audience,
 *                             staffId, customerId, recipientName, campaignId
 */
async function record(m) {
  try {
    const tag = m.tag || {};
    const audience = AUDIENCES.includes(tag.audience) ? tag.audience : "unknown";
    const category = CATEGORIES.includes(tag.category)
      ? tag.category
      : tag.campaignId ? "campaign" : looksLikeOtp(m.body) ? "otp" : "transactional";
    await db
      .insert(messageLog)
      .values({
        channel: m.channel,
        provider: m.provider,
        providerMessageId: clip(m.providerMessageId, 255),
        recipient: clip(m.recipient, 255),
        recipientName: clip(tag.recipientName, 255),
        audience,
        staffId: tag.staffId ?? null,
        customerId: tag.customerId ?? null,
        category,
        type: clip(tag.type, 64),
        campaignId: tag.campaignId ?? null,
        route: clip(m.route, 20),
        sender: clip(m.sender, 64),
        subject: clip(m.subject, 2000),
        body: clip(redact(m.body), 4000),
        status: m.status || "sent",
        error: m.error ? clip(m.error, 2000) : null,
        // Email is not billed per message; WhatsApp is billed per conversation.
        // An SMS's charge is filled in by syncTermii.
        amount: m.amount != null ? String(m.amount) : null,
        currency: m.currency || "",
        origin: "app",
      })
      // The history row may have landed first (a sync racing a slow send);
      // either way it is one message.
      .onConflictDoNothing();
  } catch (err) {
    const missing = err?.code === "42P01" || err?.cause?.code === "42P01";
    if (missing) {
      if (!warnedMissingTable) console.warn("[message-log] table missing — run migration 0064");
      warnedMissingTable = true;
    } else {
      console.warn("[message-log] could not record a message:", err.message);
    }
  }
}

/** A Termii history timestamp ("2026-09-29 06:15:02") is Lagos time. */
const termiiTime = (v) => {
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}+01:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Termii's words for an outcome, onto ours. */
const statusFrom = (termii) => {
  const s = String(termii || "").toLowerCase();
  if (s.includes("deliver")) return "delivered";
  if (s.includes("fail") || s.includes("reject") || s.includes("expire") || s.includes("undeliver")) return "failed";
  return "sent";
};

const PAGE_SIZE = 200;

async function fetchTermiiPage(page) {
  const base = process.env.TERMII_BASE_URL || "https://v4.api.termii.com";
  const res = await axios.get(`${base}/api/sms/inbox`, {
    params: { api_key: process.env.TERMII_API_KEY, page, size: PAGE_SIZE },
    timeout: 60_000,
  });
  return Array.isArray(res.data) ? res.data : res.data?.data || res.data?.content || [];
}

/** Write one page of history: charge onto known rows, new rows for the rest. */
async function upsertTermiiRows(items) {
  const rows = items
    .filter((i) => i && i.message_id)
    .map((i) => ({
      channel: "sms",
      provider: "termii",
      providerMessageId: clip(i.message_id, 255),
      recipient: clip(i.receiver, 255),
      route: clip(i.sms_type, 20),
      sender: clip(i.sender, 64),
      body: clip(redact(i.message), 4000),
      category: looksLikeOtp(i.message) ? "otp" : "transactional",
      type: looksLikeOtp(i.message) ? "otp" : "",
      status: statusFrom(i.status),
      providerStatus: clip(i.status, 64),
      amount: i.amount == null || i.amount === "" ? null : String(Number(i.amount) || 0),
      currency: "NGN",
      origin: "provider",
      sentAt: termiiTime(i.created_at) || new Date(),
      costSyncedAt: new Date(),
    }));
  if (!rows.length) return 0;
  await db
    .insert(messageLog)
    .values(rows)
    .onConflictDoUpdate({
      target: [messageLog.provider, messageLog.providerMessageId],
      targetWhere: sql`provider_message_id <> ''`,
      set: {
        amount: sql`excluded.amount`,
        currency: sql`excluded.currency`,
        providerStatus: sql`excluded.provider_status`,
        // Delivered and failed are what the carrier found out later; our own
        // "sent" is only what Termii accepted.
        status: sql`CASE WHEN excluded.status <> 'sent' THEN excluded.status ELSE message_log.status END`,
        route: sql`COALESCE(NULLIF(excluded.route, ''), message_log.route)`,
        body: sql`COALESCE(NULLIF(message_log.body, ''), excluded.body)`,
        costSyncedAt: sql`excluded.cost_synced_at`,
        updatedAt: new Date(),
      },
    });
  return rows.length;
}

let syncing = null;

/**
 * Bring charges and statuses in from Termii's history.
 *
 * Incremental by default: newest first, stopping once a whole page is older
 * than two days before the newest message already costed — a message's status
 * and charge can still change for a day or so after it is sent, so the last
 * two days are always read again. `full` walks the whole history, which is how
 * the ledger is backfilled.
 *
 * One sync at a time: a second caller waits on the first.
 */
async function syncTermii({ full = false, maxPages = full ? 5000 : 60 } = {}) {
  if (!process.env.TERMII_API_KEY) return { ok: false, error: "SMS API key not configured", pages: 0, rows: 0 };
  if (syncing) return syncing;
  syncing = (async () => {
    let stopBefore = null;
    if (!full) {
      const [row] = await db
        .select({ at: sql`MAX(sent_at)` })
        .from(messageLog)
        .where(sql`provider = 'termii' AND cost_synced_at IS NOT NULL`);
      if (row?.at) stopBefore = new Date(new Date(row.at).getTime() - 2 * 24 * 3600 * 1000);
    }
    let pages = 0;
    let rows = 0;
    let previousFirst = null;
    for (let page = 0; page < maxPages; page += 1) {
      const items = await fetchTermiiPage(page);
      if (!items.length) break;
      // A provider that ignored the page number would hand back the same rows
      // for ever; the same first message twice means the history is exhausted.
      const first = items[0]?.message_id ?? items[0]?.id ?? null;
      if (first != null && first === previousFirst) break;
      previousFirst = first;
      rows += await upsertTermiiRows(items);
      pages += 1;
      if (stopBefore) {
        const newest = items.map((i) => termiiTime(i.created_at)).filter(Boolean).sort((a, b) => b - a)[0];
        if (newest && newest < stopBefore) break;
      }
      // No stopping on a short page: Termii caps a page at 100 whatever size is
      // asked for, so "fewer than 200" was true of the very first page and the
      // full history sync read 100 messages of ~12,000. An empty page is the end.
    }
    const classified = await classify();
    return { ok: true, pages, rows, classified };
  })();
  try {
    return await syncing;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    console.error("[message-log] Termii sync failed:", detail);
    return { ok: false, error: detail, pages: 0, rows: 0 };
  } finally {
    syncing = null;
  }
}

/**
 * Label who each unknown message went to.
 *
 * First from the engine's delivery log, which knows the principal, the type
 * and the campaign of every message it sent; then by matching the last ten
 * digits of the phone (or the address, for email) against the people the
 * platform knows. Staff first: a staff member who is also a customer was being
 * texted as staff far more often than not.
 */
async function classify() {
  const result = await db.execute(sql`
    WITH engine AS (
      UPDATE message_log m
         SET type        = CASE WHEN m.type = '' THEN d.type ELSE m.type END,
             campaign_id = COALESCE(m.campaign_id, d.campaign_id),
             category    = CASE
                             WHEN COALESCE(m.campaign_id, d.campaign_id) IS NOT NULL
                               OR d.type = 'system.announcement' THEN 'campaign'
                             ELSE m.category
                           END,
             staff_id    = COALESCE(m.staff_id, d.staff_id),
             customer_id = COALESCE(m.customer_id, d.customer_id),
             recipient_name = CASE WHEN m.recipient_name = '' THEN d.recipient_name ELSE m.recipient_name END,
             audience    = CASE
                             WHEN d.staff_id IS NOT NULL THEN 'staff'
                             WHEN d.customer_id IS NOT NULL THEN 'customer'
                             WHEN d.campaign_id IS NOT NULL THEN 'contact'
                             ELSE m.audience
                           END,
             updated_at  = now()
        FROM notification_deliveries d
       WHERE m.audience = 'unknown'
         AND m.provider_message_id <> ''
         AND d.provider_message_id = m.provider_message_id
       RETURNING m.id
    )
    SELECT count(*)::int AS n FROM engine
  `);
  let n = Number((result.rows ?? result)[0]?.n) || 0;

  const byPhone = async (audienceKey, source) => {
    // A literal from the fixed list above, not a parameter: Postgres cannot
    // type a bare parameter compared against a string in a CASE.
    const audience = sql.raw(`'${AUDIENCES.includes(audienceKey) ? audienceKey : "unknown"}'`);
    const r = await db.execute(sql`
      WITH hit AS (
        UPDATE message_log m
           SET audience = ${audience},
               recipient_name = CASE WHEN m.recipient_name = '' THEN p.name ELSE m.recipient_name END,
               staff_id = CASE WHEN ${audience} = 'staff' THEN COALESCE(m.staff_id, p.id) ELSE m.staff_id END,
               customer_id = CASE WHEN ${audience} = 'customer' THEN COALESCE(m.customer_id, p.id) ELSE m.customer_id END,
               updated_at = now()
          FROM (${source}) p
         WHERE m.audience = 'unknown'
           AND p.key <> ''
           AND (
             (m.channel IN ('sms', 'whatsapp') AND RIGHT(regexp_replace(m.recipient, '[^0-9]', '', 'g'), 10) = p.key)
             OR (m.channel = 'email' AND lower(m.recipient) = p.key)
           )
         RETURNING m.id
      )
      SELECT count(*)::int AS n FROM hit
    `);
    n += Number((r.rows ?? r)[0]?.n) || 0;
  };

  const digits = (col) => sql.raw(`RIGHT(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 10)`);
  await byPhone("staff", sql`
    SELECT DISTINCT ON (key) id, TRIM(COALESCE(first_name, '') || ' ' || COALESCE(surname, '')) AS name, key FROM (
      SELECT id, first_name, surname, ${digits("phone_number")} AS key FROM staff
      UNION ALL SELECT id, first_name, surname, lower(COALESCE(email, '')) FROM staff
    ) s ORDER BY key, id`);
  await byPhone("customer", sql`
    SELECT DISTINCT ON (key) id, name, key FROM (
      SELECT id, COALESCE(NULLIF(name, ''), company_name) AS name, ${digits("phone")} AS key FROM customers WHERE house_account IS NULL
      UNION ALL SELECT id, COALESCE(NULLIF(name, ''), company_name), lower(COALESCE(email, '')) FROM customers WHERE house_account IS NULL
    ) c ORDER BY key, id`);
  await byPhone("station", sql`
    SELECT DISTINCT ON (key) id, name, key FROM (
      SELECT id, name, ${digits("phone_number")} AS key FROM delivery_customers
       WHERE customer_type::text IN ('filling_station', 'lpg_plant')
    ) c ORDER BY key, id`);
  await byPhone("customer", sql`
    SELECT DISTINCT ON (key) NULL::int AS id, name, key FROM (
      SELECT name, ${digits("phone_number")} AS key FROM delivery_customers
       WHERE customer_type::text NOT IN ('filling_station', 'lpg_plant')
    ) c ORDER BY key`);
  await byPhone("driver", sql`
    SELECT DISTINCT ON (key) NULL::int AS id, name, key FROM (
      SELECT name, ${digits("phone")} AS key FROM drivers
      UNION ALL SELECT driver_name, ${digits("driver_phone")} FROM fleet_trucks WHERE COALESCE(driver_name, '') <> ''
    ) d ORDER BY key`);
  await byPhone("contact", sql`
    SELECT DISTINCT ON (key) NULL::int AS id, name, key FROM (
      SELECT name, phone_normalized AS key FROM contacts
    ) c ORDER BY key`);
  return n;
}

// ── Reading ────────────────────────────────────────────────────────────────

/** A Lagos calendar day as the instant it starts. */
const dayStart = (day) => sql`(${day}::date::timestamp AT TIME ZONE ${TZ})`;

function whereFor({ from, to, channel, audience, category, status, search }) {
  const parts = [];
  if (from) parts.push(sql`sent_at >= ${dayStart(from)}`);
  if (to) parts.push(sql`sent_at < ${dayStart(to)} + interval '1 day'`);
  if (CHANNELS.includes(channel)) parts.push(sql`channel = ${channel}`);
  if (AUDIENCES.includes(audience)) parts.push(sql`audience = ${audience}`);
  if (CATEGORIES.includes(category)) parts.push(sql`category = ${category}`);
  if (status && status !== "all") parts.push(sql`status = ${status}`);
  if (search) {
    const q = `%${String(search).trim()}%`;
    parts.push(sql`(recipient ILIKE ${q} OR recipient_name ILIKE ${q} OR body ILIKE ${q} OR subject ILIKE ${q} OR type ILIKE ${q})`);
  }
  return parts.length ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;
}

const rowsOf = (r) => r.rows ?? r;

/** The messages, newest first, a page at a time. */
async function list(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  const where = whereFor(filters);
  const [items, total] = await Promise.all([
    db.execute(sql`
      SELECT id, channel, provider, provider_message_id AS "providerMessageId", recipient,
             recipient_name AS "recipientName", audience, staff_id AS "staffId", customer_id AS "customerId",
             category, type, campaign_id AS "campaignId", route, sender, subject, body, status,
             provider_status AS "providerStatus", error, amount::float AS amount, currency, origin,
             sent_at AS "sentAt", cost_synced_at AS "costSyncedAt"
        FROM message_log ${where}
       ORDER BY sent_at DESC, id DESC
       LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `),
    db.execute(sql`SELECT count(*)::int AS n FROM message_log ${where}`),
  ]);
  const n = Number(rowsOf(total)[0]?.n) || 0;
  return { messages: rowsOf(items), pagination: { page, limit, total: n, pages: Math.ceil(n / limit) } };
}

/**
 * The totals for the same filters: overall, per Lagos day, per audience, per
 * category and per channel — each a count and the amount deducted.
 */
async function summary(filters = {}) {
  const where = whereFor(filters);
  const agg = sql`count(*)::int AS messages,
                  count(*) FILTER (WHERE status = 'failed')::int AS failed,
                  COALESCE(SUM(amount), 0)::float AS amount,
                  count(*) FILTER (WHERE channel = 'sms' AND amount IS NULL AND status <> 'failed')::int AS "uncosted"`;
  const [total, byDay, byAudience, byCategory, byChannel, lastSync] = await Promise.all([
    db.execute(sql`SELECT ${agg} FROM message_log ${where}`),
    db.execute(sql`
      SELECT to_char(sent_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day, ${agg}
        FROM message_log ${where} GROUP BY 1 ORDER BY 1 DESC LIMIT 400`),
    db.execute(sql`SELECT audience AS key, ${agg} FROM message_log ${where} GROUP BY 1 ORDER BY 3 DESC`),
    db.execute(sql`SELECT category AS key, ${agg} FROM message_log ${where} GROUP BY 1 ORDER BY 3 DESC`),
    db.execute(sql`SELECT channel AS key, ${agg} FROM message_log ${where} GROUP BY 1 ORDER BY 3 DESC`),
    db.execute(sql`SELECT MAX(cost_synced_at) AS at FROM message_log WHERE provider = 'termii'`),
  ]);
  return {
    total: rowsOf(total)[0],
    byDay: rowsOf(byDay),
    byAudience: rowsOf(byAudience),
    byCategory: rowsOf(byCategory),
    byChannel: rowsOf(byChannel),
    lastSyncedAt: rowsOf(lastSync)[0]?.at || null,
  };
}

module.exports = { record, syncTermii, classify, list, summary, termiiTime, statusFrom, redact, looksLikeOtp };
