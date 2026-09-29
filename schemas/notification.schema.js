const z = require("zod");
const { pagination, id, enumOf, requiredString, optionalString, numberLike } = require("./fields");

/**
 * Validation for the notification API.
 *
 * The category and channel lists are derived from the database enums rather
 * than retyped, so adding a category is one edit in db/schema/enums.js and not
 * a hunt for the copy that drifted.
 */
const { notificationCategoryEnum, deviceTokenPlatformEnum } = require("../db/schema/enums");

const CATEGORIES = notificationCategoryEnum.enumValues;
const PLATFORMS = deviceTokenPlatformEnum.enumValues;

/** Zod coerces "true"/"false" query strings; JSON bodies send real booleans. */
const booleanish = (label) =>
  z
    .union([z.boolean(), z.enum(["true", "false"])], {
      error: (iss) => (iss.input === undefined ? `${label} is required` : `${label} must be true or false`),
    })
    .transform((v) => v === true || v === "true");

// ─── Inbox ──────────────────────────────────────────────────────────────────

const listNotifications = pagination.extend({
  // `limit` is tightened from the shared default of 500: an inbox page is a
  // scrolling list, and 500 rows of jsonb is a slow response nobody reads.
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .default(20)
    .transform((v) => Math.min(100, Math.max(1, parseInt(v) || 20))),
  category: z.enum([...CATEGORIES, "all"], {
    error: () => `Category must be one of: ${[...CATEGORIES, "all"].join(", ")}`,
  }).optional(),
  type: z.string().trim().max(64, "Type is too long").optional(),
  unreadOnly: booleanish("unreadOnly").optional().default(false),
  includeArchived: booleanish("includeArchived").optional().default(false),
});

const notificationIdParam = z.object({ id: id("Notification id") });

const markAllRead = z.object({
  category: z.enum([...CATEGORIES, "all"]).optional(),
  ids: z.array(id("Notification id")).max(500, "Too many ids in one request").optional(),
});

// ─── Preferences ────────────────────────────────────────────────────────────

const categoryPreference = z.object({
  category: enumOf("Category", CATEGORIES),
  inApp: z.boolean().optional(),
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
});

const updatePreferences = z
  .object({
    preferences: z.array(categoryPreference).max(CATEGORIES.length, "Too many categories").optional(),
    pushEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    smsEnabled: z.boolean().optional(),
    quietHoursEnabled: z.boolean().optional(),
    // Minutes past midnight. 1439 is 23:59 — 1440 would be the next day.
    quietHoursStart: z.number().int().min(0).max(1439, "Quiet hours start must be between 0 and 1439").optional(),
    quietHoursEnd: z.number().int().min(0).max(1439, "Quiet hours end must be between 0 and 1439").optional(),
    timezone: z
      .string()
      .trim()
      .max(64, "Timezone is too long")
      // Validated against the runtime's own tz database rather than a regex:
      // a plausible-looking but unknown zone would otherwise be stored and
      // then silently disable quiet hours at send time.
      .refine((tz) => {
        if (!tz) return true;
        try {
          new Intl.DateTimeFormat("en-GB", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "Timezone must be a valid IANA timezone, e.g. Africa/Lagos")
      .optional(),
    locale: optionalString("Locale", 16).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "No changes supplied");

const resetPreferences = z.object({
  category: enumOf("Category", CATEGORIES).optional(),
});

// ─── Device tokens ──────────────────────────────────────────────────────────

const registerDevice = z.object({
  // FCM tokens run ~163 chars today but the length is not contractual, so the
  // bound is generous rather than exact.
  token: requiredString("Device token", 4096),
  platform: enumOf("Platform", PLATFORMS),
  /**
   * Which service delivers to this token. Both are live: the Expo mobile app
   * mints `ExponentPushToken[…]`, a bare Android/web client mints a raw FCM
   * registration token, and the two are not interchangeable (see
   * notifications/channels/push.js, which routes on the token's shape).
   *
   * "expo" was rejected here until now, so an Expo build declaring its provider
   * honestly got a 400 and never registered at all. Routing has always keyed
   * off the token itself, so this is a label — but a label the delivery log and
   * the devices screen both read, and a wrong one makes a silent
   * non-delivery look like a configuration problem.
   */
  provider: z
    .enum(["fcm", "expo"], { error: () => "Provider must be fcm or expo" })
    .optional()
    .default("fcm"),
  deviceId: optionalString("Device id", 128),
  deviceName: optionalString("Device name", 255),
  appVersion: optionalString("App version", 32),
  locale: optionalString("Locale", 16),
  timezone: optionalString("Timezone", 64),
});

const unregisterDevice = z.object({
  token: requiredString("Device token", 4096),
});

// ─── Admin ──────────────────────────────────────────────────────────────────

const listDeliveries = pagination.extend({
  channel: z.enum(["in_app", "push", "email", "sms", "whatsapp", "all"]).optional(),
  status: z.enum(["pending", "sent", "delivered", "failed", "skipped", "suppressed", "all"]).optional(),
  type: z.string().trim().max(64, "Type is too long").optional(),
  /** Narrow to one broadcast — the campaign detail view's only filter. */
  campaignId: id("Campaign id").optional(),
  // A date, not a timestamp. The repository widens `to` to the end of its day,
  // because a range picked as "the 3rd to the 5th" means all of the 5th.
  from: z.string().trim().max(30).optional(),
  to: z.string().trim().max(30).optional(),
  /** Matched against the recipient's name and the destination alike. */
  search: z.string().trim().max(120, "Search is too long").optional(),
  /**
   * One classified failure reason — "every send that died on an empty wallet".
   *
   * Not an enum: the codes live in utils/deliveryReason.js and a schema copy
   * would be a second list to keep in step. An unknown code is harmless, it
   * simply matches nothing.
   */
  reason: z.string().trim().max(40, "Reason is too long").optional(),
  /** Whitelisted in the repository — anything else falls back to newest first. */
  sort: z.enum(["created", "sent", "delivered", "status", "channel", "recipient", "campaign"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

/**
 * The log rolled up per day or per broadcast.
 *
 * Same filters as the list, deliberately: the summary and the rows beneath it
 * must describe the same set, or the counts stop reconciling the moment
 * somebody narrows the log.
 */
const deliverySummary = listDeliveries.extend({
  groupBy: z.enum(["day", "campaign"]).optional().default("day"),
  limit: numberLike("Limit")
    .pipe(z.number().int().positive().max(365, "Limit cannot exceed 365"))
    .optional(),
});

const listCampaigns = pagination.extend({
  limit: numberLike("Limit")
    .pipe(z.number().int().positive().max(100, "Limit cannot exceed 100"))
    .optional(),
});

const campaignIdParam = z.object({ id: id("Campaign id") });

/**
 * The admin broadcast. Recipients are an explicit, closed union — an operator
 * must say who they mean, and "everyone" has to be typed out rather than
 * arrived at by omitting a filter.
 */
const broadcast = z
  .object({
    title: requiredString("Title", 200),
    body: requiredString("Message", 2000),
    audience: enumOf("Audience", ["staff", "customers", "roles", "specific", "contacts"]),
    roles: z.array(z.string().trim().max(50)).max(30, "Too many roles").optional(),
    customerIds: z.array(id("Customer id")).max(1000, "Too many recipients in one broadcast").optional(),
    staffIds: z.array(id("Staff id")).max(1000, "Too many recipients in one broadcast").optional(),
    // Leads and other non-customers. They have no principal to address, so
    // the recipient is the contact details themselves — a shape the engine
    // already resolves (see notifications/recipients.js, "a contact with no
    // account behind it"). Sent as values rather than ids so the broadcast
    // path does not have to grow a second database lookup, and so a recipient
    // list assembled on the page is exactly what goes out.
    contacts: z
      .array(
        z.object({
          name: optionalString("Name", 255),
          email: optionalString("Email", 255),
          phone: optionalString("Phone", 30),
        })
      )
      .max(1000, "Too many recipients in one broadcast")
      .optional(),
    channels: z
      .array(z.enum(["in_app", "push", "email", "sms"]))
      .min(1, "Choose at least one channel")
      .optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
    actionUrl: z.string().trim().url("Action URL must be a valid URL").max(2000).optional(),
    imageUrl: z.string().trim().url("Image URL must be a valid URL").max(2000).optional(),
    // Which depots a {{prices}} shortcode in the body quotes. Only consulted
    // when the body still holds shortcodes — a composer that already resolved
    // them sends finished text and this is ignored.
    depotIds: z.array(id("Depot id")).max(100, "Too many depots").optional(),
    /**
     * An already-open campaign to file these sends under.
     *
     * "Everyone" is two audiences and the composer sends it as two requests —
     * customers by id, contacts by their details, resolved differently by the
     * engine. Passing the first call's campaign id back on the second is what
     * keeps one press of Send showing up in the log as one broadcast.
     */
    campaignId: id("Campaign id").optional(),
    /**
     * What the audience MEANT, in the words the page used ("Frequent
     * customers — at least 3 orders in the last 90 days").
     *
     * Stored on the campaign because those thresholds are tunable: the preset
     * id alone would leave a six-month-old campaign whose audience cannot be
     * reconstructed.
     */
    audienceLabel: optionalString("Audience label", 255),
    /**
     * Which announcement this is — the category recipients mute it under.
     *
     * "system" is operational news, "marketing" is a promotion. Defaulting to
     * "system" keeps every existing caller (and the composer, until it grows
     * the control) behaving exactly as before; a promo has to be labelled one
     * deliberately, which is the right way round — mislabelling an advert as
     * system news is the failure that makes the opt-out worthless.
     */
    category: z
      .enum(["system", "marketing"], { error: () => "Category must be system or marketing" })
      .optional()
      .default("system"),
  })
  .refine(
    (v) => v.audience !== "roles" || (v.roles?.length ?? 0) > 0,
    { message: "Select at least one role", path: ["roles"] }
  )
  .refine(
    (v) => v.audience !== "specific" || (v.customerIds?.length ?? 0) + (v.staffIds?.length ?? 0) > 0,
    { message: "Select at least one recipient", path: ["customerIds"] }
  )
  .refine(
    (v) => v.audience !== "contacts" || (v.contacts?.length ?? 0) > 0,
    { message: "Select at least one contact", path: ["contacts"] }
  )
  .refine(
    // A contact with neither an email nor a phone cannot be reached on any
    // channel; letting it through would report a recipient that was never
    // addressed.
    (v) => v.audience !== "contacts" || (v.contacts ?? []).every((c) => c.email || c.phone),
    { message: "Every contact needs an email address or a phone number", path: ["contacts"] }
  );

/** The "does push actually work on my handset" button. */
const sendTest = z.object({
  channels: z.array(z.enum(["in_app", "push", "email", "sms"])).min(1).optional(),
  title: optionalString("Title", 200),
  body: optionalString("Message", 2000),
});

/** The message ledger's filters (migration 0064). Days are Lagos calendar days. */
const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-29");
const messageLogQuery = pagination.extend({
  from: day.optional(),
  to: day.optional(),
  channel: z.enum(["sms", "email", "whatsapp", "all"]).optional(),
  audience: z.enum(["customer", "staff", "driver", "station", "contact", "unknown", "all"]).optional(),
  category: z.enum(["transactional", "campaign", "otp", "all"]).optional(),
  status: z.enum(["sent", "delivered", "failed", "all"]).optional(),
  search: z.string().trim().max(120, "Search is too long").optional(),
});

module.exports = {
  messageLogQuery,
  deliverySummary,
  CATEGORIES,
  PLATFORMS,
  listNotifications,
  notificationIdParam,
  markAllRead,
  updatePreferences,
  resetPreferences,
  registerDevice,
  unregisterDevice,
  listDeliveries,
  listCampaigns,
  campaignIdParam,
  broadcast,
  sendTest,
};
