const { client } = require("../config/db");
const { notify } = require("../notifications");

/**
 * Messages between members of staff — one person to another, nothing else.
 *
 * Privacy is the rule everything here keeps: a message's text is returned only
 * to its sender and its recipient. There is no endpoint, admin or otherwise,
 * that reads another person's conversation. What admins get (`activity`) is
 * who wrote to whom, how often and when — never a word of it. The alert that
 * goes out (catalog `staff.direct_message`) names the sender and nothing more,
 * because texts and emails land in the message ledger other people can read.
 *
 * Messages are never edited or deleted, and they outlive the accounts: names
 * are kept on the row (migration 0076).
 */

const MAX_BODY = 4000;
const PREVIEW = 120;

const fail = (status, message) => Object.assign(new Error(message), { status });

const nameOf = (row) =>
  [row.first_name, row.surname].map((v) => String(v || "").trim()).filter(Boolean).join(" ") || `Staff #${row.id}`;

const preview = (body) => {
  const s = String(body || "").replace(/\s+/g, " ").trim();
  return s.length <= PREVIEW ? s : `${s.slice(0, PREVIEW - 1)}…`;
};

const asId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** One account, for a conversation's header and for sending to. */
const findPerson = async (id) => {
  const [row] = await client`
    SELECT id, first_name, surname, roles, profile_picture_url, is_active, suspended
      FROM staff WHERE id = ${id}
  `;
  return row || null;
};

const personOut = (row) => ({
  id: Number(row.id),
  name: nameOf(row),
  roles: row.roles || [],
  profilePictureUrl: row.profile_picture_url || null,
  active: Boolean(row.is_active) && !row.suspended,
});

/**
 * Everybody they can write to, with their conversation so far: the latest
 * message and how many from that person they have not read. People they have
 * talked to come first, most recent first; then everybody else by name.
 * Accounts that are suspended or switched off are listed only when there is a
 * conversation to look back on.
 */
const people = async (meId) => {
  const me = asId(meId);
  const rows = await client`
    WITH mine AS (
      SELECT CASE WHEN sender_id = ${me} THEN recipient_id ELSE sender_id END AS other_id,
             id, body, created_at, sender_id
        FROM staff_messages
       WHERE sender_id = ${me} OR recipient_id = ${me}
    ),
    last AS (
      SELECT DISTINCT ON (other_id) other_id, id, body, created_at, sender_id
        FROM mine
       WHERE other_id IS NOT NULL
       ORDER BY other_id, id DESC
    ),
    unread AS (
      SELECT sender_id AS other_id, COUNT(*)::int AS n
        FROM staff_messages
       WHERE recipient_id = ${me} AND read_at IS NULL AND sender_id IS NOT NULL
       GROUP BY sender_id
    )
    SELECT s.id, s.first_name, s.surname, s.roles, s.profile_picture_url, s.is_active, s.suspended,
           l.body AS last_body, l.created_at AS last_at, (l.sender_id = ${me}) AS last_from_me,
           COALESCE(u.n, 0) AS unread
      FROM staff s
      LEFT JOIN last l ON l.other_id = s.id
      LEFT JOIN unread u ON u.other_id = s.id
     WHERE s.id <> ${me}
       AND ((s.is_active AND NOT s.suspended) OR l.id IS NOT NULL)
     ORDER BY l.created_at DESC NULLS LAST, s.first_name, s.surname
  `;
  return rows.map((r) => ({
    ...personOut(r),
    lastMessage: r.last_at
      ? { preview: preview(r.last_body), at: r.last_at, fromMe: Boolean(r.last_from_me) }
      : null,
    unread: Number(r.unread) || 0,
  }));
};

/** How many messages they have not read, from everybody. */
const unreadCount = async (meId) => {
  const [row] = await client`
    SELECT COUNT(*)::int AS n FROM staff_messages
     WHERE recipient_id = ${asId(meId)} AND read_at IS NULL
  `;
  return Number(row?.n) || 0;
};

const messageOut = (me) => (r) => ({
  id: Number(r.id),
  fromMe: Number(r.sender_id) === me,
  body: r.body,
  createdAt: r.created_at,
  readAt: r.read_at,
});

/**
 * The conversation between them and one other person, newest page last, and
 * everything that person sent them marked read — opening it is reading it.
 * `before` pages back: the id of the oldest message already shown.
 */
const thread = async (meId, otherId, { before = null, limit = 50 } = {}) => {
  const me = asId(meId);
  const other = asId(otherId);
  if (!other || other === me) throw fail(400, "Choose someone to message");
  const person = await findPerson(other);
  if (!person) throw fail(404, "That account no longer exists");

  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const beforeId = asId(before);
  const rows = await client`
    SELECT id, sender_id, recipient_id, body, created_at, read_at
      FROM staff_messages
     WHERE LEAST(sender_id, recipient_id) = ${Math.min(me, other)}
       AND GREATEST(sender_id, recipient_id) = ${Math.max(me, other)}
       ${beforeId ? client`AND id < ${beforeId}` : client``}
     ORDER BY id DESC
     LIMIT ${take + 1}
  `;
  const hasMore = rows.length > take;
  const page = rows.slice(0, take).reverse();

  const marked = await client`
    UPDATE staff_messages SET read_at = now()
     WHERE recipient_id = ${me} AND sender_id = ${other} AND read_at IS NULL
     RETURNING id, read_at
  `;
  const readAt = new Map(marked.map((m) => [Number(m.id), m.read_at]));

  return {
    person: personOut(person),
    messages: page.map((r) => ({ ...messageOut(me)(r), readAt: r.read_at || readAt.get(Number(r.id)) || null })),
    hasMore,
  };
};

/**
 * Send one message. The recipient gets a text (and the bell) only when
 * nothing earlier from this sender is still waiting unread with a text already
 * sent for it — one alert per conversation until they read it.
 */
const send = async (meId, otherId, rawBody) => {
  const me = asId(meId);
  const other = asId(otherId);
  const body = String(rawBody ?? "").trim();
  if (!other || other === me) throw fail(400, "Choose someone to message");
  if (!body) throw fail(400, "Write a message first");
  if (body.length > MAX_BODY) throw fail(400, `A message can be at most ${MAX_BODY} characters`);

  const [sender, recipient] = await Promise.all([findPerson(me), findPerson(other)]);
  if (!sender) throw fail(401, "Your account could not be found");
  if (!recipient) throw fail(404, "That account no longer exists");
  if (!recipient.is_active || recipient.suspended) {
    throw fail(400, `${nameOf(recipient)}'s account is switched off, so they cannot read messages`);
  }

  const [row] = await client`
    INSERT INTO staff_messages (sender_id, recipient_id, sender_name, recipient_name, body)
    VALUES (${me}, ${other}, ${nameOf(sender)}, ${nameOf(recipient)}, ${body})
    RETURNING id, sender_id, recipient_id, body, created_at, read_at
  `;

  const [alert] = await client`
    UPDATE staff_messages SET alerted_at = now()
     WHERE id = ${row.id}
       AND NOT EXISTS (
         SELECT 1 FROM staff_messages
          WHERE sender_id = ${me} AND recipient_id = ${other}
            AND read_at IS NULL AND alerted_at IS NOT NULL AND id <> ${row.id}
       )
     RETURNING id
  `;
  if (alert) {
    await notify("staff.direct_message", {
      to: { staffId: other },
      data: {
        messageId: Number(row.id),
        senderId: me,
        senderName: nameOf(sender),
        firstName: String(recipient.first_name || "").trim(),
      },
    }).catch((err) => console.error("[staff-messages] alert failed:", err.message));
  }

  return { message: messageOut(me)(row), alerted: Boolean(alert) };
};

/**
 * Who has written to whom, how many times and when — for admins. No message
 * text, and no preview of it, ever leaves this function.
 *
 * `from` / `to` are Lagos dates (YYYY-MM-DD), both inclusive.
 */
const activity = async ({ from = null, to = null } = {}) => {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const fromDay = day(from);
  const toDay = day(to);
  const rows = await client`
    SELECT m.sender_id, m.recipient_id,
           COALESCE(NULLIF(TRIM(CONCAT(s.first_name, ' ', s.surname)), ''), MAX(m.sender_name)) AS sender_name,
           COALESCE(NULLIF(TRIM(CONCAT(r.first_name, ' ', r.surname)), ''), MAX(m.recipient_name)) AS recipient_name,
           COUNT(*)::int AS messages,
           COUNT(*) FILTER (WHERE m.read_at IS NULL)::int AS unread,
           COUNT(*) FILTER (WHERE m.alerted_at IS NOT NULL)::int AS texts,
           MIN(m.created_at) AS first_at,
           MAX(m.created_at) AS last_at
      FROM staff_messages m
      LEFT JOIN staff s ON s.id = m.sender_id
      LEFT JOIN staff r ON r.id = m.recipient_id
     WHERE TRUE
       ${fromDay ? client`AND m.created_at >= ${fromDay}::date` : client``}
       ${toDay ? client`AND m.created_at < ${toDay}::date + 1` : client``}
     GROUP BY m.sender_id, m.recipient_id, s.first_name, s.surname, r.first_name, r.surname
     ORDER BY MAX(m.created_at) DESC
  `;
  const pairs = rows.map((r) => ({
    senderId: r.sender_id == null ? null : Number(r.sender_id),
    senderName: r.sender_name || "Deleted account",
    recipientId: r.recipient_id == null ? null : Number(r.recipient_id),
    recipientName: r.recipient_name || "Deleted account",
    messages: Number(r.messages) || 0,
    unread: Number(r.unread) || 0,
    texts: Number(r.texts) || 0,
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
  return {
    from: fromDay,
    to: toDay,
    totals: {
      messages: pairs.reduce((s, p) => s + p.messages, 0),
      unread: pairs.reduce((s, p) => s + p.unread, 0),
      texts: pairs.reduce((s, p) => s + p.texts, 0),
      senders: new Set(pairs.map((p) => p.senderId)).size,
    },
    pairs,
  };
};

module.exports = { people, unreadCount, thread, send, activity, MAX_BODY };
