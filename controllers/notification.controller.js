const asyncHandler = require("express-async-handler");
const staffChoices = require("../notifications/staffChoices");
const {
  notificationRepo,
  deviceTokenRepo,
  notificationPreferenceRepo,
} = require("../repositories");
const catalog = require("../notifications/catalog");
const sse = require("../notifications/sse");
const streamTicket = require("../notifications/streamTicket");
const { notifyAndWait } = require("../notifications");
const { verifyAccessToken } = require("../services/token.service");
const sessionService = require("../services/session.service");

/**
 * The notification API, shared by both realms.
 *
 * Staff and customers get byte-identical endpoints because they want the same
 * things — an inbox, a badge, preferences, a registered device. The only
 * difference is which principal the request authenticates as, and that is one
 * line (`principalFrom`) rather than a duplicated controller. The routes mount
 * this behind the appropriate realm's middleware; nothing here trusts a
 * client-supplied id.
 */

/**
 * The acting principal, from whichever realm middleware ran.
 * verifyCustomer sets req.customer; verifyStaff sets req.user. Exactly one is
 * ever populated, so there is no ambiguity to resolve.
 */
const principalFrom = (req) => {
  if (req.customer?.id) return { type: "customer", id: req.customer.id };
  if (req.user?.id) return { type: "staff", id: req.user.id };
  return null;
};

const audienceFrom = (principal) => (principal.type === "staff" ? "staff" : "customer");

/** Types this staff member has had switched off — hidden from their inbox. Nothing for a customer. */
const hiddenTypesFor = (principal) =>
  principal?.type === "staff" ? staffChoices.mutedTypesFor(principal.id) : Promise.resolve([]);

/** The client-facing shape. Internal arc columns are never exposed. */
const toPublic = (row) => ({
  id: row.id,
  type: row.type,
  category: row.category,
  priority: row.priority,
  title: row.title,
  body: row.body,
  data: row.data || {},
  entityType: row.entityType || null,
  entityId: row.entityId || null,
  actionUrl: row.actionUrl || null,
  imageUrl: row.imageUrl || null,
  read: Boolean(row.readAt),
  readAt: row.readAt,
  archived: Boolean(row.archivedAt),
  createdAt: row.createdAt,
});

// ─── Inbox ──────────────────────────────────────────────────────────────────

/** GET /notifications — the inbox, newest first. */
const list = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const { page, limit, category, type, unreadOnly, includeArchived } = req.query;
  const excludeTypes = await hiddenTypesFor(principal);

  const [{ rows, pagination }, unread] = await Promise.all([
    notificationRepo.findForPrincipal(principal, {
      page,
      limit,
      category,
      type,
      unreadOnly,
      includeArchived,
      excludeTypes,
    }),
    notificationRepo.unreadCount(principal, { excludeTypes }),
  ]);

  res.json({
    success: true,
    data: {
      // `data` array + `pagination`, matching the shape the wallet and order
      // list endpoints already return, so clients reuse their list plumbing.
      data: rows.map(toPublic),
      pagination,
      unreadCount: unread,
    },
  });
});

/** GET /notifications/unread-count — the badge. Cheap enough to poll. */
const unreadCount = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const excludeTypes = await hiddenTypesFor(principal);
  const [total, byCategory] = await Promise.all([
    notificationRepo.unreadCount(principal, { excludeTypes }),
    notificationRepo.unreadCountsByCategory(principal, { excludeTypes }),
  ]);
  res.json({ success: true, data: { unreadCount: total, byCategory } });
});

const getOne = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const row = await notificationRepo.findByIdForPrincipal(req.params.id, principal);
  if (!row) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  res.json({ success: true, data: toPublic(row) });
});

/**
 * PATCH /notifications/:id/read
 *
 * The SSE publish afterwards is what keeps a phone and an open dashboard in
 * agreement: reading on one clears the badge on the other without a refresh.
 */
const markRead = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const row = await notificationRepo.markRead(req.params.id, principal);
  if (!row) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  const unread = await notificationRepo.unreadCount(principal);
  sse.publishRead(principal, { ids: [row.id], unreadCount: unread });
  res.json({ success: true, data: { notification: toPublic(row), unreadCount: unread } });
});

const markUnread = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const row = await notificationRepo.markUnread(req.params.id, principal);
  if (!row) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  const unread = await notificationRepo.unreadCount(principal);
  sse.publishUnreadCount(principal, unread);
  res.json({ success: true, data: { notification: toPublic(row), unreadCount: unread } });
});

/** POST /notifications/read-all — optionally narrowed to a category or ids. */
const markAllRead = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const { category, ids } = req.body;
  const updated = await notificationRepo.markAllRead(principal, { category, ids });
  const unread = await notificationRepo.unreadCount(principal);
  sse.publishRead(principal, { ids: ids || [], unreadCount: unread });
  res.json({ success: true, message: `${updated} notification(s) marked read`, data: { updated, unreadCount: unread } });
});

const archive = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const row = await notificationRepo.archive(req.params.id, principal);
  if (!row) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  const unread = await notificationRepo.unreadCount(principal);
  sse.publishUnreadCount(principal, unread);
  res.json({ success: true, data: { notification: toPublic(row), unreadCount: unread } });
});

const archiveAll = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const updated = await notificationRepo.archiveAll(principal, { category: req.body?.category });
  const unread = await notificationRepo.unreadCount(principal);
  sse.publishUnreadCount(principal, unread);
  res.json({ success: true, message: `${updated} notification(s) archived`, data: { updated, unreadCount: unread } });
});

const remove = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const deleted = await notificationRepo.remove(req.params.id, principal);
  if (!deleted) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  const unread = await notificationRepo.unreadCount(principal);
  sse.publishUnreadCount(principal, unread);
  res.json({ success: true, message: "Notification deleted", data: { unreadCount: unread } });
});

// ─── Preferences ────────────────────────────────────────────────────────────

/**
 * GET /notifications/preferences
 *
 * Returns the EFFECTIVE state: catalog defaults with the principal's stored
 * deviations applied. The settings screen can render straight from this
 * without knowing that unstored categories fall back to defaults.
 */
const getPreferences = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const audience = audienceFrom(principal);

  const [stored, settings] = await Promise.all([
    notificationPreferenceRepo.findAllAsMap(principal),
    notificationPreferenceRepo.getSettings(principal),
  ]);

  const defaults = catalog.defaultPreferencesFor(audience);
  const preferences = Object.entries(defaults).map(([category, available]) => {
    const row = stored[category];
    return {
      category,
      // `available` says which channels this category can ever use, so the UI
      // greys out a toggle rather than offering an SMS that no type sends.
      available,
      inApp: row ? row.inApp : available.inApp,
      push: row ? row.push : available.push,
      email: row ? row.email : available.email,
      sms: row ? row.sms : available.sms,
    };
  });

  res.json({
    success: true,
    data: {
      preferences,
      settings: {
        pushEnabled: settings?.pushEnabled ?? true,
        emailEnabled: settings?.emailEnabled ?? true,
        smsEnabled: settings?.smsEnabled ?? true,
        quietHoursEnabled: settings?.quietHoursEnabled ?? false,
        quietHoursStart: settings?.quietHoursStart ?? 1320,
        quietHoursEnd: settings?.quietHoursEnd ?? 420,
        timezone: settings?.timezone || process.env.NOTIFY_DEFAULT_TZ || "Africa/Lagos",
        locale: settings?.locale || "",
      },
      // Named so the UI can explain why security notices have no toggle.
      alwaysOn: ["security"],
    },
  });
});

/** PATCH /notifications/preferences — partial; unnamed fields are untouched. */
const updatePreferences = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const { preferences, ...settings } = req.body;

  if (Array.isArray(preferences) && preferences.length > 0) {
    await notificationPreferenceRepo.upsertMany(principal, preferences);
  }
  if (Object.keys(settings).length > 0) {
    await notificationPreferenceRepo.upsertSettings(principal, settings);
  }

  // Re-read so the client gets the effective state, not an echo of its patch.
  return getPreferences(req, res);
});

/** POST /notifications/preferences/reset — back to catalog defaults. */
const resetPreferences = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  await notificationPreferenceRepo.reset(principal, { category: req.body?.category });
  return getPreferences(req, res);
});

// ─── Devices ────────────────────────────────────────────────────────────────

/**
 * POST /notifications/devices — register this device for push.
 *
 * Called after sign-in and again whenever FCM rotates the token. Idempotent:
 * re-posting the same token refreshes it rather than creating a duplicate.
 */
const registerDevice = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const row = await deviceTokenRepo.register(principal, req.body);
  res.status(201).json({
    success: true,
    message: "Device registered for push notifications",
    data: { id: row.id, platform: row.platform, deviceId: row.deviceId },
  });
});

const listDevices = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const rows = await deviceTokenRepo.listForPrincipal(principal);
  res.json({ success: true, data: rows });
});

/** DELETE /notifications/devices — call on sign-out, before the token is dropped. */
const unregisterDevice = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const removed = await deviceTokenRepo.unregister(principal, req.body.token);
  if (!removed) {
    return res.status(404).json({ success: false, message: "Device token not found" });
  }
  res.json({ success: true, message: "Device unregistered" });
});

// ─── Live stream ────────────────────────────────────────────────────────────

/**
 * POST /notifications/stream-ticket
 *
 * Mints the short-lived, single-use credential the browser spends on the
 * stream below — see notifications/streamTicket.js for why the access token
 * itself must not travel in the URL.
 */
const issueStreamTicket = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const { ticket, expiresIn } = streamTicket.issue(principal);
  res.json({ success: true, data: { ticket, expiresIn } });
});

/**
 * Authenticate a stream request by ticket OR by Bearer token.
 *
 * Two paths because two clients: a browser's EventSource cannot set headers
 * and must use a ticket, while a native client can send the Authorization
 * header it already holds and should not need a second round trip.
 *
 * This is deliberately a handler-level check rather than route middleware —
 * the realm is not known until the token is decoded, and an SSE endpoint must
 * fail with a plain JSON 401 before any event-stream headers are written.
 */
const authenticateStream = async (req, realm) => {
  const ticketed = streamTicket.redeem(req.query.ticket);
  if (ticketed) return ticketed;

  const header = req.headers.authorization || req.headers.Authorization;
  if (!header?.startsWith("Bearer ")) return null;

  try {
    const claims = verifyAccessToken(realm, header.split(" ")[1]);
    const active = await sessionService.loadActive(realm, claims.sid, claims.id);
    if (!active.ok) return null;
    return { type: realm, id: active.principal.id };
  } catch {
    return null;
  }
};

/**
 * GET /notifications/stream — the live SSE feed.
 *
 * `realm` is bound by the route, so a customer ticket can never open a staff
 * stream and vice versa.
 */
const stream = (realm) =>
  asyncHandler(async (req, res) => {
    const principal = await authenticateStream(req, realm);
    if (!principal) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const unsubscribe = sse.subscribe(principal, res);

    // Send the badge immediately so a reconnecting client is correct at once
    // rather than after the next notification happens to arrive.
    try {
      const unread = await notificationRepo.unreadCount(principal);
      sse.publishUnreadCount(principal, unread);
    } catch {
      /* the stream is still useful without an opening count */
    }

    // The only thing that ends an SSE response is the client going away.
    req.on("close", unsubscribe);
    req.on("error", unsubscribe);
  });

// ─── Self-service diagnostics ───────────────────────────────────────────────

/**
 * POST /notifications/test — "is push actually working on this handset?"
 *
 * Forced past preferences and quiet hours: someone pressing a test button has
 * asked for it explicitly, and a test that silently respects a mute would look
 * exactly like a broken pipeline.
 */
const sendTest = asyncHandler(async (req, res) => {
  const principal = principalFrom(req);
  const result = await notifyAndWait("system.announcement", {
    to: principal.type === "staff" ? { staffId: principal.id } : { customerId: principal.id },
    data: {
      title: req.body?.title || "Test notification",
      body: req.body?.body || "If you can see this, notifications are working correctly.",
    },
    channels: req.body?.channels,
    force: true,
  });

  res.json({
    success: true,
    message: "Test notification sent",
    data: { channels: result.results?.[0]?.channels || {} },
  });
});

/** GET /notifications/catalog — the types and categories, for building UI. */
const getCatalog = asyncHandler(async (req, res) => {
  const audience = audienceFrom(principalFrom(req));
  res.json({
    success: true,
    data: {
      categories: catalog.categoriesFor(audience),
      defaults: catalog.defaultPreferencesFor(audience),
    },
  });
});

module.exports = {
  principalFrom,
  toPublic,
  list,
  unreadCount,
  getOne,
  markRead,
  markUnread,
  markAllRead,
  archive,
  archiveAll,
  remove,
  getPreferences,
  updatePreferences,
  resetPreferences,
  registerDevice,
  listDevices,
  unregisterDevice,
  issueStreamTicket,
  stream,
  sendTest,
  getCatalog,
};
