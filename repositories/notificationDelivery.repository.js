const { eq, and, or, desc, count, sql, lt, lte, gte, ilike, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { notificationDeliveries } = require("../db/schema");
const { REASON_SQL, REASON_CATALOG } = require("../utils/deliveryReason");
const { dayEdge, lagosToday, localDateStr } = require("../lib/zonedDay");

/**
 * The outbound audit trail. Writes here must never break a send — this is
 * bookkeeping about a side effect, and losing the bookkeeping is strictly
 * better than losing the notification. Every writer is therefore wrapped so a
 * logging failure is reported and swallowed.
 */

const safe = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[notify] delivery log ${label} failed:`, err.message);
    return null;
  }
};

/** Open a delivery record before the provider is called. */
const start = async ({
  notificationId = null,
  principal = null,
  type,
  channel,
  destination = "",
  campaignId = null,
  recipientName = "",
}) => {
  return safe("start", async () => {
    const [row] = await db
      .insert(notificationDeliveries)
      .values({
        notificationId,
        campaignId: campaignId ? Number(campaignId) : null,
        principalType: principal?.type || null,
        staffId: principal?.type === "staff" ? Number(principal.id) : null,
        customerId: principal?.type === "customer" ? Number(principal.id) : null,
        // The name as it stood at send time. A contact has no principal to
        // look one up from later, and a customer may be renamed afterwards —
        // an audit log should say who was actually written to.
        recipientName: String(recipientName || "").slice(0, 255),
        type,
        channel,
        destination: String(destination || "").slice(0, 255),
        status: "pending",
        attempts: 0,
      })
      .returning();
    return row;
  });
};

const markSent = async (id, { providerMessageId = "", attempts = 1 } = {}) => {
  if (!id) return null;
  return safe("markSent", async () => {
    const [row] = await db
      .update(notificationDeliveries)
      .set({
        status: "sent",
        providerMessageId: String(providerMessageId || "").slice(0, 255),
        attempts,
        error: null,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, id))
      .returning();
    return row;
  });
};

const markFailed = async (id, error, { attempts = 1 } = {}) => {
  if (!id) return null;
  return safe("markFailed", async () => {
    const [row] = await db
      .update(notificationDeliveries)
      .set({
        status: "failed",
        attempts,
        // Provider errors can carry an entire HTML error page; a truncated
        // message is diagnosable, an unbounded one bloats every row.
        error: String(error || "").slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, id))
      .returning();
    return row;
  });
};

/**
 * Terminal, non-error outcomes. `skipped` = nothing to send to (no email on
 * file); `suppressed` = the recipient's own preferences said no. Recorded
 * rather than dropped, so "why didn't they get it?" always has an answer.
 */
const markResolved = async (id, status, reason = "") => {
  if (!id) return null;
  return safe("markResolved", async () => {
    const [row] = await db
      .update(notificationDeliveries)
      .set({ status, error: reason ? String(reason).slice(0, 2000) : null, updatedAt: new Date() })
      .where(eq(notificationDeliveries.id, id))
      .returning();
    return row;
  });
};

/** One-shot record for an outcome already known — no provider call was made. */
const record = async (fields, status, reason = "") => {
  return safe("record", async () => {
    const opened = await start(fields);
    if (!opened) return null;
    return markResolved(opened.id, status, reason);
  });
};

/**
 * A carrier delivery receipt, matched to the send it belongs to.
 *
 * This is the other half of "delivered or not". `sent` only ever meant "Termii
 * accepted it" — the handset may have been off, the number may have been
 * dead, the network may have refused it — and the log carried 12,084 rows
 * without a single `delivered` among them because nothing ever wrote one.
 *
 * Matched on the provider's own message id, which is why sms.service.js now
 * keeps it. A receipt for a message we have no record of is ignored rather
 * than inserted: it is far more likely to be a replay or another system's
 * traffic on a shared sender id than something worth inventing a row for.
 *
 * @param {string} providerMessageId
 * @param {"delivered"|"failed"} status
 * @param {string} providerStatus  the provider's own word, kept verbatim
 * @param {string} [error]         the carrier's reason, when it failed
 */
const recordReceipt = async (providerMessageId, status, providerStatus, error = "") => {
  const id = String(providerMessageId || "").trim();
  if (!id) return null;

  return safe("recordReceipt", async () => {
    const [row] = await db
      .update(notificationDeliveries)
      .set({
        status,
        providerStatus: String(providerStatus || "").slice(0, 64),
        error: error ? String(error).slice(0, 2000) : null,
        deliveredAt: status === "delivered" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notificationDeliveries.providerMessageId, id),
          // A receipt must never resurrect a send we already know was refused,
          // and Termii can deliver receipts out of order. Only a row we
          // believe went out is open to being updated by one.
          inArray(notificationDeliveries.status, ["pending", "sent"])
        )
      )
      .returning();
    return row || null;
  });
};

/** Support view: every channel attempt behind one inbox row. */
const findForNotification = async (notificationId) => {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.notificationId, Number(notificationId)))
    .orderBy(desc(notificationDeliveries.createdAt));
};

/**
 * Admin log screen, newest first.
 *
 * Raw SQL rather than the query builder, for two things the builder cannot do
 * in one pass:
 *
 *   1. THE NAME. `recipient_name` is written at send time (migration 0016) and
 *      is the truthful answer — who we addressed, as they were called then.
 *      But every row logged BEFORE that column existed has it empty, and those
 *      are most of the log. So an empty name falls back to whoever holds the
 *      number now, looked up across customers, their alternate numbers, and
 *      contacts. A log that shows a bare number for half its rows is a log
 *      nobody can answer a support call from.
 *
 *   2. THE REASON. Classified in SQL (utils/deliveryReason.js#REASON_SQL) so
 *      the log can be FILTERED by it — "show me every send that died on an
 *      empty wallet" — which a JS mapping applied after paging cannot do,
 *      because the page has already been chosen by then.
 *
 * `from`/`to` and `search` were added because the log was 12,000 rows deep
 * behind two dropdowns and a fixed limit of 50 — enough to see that SMS was
 * failing, not enough to answer "did this customer get Tuesday's price list?".
 * `campaignId` narrows it to one broadcast.
 */

/**
 * The last ten digits of a destination, matching the generated
 * `phone_normalized` on customers, customer_phones and contacts.
 *
 * Only meaningful for SMS. An email destination normalises to whatever digits
 * happen to be in the address, so the join below is gated on the channel
 * rather than trusting this not to collide.
 */
const DEST_KEY = sql`RIGHT(regexp_replace(nd.destination, '[^0-9]', '', 'g'), 10)`;

/**
 * Who this number belongs to now, when the row did not record a name.
 *
 * Customers first (they are the record with the history behind them), then
 * their alternate numbers, then contacts — the same precedence the merged
 * people list uses, so the log and the book never name the same number
 * differently.
 */
const NAME_FALLBACK = sql`
  COALESCE(
    NULLIF(nd.recipient_name, ''),
    (SELECT c.name FROM customers c WHERE c.phone_normalized = ${DEST_KEY} LIMIT 1),
    (SELECT c2.name FROM customer_phones cp
       JOIN customers c2 ON c2.id = cp.customer_id
      WHERE cp.phone_normalized = ${DEST_KEY} LIMIT 1),
    (SELECT ct.name FROM contacts ct WHERE ct.phone_normalized = ${DEST_KEY} LIMIT 1),
    ''
  )
`;

/** The shared WHERE, so the list and the summary can never disagree. */
const logFilters = ({ channel, status, type, campaignId, reason, from, to, search }) => {
  const where = [];
  if (channel && channel !== "all") where.push(sql`nd.channel = ${channel}`);
  if (status && status !== "all") where.push(sql`nd.status = ${status}`);
  if (type) where.push(sql`nd.type = ${type}`);
  if (campaignId) where.push(sql`nd.campaign_id = ${Number(campaignId)}`);
  if (reason && reason !== "all") where.push(sql`${sql.raw(REASON_SQL)} = ${reason}`);
  // .toISOString(), not the Date itself: this is a raw sql`` fragment against
  // a bare column name, so there is no column type behind the parameter and
  // the driver rejects a Date outright — "The 'string' argument must be of
  // type string ... Received an instance of Date". Same fault that made every
  // dated /api/commissions request a 500.
  if (from) where.push(sql`nd.created_at >= ${dayEdge(from, "start").toISOString()}`);
  // `to` is a day, and a day includes the whole of it. Comparing against
  // midnight would silently exclude everything sent on the end date, which is
  // the day someone picking a range is most often asking about.
  if (to) {
    where.push(sql`nd.created_at <= ${dayEdge(to, "end").toISOString()}`);
  }
  if (search) {
    // Name or destination — "who did this go to?" is asked both ways, by the
    // person's name and by the number support was given over the phone. The
    // resolved name is searched, not the stored one, or a row whose name only
    // exists via the fallback could be seen but never found.
    const pattern = `%${String(search).trim()}%`;
    where.push(sql`(${NAME_FALLBACK} ILIKE ${pattern} OR nd.destination ILIKE ${pattern})`);
  }
  return where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
};

/**
 * The columns the log may be ordered by, and the SQL for each.
 *
 * A whitelist rather than an interpolated column name: `sort` arrives from a
 * query string, and the one thing that must never reach ORDER BY is something
 * a caller chose the text of.
 *
 * Every entry ends with a `created_at` tiebreak. Without it a page boundary
 * inside a run of equal values — and status has six values across thousands of
 * rows — reorders between requests, so paging forward can show a row twice and
 * skip another entirely.
 */
const SORTABLE = {
  created: sql`nd.created_at`,
  sent: sql`nd.sent_at`,
  delivered: sql`nd.delivered_at`,
  status: sql`nd.status`,
  channel: sql`nd.channel`,
  recipient: sql`LOWER(COALESCE(nd.recipient_name, nd.destination))`,
  campaign: sql`LOWER(COALESCE(mc.title, ''))`,
};

const orderClause = (sort, dir) => {
  const column = SORTABLE[sort] || SORTABLE.created;
  const direction = String(dir).toLowerCase() === "asc" ? sql`ASC` : sql`DESC`;
  // NULLS LAST both ways: an undelivered row sorting above a delivered one on
  // "delivered, newest first" would put the rows with no answer at the top of
  // the column you sorted to see the answers in.
  return sql`ORDER BY ${column} ${direction} NULLS LAST, nd.created_at DESC`;
};

const findAll = async ({
  channel,
  status,
  type,
  campaignId,
  reason,
  from,
  to,
  search,
  sort,
  dir,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum - 1) * limitNum;

  const whereSql = logFilters({ channel, status, type, campaignId, reason, from, to, search });

  const [rowsResult, totalResult] = await Promise.all([
    db.execute(sql`
      SELECT
        nd.id,
        nd.campaign_id            AS "campaignId",
        nd.customer_id            AS "customerId",
        nd.staff_id               AS "staffId",
        ${NAME_FALLBACK}          AS "recipientName",
        -- Whether the name above came off the row or was resolved just now.
        -- The log is an audit trail: a name looked up today is a fair guess at
        -- who holds the number, not a record of who was addressed, and saying
        -- which is which costs one boolean.
        (NULLIF(nd.recipient_name, '') IS NULL) AS "nameResolvedNow",
        nd.type,
        nd.channel,
        nd.destination,
        nd.status,
        nd.attempts,
        nd.error,
        nd.provider_status        AS "providerStatus",
        nd.provider_message_id    AS "providerMessageId",
        ${sql.raw(REASON_SQL)}    AS "reasonCode",
        nd.sent_at                AS "sentAt",
        nd.delivered_at           AS "deliveredAt",
        nd.created_at             AS "createdAt",
        mc.title                  AS "campaignTitle"
      FROM notification_deliveries nd
      LEFT JOIN message_campaigns mc ON mc.id = nd.campaign_id
      ${whereSql}
      ${orderClause(sort, dir)}
      LIMIT ${limitNum} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS total FROM notification_deliveries nd ${whereSql}
    `),
  ]);

  const rows = (rowsResult.rows ?? rowsResult).map((row) => {
    const meta = REASON_CATALOG[row.reasonCode] || REASON_CATALOG.other;
    return { ...row, reasonLabel: meta.label, reasonTone: meta.tone };
  });
  const total = Number((totalResult.rows ?? totalResult)[0]?.total || 0);

  return {
    rows,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum) || 1,
    },
  };
};

/**
 * The log rolled up — per day, or per broadcast.
 *
 * The delivery log answers "did THIS person get it?". This answers the other
 * question the desk actually has, which the per-row log cannot: "what happened
 * on Tuesday, how many of them failed, why, and what did it cost?". 12,000
 * rows behind a paginator will never add up to that on their own.
 *
 * ── On the money ───────────────────────────────────────────────────────────
 *
 * `spent` is Termii's own wallet movement — read before and after each
 * broadcast (migration 0016) — and it is attributed to the campaign, so a day
 * bucket sums the campaigns that ran in it. It is deliberately NOT derived
 * from a per-message rate: Termii bills per segment, per route, and route
 * pricing differs, so a computed figure would diverge from the invoice and be
 * believed anyway.
 *
 * The consequence is worth stating plainly, because it is visible in the UI:
 * transactional SMS (order confirmations, OTPs, ticket messages) belong to no
 * campaign, so a day's `spent` covers its BROADCASTS only. `smsAttempts` next
 * to it is every SMS in the bucket, so the gap between the two is legible
 * rather than silent, and `unpricedSms` names it outright.
 */
const summarise = async ({
  groupBy = "day",
  channel,
  status,
  type,
  campaignId,
  reason,
  from,
  to,
  search,
  limit = 60,
} = {}) => {
  const limitNum = Math.min(365, Math.max(1, parseInt(limit) || 60));
  const whereSql = logFilters({ channel, status, type, campaignId, reason, from, to, search });

  // The bucket key, and what it is called. Campaign grouping keeps a row for
  // the campaign-less sends rather than dropping them: a day where every
  // transactional SMS failed is exactly the day someone needs to see.
  const isDay = groupBy !== "campaign";
  const bucket = isDay
    ? sql`date_trunc('day', nd.created_at)`
    : sql`nd.campaign_id`;

  const result = await db.execute(sql`
    WITH classified AS (
      SELECT
        ${bucket}              AS bucket,
        nd.campaign_id         AS campaign_id,
        nd.channel             AS channel,
        nd.status              AS status,
        ${sql.raw(REASON_SQL)} AS reason
      FROM notification_deliveries nd
      ${whereSql}
    ),
    counted AS (
      SELECT
        bucket,
        COUNT(*)::int                                            AS total,
        COUNT(*) FILTER (WHERE status = 'delivered')::int        AS delivered,
        COUNT(*) FILTER (WHERE status = 'sent')::int             AS sent,
        COUNT(*) FILTER (WHERE status = 'failed')::int           AS failed,
        COUNT(*) FILTER (WHERE status = 'pending')::int          AS pending,
        COUNT(*) FILTER (WHERE status IN ('skipped','suppressed'))::int AS skipped,
        COUNT(*) FILTER (WHERE channel = 'sms')::int             AS "smsAttempts",
        COUNT(*) FILTER (WHERE channel = 'email')::int           AS "emailAttempts",
        -- SMS that no campaign paid for, so the cost figure beside it can say
        -- what it does not cover.
        COUNT(*) FILTER (WHERE channel = 'sms' AND campaign_id IS NULL)::int AS "unpricedSms",
        COUNT(DISTINCT campaign_id)::int                         AS campaigns
      FROM classified
      GROUP BY bucket
    ),
    reasons AS (
      SELECT bucket, reason, COUNT(*)::int AS count
      FROM classified
      -- Only the outcomes worth explaining. A delivered message needs no
      -- reason line, and listing it would bury the four that do.
      WHERE reason NOT IN ('delivered', 'awaiting_receipt', 'pending')
      GROUP BY bucket, reason
    ),
    -- What Termii's wallet actually moved by, per bucket. Joined on the
    -- campaigns that fall in it rather than summed inside classified,
    -- because a campaign has ONE cost and thousands of delivery rows —
    -- aggregating it alongside them would multiply it by the recipient count.
    money AS (
      SELECT
        ${isDay ? sql`date_trunc('day', mc.created_at)` : sql`mc.id`} AS bucket,
        SUM(mc.balance_before - mc.balance_after)                     AS spent,
        MAX(mc.balance_currency)                                      AS currency,
        SUM(mc.recipient_count * GREATEST(mc.sms_segments, 1))::int   AS units
      FROM message_campaigns mc
      WHERE mc.balance_before IS NOT NULL AND mc.balance_after IS NOT NULL
        -- Only campaigns actually represented in the filtered set. Without
        -- this, narrowing the log to email would still price the day's SMS
        -- blasts into it — a cost figure describing rows the reader is not
        -- looking at, which is worse than no figure at all.
        AND mc.id IN (SELECT DISTINCT campaign_id FROM classified WHERE campaign_id IS NOT NULL)
      GROUP BY 1
    )
    SELECT
      c.*,
      m.spent,
      COALESCE(m.currency, '') AS currency,
      m.units,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.count) ORDER BY r.count DESC)
         FROM reasons r WHERE r.bucket IS NOT DISTINCT FROM c.bucket),
        '[]'::jsonb
      ) AS reasons,
      ${isDay ? sql`NULL::text` : sql`(SELECT mc2.title FROM message_campaigns mc2 WHERE mc2.id = c.bucket)`} AS "campaignTitle",
      ${isDay ? sql`NULL::timestamptz` : sql`(SELECT mc2.created_at FROM message_campaigns mc2 WHERE mc2.id = c.bucket)`} AS "campaignAt"
    FROM counted c
    LEFT JOIN money m ON m.bucket IS NOT DISTINCT FROM c.bucket
    ORDER BY ${isDay ? sql`c.bucket DESC` : sql`c.bucket DESC NULLS LAST`}
    LIMIT ${limitNum}
  `);

  return (result.rows ?? result).map((row) => ({
    key: row.bucket === null ? null : String(row.bucket),
    // A day bucket is a date; a campaign bucket is an id with a title and a
    // send time of its own. The client renders one list either way.
    label: isDay ? null : row.campaignTitle || (row.bucket === null ? "Not part of a broadcast" : "Untitled message"),
    at: isDay ? row.bucket : row.campaignAt,
    total: Number(row.total || 0),
    delivered: Number(row.delivered || 0),
    sent: Number(row.sent || 0),
    failed: Number(row.failed || 0),
    pending: Number(row.pending || 0),
    skipped: Number(row.skipped || 0),
    smsAttempts: Number(row.smsAttempts || 0),
    emailAttempts: Number(row.emailAttempts || 0),
    unpricedSms: Number(row.unpricedSms || 0),
    campaigns: Number(row.campaigns || 0),
    // Null, never 0, when no reading exists — "we could not read the wallet"
    // and "this cost nothing" are different facts and showing the second for
    // the first would be a lie about money.
    spent: row.spent === null || row.spent === undefined ? null : Math.round(Number(row.spent) * 100) / 100,
    currency: row.currency || "",
    units: row.units === null || row.units === undefined ? null : Number(row.units),
    reasons: (row.reasons || []).map((r) => ({
      code: r.reason,
      label: (REASON_CATALOG[r.reason] || REASON_CATALOG.other).label,
      tone: (REASON_CATALOG[r.reason] || REASON_CATALOG.other).tone,
      count: Number(r.count),
    })),
  }));
};

/**
 * Channel health over a window — the number that tells an operator Termii has
 * been swallowing messages since lunchtime.
 */
const statsSince = async (since) => {
  const rows = await db
    .select({
      channel: notificationDeliveries.channel,
      status: notificationDeliveries.status,
      total: count(),
    })
    .from(notificationDeliveries)
    .where(gte(notificationDeliveries.createdAt, since))
    .groupBy(notificationDeliveries.channel, notificationDeliveries.status);

  const byChannel = {};
  for (const row of rows) {
    byChannel[row.channel] ||= { sent: 0, failed: 0, skipped: 0, suppressed: 0, pending: 0, delivered: 0 };
    byChannel[row.channel][row.status] = Number(row.total);
  }

  for (const channel of Object.keys(byChannel)) {
    const c = byChannel[channel];
    const attempted = c.sent + c.delivered + c.failed;
    // Only real attempts count: a suppressed send is an opt-out working, not
    // a delivery failure, and folding it in would hide genuine outages.
    c.attempted = attempted;
    c.successRate = attempted > 0 ? Math.round(((c.sent + c.delivered) / attempted) * 1000) / 10 : null;
  }

  return byChannel;
};

const purgeOlderThan = async (cutoff) => {
  const rows = await db
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, cutoff))
    .returning({ id: notificationDeliveries.id });
  return rows.length;
};

module.exports = {
  start,
  markSent,
  markFailed,
  markResolved,
  record,
  recordReceipt,
  findForNotification,
  findAll,
  summarise,
  statsSince,
  purgeOlderThan,
};
