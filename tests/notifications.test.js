const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { closeDb, ensureTestStaff, staffToken } = require("./helpers");
const { customerRepo, notificationRepo, deviceTokenRepo, notificationPreferenceRepo, notificationDeliveryRepo } =
  require("../repositories");
const sessionService = require("../services/session.service");
const engine = require("../notifications/engine");
const catalog = require("../notifications/catalog");
const { notifyAndWait } = require("../notifications");
const sse = require("../notifications/sse");
const streamTicket = require("../notifications/streamTicket");
const fcm = require("../notifications/fcm");
const smsChannel = require("../notifications/channels/sms");
const { MESSAGE_CLASS } = require("../services/sms.service");

/**
 * The notification engine.
 *
 * The suite runs with SMS_ENABLED=false and no FCM/Resend credentials, so
 * every outbound channel reports `skipped` rather than reaching a provider —
 * which is exactly the boundary worth asserting on. What is tested here is the
 * engine's own logic: who gets the notification, whether their preferences are
 * honoured, that it is written exactly once, and that every outcome is
 * recorded.
 */

const PHONE = "+2348011122233";
const BASE = "/api/customer/notifications";
const ADMIN_BASE = "/api/notifications";

let customer;
let customerToken;
let staff;
let adminToken;

/**
 * Every row for a principal, cleared so counts are deterministic.
 *
 * Loops rather than taking a single page: the fixture customer and staff
 * accumulate notifications across runs, and a one-shot `limit: 100` silently
 * left the oldest rows behind once they passed a hundred — which then collided
 * with the fixed dedupe keys below and failed only on later runs.
 */
const clearInbox = async (principal) => {
  for (;;) {
    const { rows } = await notificationRepo.findForPrincipal(principal, {
      limit: 100,
      includeArchived: true,
    });
    if (!rows.length) return;
    for (const row of rows) await notificationRepo.remove(row.id, principal);
  }
};

/**
 * Dedupe keys are unique per run. A fixed key is indistinguishable from a
 * genuine duplicate if a previous run's row survives, so the assertions would
 * depend on database history rather than on this run's behaviour.
 */
const RUN = Date.now();
const key = (name) => `${name}-${RUN}`;

before(async () => {
  const existing = await customerRepo.findByPhone(PHONE);
  customer = existing
    ? await customerRepo.update(existing.id, { status: "Active", email: "notify-test@soroman.test" })
    : await customerRepo.create({
        name: "Notify Test",
        phone: PHONE,
        email: "notify-test@soroman.test",
        companyName: "Notify Co",
        status: "Active",
      });

  const issued = await sessionService.issue("customer", customer, {});
  customerToken = issued.accessToken;

  staff = await ensureTestStaff();
  adminToken = await staffToken(request, app);
});

after(async () => {
  await clearInbox({ type: "customer", id: customer.id });
  await clearInbox({ type: "staff", id: staff.id });
  await notificationPreferenceRepo.reset({ type: "customer", id: customer.id });
  await deviceTokenRepo.unregisterAll({ type: "customer", id: customer.id });
  sse.closeAll();
  streamTicket.clear();
  await closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("notification catalog", () => {
  test("every entry declares the fields the engine reads", () => {
    for (const type of catalog.listTypes()) {
      const entry = catalog.getType(type);
      assert.ok(entry.category, `${type} has no category`);
      assert.ok(entry.audience, `${type} has no audience`);
      assert.ok(Array.isArray(entry.channels), `${type} has no channels`);
      assert.equal(typeof entry.title, "function", `${type} has no title template`);
    }
  });

  test("templates never throw on empty data", () => {
    // The engine guards against this too, but a template that only works with
    // a full payload is a bug waiting for the one code path that forgot a field.
    for (const type of catalog.listTypes()) {
      const entry = catalog.getType(type);
      for (const fn of ["title", "body", "data", "entity", "actionUrl", "sms", "email", "imageUrl"]) {
        if (typeof entry[fn] !== "function") continue;
        assert.doesNotThrow(() => entry[fn]({}), `${type}.${fn} threw on empty data`);
      }
    }
  });

  test("an unknown type still renders rather than vanishing", () => {
    const rendered = engine.render(
      "not.a.real.type",
      catalog.getTypeOrDefault("not.a.real.type"),
      { title: "Fallback" },
      { principal: { type: "customer", id: 1 }, contact: {} }
    );
    assert.equal(rendered.title, "Fallback");
  });

  test("security notices are mandatory — no category can mute them", () => {
    for (const type of ["security.new_login", "security.identity_linked", "security.credential_changed"]) {
      assert.equal(catalog.getType(type).mandatory, true, `${type} must be mandatory`);
    }
    // …and therefore never appear in a settings screen.
    assert.ok(!catalog.categoriesFor("customer").includes("security"));
  });
});

describe("quiet hours", () => {
  const window = (start, end) => ({
    quietHoursEnabled: true,
    timezone: "Africa/Lagos",
    quietHoursStart: start,
    quietHoursEnd: end,
  });

  test("a window that wraps midnight still silences 00:15", () => {
    // 22:00 → 07:00. Lagos is UTC+1, so 23:15Z is 00:15 local.
    assert.equal(engine.inQuietHours(window(1320, 420), new Date("2026-08-08T23:15:00Z")), true);
  });

  test("daytime is never quiet", () => {
    assert.equal(engine.inQuietHours(window(1320, 420), new Date("2026-08-08T12:00:00Z")), false);
  });

  test("a zero-length window silences nothing", () => {
    assert.equal(engine.inQuietHours(window(600, 600), new Date("2026-08-08T09:00:00Z")), false);
  });

  test("an unparseable timezone lets the notification through", () => {
    // Failing open matters: a bad tz string must not silently mute someone.
    const bad = { quietHoursEnabled: true, timezone: "Not/AZone", quietHoursStart: 0, quietHoursEnd: 1439 };
    assert.equal(engine.inQuietHours(bad, new Date()), false);
  });

  test("urgent priority ignores quiet hours entirely", () => {
    const { allowed } = engine.gateChannels({
      entry: catalog.getType("order.paid"),
      rendered: { priority: "urgent" },
      principal: { type: "customer", id: customer.id },
      contact: { email: "a@b.com", phone: PHONE },
      prefs: null,
      settings: window(0, 1439), // quiet all day
    });
    assert.ok(allowed.includes("sms"), "an urgent payment confirmation must not be held");
    assert.ok(allowed.includes("push"));
  });

  test("a normal-priority notification is suppressed during quiet hours", () => {
    const { allowed, suppressed } = engine.gateChannels({
      entry: catalog.getType("order.cancelled"),
      rendered: { priority: "high" },
      principal: { type: "customer", id: customer.id },
      contact: { email: "a@b.com", phone: PHONE },
      prefs: null,
      settings: window(0, 1439),
    });
    assert.ok(!allowed.includes("sms"));
    assert.ok(suppressed.some((s) => s.channel === "sms" && s.reason === "Quiet hours"));
    // The inbox row is still written — quiet hours silence the buzz, not the record.
    assert.ok(allowed.includes("in_app"));
  });
});

describe("channel gating", () => {
  test("a muted category suppresses only that channel", () => {
    const { allowed, suppressed } = engine.gateChannels({
      entry: catalog.getType("order.paid"),
      rendered: { priority: "high" },
      principal: { type: "customer", id: customer.id },
      contact: { email: "a@b.com", phone: PHONE },
      prefs: { payments: { sms: false, push: true, email: true, inApp: true } },
      settings: null,
    });
    assert.ok(!allowed.includes("sms"));
    assert.ok(allowed.includes("push"));
    assert.ok(suppressed.some((s) => s.channel === "sms" && /Muted/.test(s.reason)));
  });

  /**
   * The reason the two announcement types exist. Muting the adverts must not
   * cost the recipient an outage notice — if both still shared one category,
   * this test would fail on the second assertion.
   */
  test("muting marketing silences promos but not system announcements", () => {
    const prefs = { marketing: { inApp: false, push: false, email: false, sms: false } };
    const args = {
      rendered: { priority: "normal" },
      principal: { type: "customer", id: customer.id },
      contact: { email: "a@b.com", phone: PHONE },
      prefs,
      settings: null,
    };

    const promo = engine.gateChannels({ ...args, entry: catalog.getType("marketing.announcement") });
    assert.ok(!promo.allowed.includes("push"), "a muted promo must not buzz the handset");
    assert.ok(promo.suppressed.some((s) => s.channel === "push" && /Muted/.test(s.reason)));

    const notice = engine.gateChannels({ ...args, entry: catalog.getType("system.announcement") });
    assert.ok(notice.allowed.includes("push"), "system news must survive a marketing mute");
  });

  /**
   * The second thing the announcement split buys, beyond the mute.
   *
   * The catalog category decides which Termii route the text takes, and the
   * two routes reach different people: `dnd` is the only one that reaches a
   * DND-registered handset (roughly a third of Nigerian numbers), and
   * `generic` is the only one a promotion is allowed on. Getting this backwards
   * is silent both ways — a depot closure billed and never delivered, or an
   * advert pushed at someone who registered specifically to stop receiving
   * them.
   */
  test("the catalog category decides the Termii route", () => {
    // Walked over the whole catalog rather than a handful of samples, so a new
    // entry has to be a deliberate decision: anything added under a new
    // category inherits the transactional route and this test says so out loud.
    const promotional = [];
    for (const type of catalog.listTypes()) {
      const entry = catalog.getType(type);
      assert.ok(entry, `${type} has no catalog entry`);
      if (smsChannel.messageClassFor(entry) === MESSAGE_CLASS.PROMOTIONAL) promotional.push(type);
    }

    assert.deepEqual(
      promotional,
      ["marketing.announcement"],
      "only marketing may be kept off the route that reaches a DND-registered number"
    );

    // The pair that matters most: the same announcement, sent two ways.
    assert.equal(
      smsChannel.messageClassFor(catalog.getType("system.announcement")),
      MESSAGE_CLASS.TRANSACTIONAL,
      "a depot closure must reach a DND-registered customer"
    );
    assert.equal(
      smsChannel.messageClassFor(catalog.getType("order.paid")),
      MESSAGE_CLASS.TRANSACTIONAL
    );
  });

  test("a notification with no category is treated as transactional", () => {
    // A wasted send is the cheaper mistake; a payment instruction nobody
    // receives is not.
    assert.equal(smsChannel.messageClassFor(undefined), MESSAGE_CLASS.TRANSACTIONAL);
    assert.equal(smsChannel.messageClassFor({}), MESSAGE_CLASS.TRANSACTIONAL);
  });

  test("a mandatory type ignores a muted category", () => {
    const { allowed } = engine.gateChannels({
      entry: catalog.getType("security.credential_changed"),
      rendered: { priority: "urgent" },
      principal: { type: "customer", id: customer.id },
      contact: { email: "a@b.com", phone: PHONE },
      prefs: { security: { inApp: false, push: false, email: false, sms: false } },
      settings: { pushEnabled: false, emailEnabled: false, smsEnabled: false },
    });
    assert.ok(allowed.includes("in_app"), "a security notice must always reach the inbox");
    assert.ok(allowed.includes("push"));
  });

  test("a recipient with no account gets neither inbox nor push", () => {
    const { allowed, suppressed } = engine.gateChannels({
      entry: catalog.getType("delivery.released"),
      rendered: { priority: "high" },
      principal: null,
      contact: { phone: PHONE },
      prefs: null,
      settings: null,
    });
    assert.deepEqual(allowed, ["sms"], "SMS is the only channel a bare phone number can carry");
    assert.ok(suppressed.some((s) => s.channel === "in_app"));
  });

  test("a missing address is skipped, not silently dropped", () => {
    const { allowed, suppressed } = engine.gateChannels({
      entry: catalog.getType("order.paid"),
      rendered: { priority: "high" },
      principal: { type: "customer", id: customer.id },
      contact: { email: "", phone: "" },
      prefs: null,
      settings: null,
    });
    assert.ok(!allowed.includes("email"));
    assert.ok(!allowed.includes("sms"));
    assert.ok(suppressed.some((s) => s.channel === "email" && /No email/.test(s.reason)));
  });
});

describe("dispatch", () => {
  test("writes an inbox row and records every channel outcome", async () => {
    const principal = { type: "customer", id: customer.id };
    await clearInbox(principal);

    const result = await notifyAndWait("order.paid", {
      to: { customerId: customer.id },
      data: { orderId: 999001, orderNumber: "TEST/999001", amountPaid: 50000 },
    });

    assert.equal(result.recipients, 1);
    assert.equal(result.delivered, 1);

    const { rows } = await notificationRepo.findForPrincipal(principal, { limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "order.paid");
    assert.equal(rows[0].category, "payments");
    assert.match(rows[0].title, /TEST\/999001/);
    assert.equal(rows[0].entityType, "order");
    assert.equal(rows[0].entityId, "999001");

    // Every channel that was attempted left a row, including the ones that
    // could not run — that is the point of the log.
    const deliveries = await notificationDeliveryRepo.findForNotification(rows[0].id);
    const channels = deliveries.map((d) => d.channel).sort();
    assert.deepEqual(channels, ["email", "push", "sms"], "all three outbound channels recorded");
    for (const d of deliveries) {
      assert.ok(["sent", "skipped", "failed"].includes(d.status), `unexpected status ${d.status}`);
    }
  });

  test("a repeated dedupe key delivers exactly once", async () => {
    const principal = { type: "customer", id: customer.id };
    await clearInbox(principal);

    const payload = {
      to: { customerId: customer.id },
      data: { orderId: 999002, orderNumber: "TEST/999002" },
    };
    const first = await notifyAndWait("order.released", payload);
    const second = await notifyAndWait("order.released", payload);

    assert.equal(first.delivered, 1);
    assert.equal(second.duplicates, 1, "the second call must be recognised as a duplicate");

    const { rows } = await notificationRepo.findForPrincipal(principal, { limit: 10 });
    assert.equal(rows.length, 1, "a redelivered job must not buzz the customer twice");
  });

  test("a broadcast dedupe key does not collapse onto one recipient", async () => {
    // The bug this guards: a dedupe key scoped to the EVENT rather than to the
    // (event, recipient) pair makes the partial unique index admit the first
    // recipient and silently drop everyone else.
    const c = { type: "customer", id: customer.id };
    const s = { type: "staff", id: staff.id };
    await clearInbox(c);
    await clearInbox(s);

    const result = await notifyAndWait("system.announcement", {
      to: [{ customerId: customer.id }, { staffId: staff.id }],
      data: { title: "Shared", body: "One key, two people", announcementId: key("dedupe-probe-1") },
    });

    assert.equal(result.recipients, 2);
    assert.equal(result.delivered, 2, "both recipients must receive it");
    assert.equal((await notificationRepo.findForPrincipal(c, { limit: 5 })).rows.length, 1);
    assert.equal((await notificationRepo.findForPrincipal(s, { limit: 5 })).rows.length, 1);
  });

  test("duplicate recipient specs collapse to one notification", async () => {
    const principal = { type: "customer", id: customer.id };
    await clearInbox(principal);

    const result = await notifyAndWait("system.announcement", {
      to: [{ customerId: customer.id }, { customerId: customer.id }],
      data: { title: "Once", body: "Only once", announcementId: key("dupe-spec-1") },
    });

    assert.equal(result.recipients, 1, "the same person listed twice is one recipient");
  });

  test("a role broadcast reaches staff holding the role", async () => {
    const principal = { type: "staff", id: staff.id };
    await clearInbox(principal);

    const result = await notifyAndWait("staff.daily_report_submitted", {
      to: { roles: ["super_admin"] },
      data: { reportId: 4242, location: "Kano", reportDate: "2026-08-08" },
    });

    assert.ok(result.recipients >= 1);
    const { rows } = await notificationRepo.findForPrincipal(principal, { limit: 10 });
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /Kano/);
  });

  test("an unknown recipient produces no delivery and no crash", async () => {
    const result = await notifyAndWait("order.paid", {
      to: { customerId: 99_999_999 },
      data: { orderId: 1 },
    });
    assert.equal(result.recipients, 0);
  });

  test("a preference stored by the customer is honoured end to end", async () => {
    const principal = { type: "customer", id: customer.id };
    await clearInbox(principal);
    await notificationPreferenceRepo.upsert(principal, "orders", { inApp: false });

    await notifyAndWait("order.completed", {
      to: { customerId: customer.id },
      data: { orderId: 999003, orderNumber: "TEST/999003" },
    });

    const { rows } = await notificationRepo.findForPrincipal(principal, { limit: 10 });
    assert.equal(rows.length, 0, "a muted in-app category must write no inbox row");

    await notificationPreferenceRepo.reset(principal, { category: "orders" });
  });
});

describe("push", () => {
  test("is disabled without credentials, and never guesses", () => {
    // The suite has no FCM_* set, so this is the real production guard: an
    // unconfigured project must skip rather than throw on every send.
    assert.equal(fcm.isConfigured(), false);
    assert.equal(fcm.isEnabled(), false);
  });

  test("the FCM envelope carries the per-platform fields that make delivery work", () => {
    const msg = fcm.buildMessage({
      token: "tok",
      title: "Payment confirmed",
      body: "We received your payment",
      data: { orderId: 12, nested: { a: 1 } },
      priority: "urgent",
      badge: 3,
    });

    // Without these two, Android holds the notification in Doze and iOS may
    // treat it as a silent background push.
    assert.equal(msg.android.priority, "HIGH");
    assert.equal(msg.apns.headers["apns-priority"], "10");
    assert.equal(msg.apns.payload.aps.badge, 3);

    // FCM rejects a data map containing anything but strings.
    for (const v of Object.values(msg.data)) assert.equal(typeof v, "string");
    assert.equal(msg.data.orderId, "12");
    assert.equal(msg.data.nested, JSON.stringify({ a: 1 }));
  });

  test("classifies a dead token as permanent and a 503 as retryable", () => {
    const dead = fcm.classifyError({ response: { status: 404, data: {} } });
    assert.equal(dead.permanent, true);

    const blip = fcm.classifyError({ response: { status: 503, data: {} } });
    assert.equal(blip.permanent, false);
    assert.equal(blip.retryable, true);

    // Our own credential failing must never retire a customer's device.
    const creds = fcm.classifyError({ response: { status: 401, data: {} } });
    assert.equal(creds.permanent, false);
    assert.equal(creds.credential, true);
  });
});

describe("device tokens", () => {
  test("re-registering a token moves it to the current principal", async () => {
    const a = { type: "customer", id: customer.id };
    const b = { type: "staff", id: staff.id };
    const token = `tok-shared-${Date.now()}`;

    await deviceTokenRepo.register(a, { token, platform: "android", deviceId: "handset-1" });
    await deviceTokenRepo.register(b, { token, platform: "android", deviceId: "handset-1" });

    const forCustomer = await deviceTokenRepo.findLiveForPrincipal(a);
    const forStaff = await deviceTokenRepo.findLiveForPrincipal(b);

    assert.ok(!forCustomer.some((t) => t.token === token), "the previous owner must stop receiving");
    assert.ok(forStaff.some((t) => t.token === token));

    await deviceTokenRepo.unregisterAll(b);
  });

  test("a rotated token retires the device's previous one", async () => {
    const principal = { type: "customer", id: customer.id };
    const deviceId = `dev-${Date.now()}`;
    await deviceTokenRepo.register(principal, { token: `${deviceId}-old`, platform: "ios", deviceId });
    await deviceTokenRepo.register(principal, { token: `${deviceId}-new`, platform: "ios", deviceId });

    const live = await deviceTokenRepo.findLiveForPrincipal(principal);
    const tokens = live.map((t) => t.token);
    assert.ok(tokens.includes(`${deviceId}-new`));
    assert.ok(!tokens.includes(`${deviceId}-old`), "one device must not accumulate live tokens");

    await deviceTokenRepo.unregisterAll(principal);
  });

  test("a permanently rejected token is retired immediately", async () => {
    const principal = { type: "customer", id: customer.id };
    const token = `tok-dead-${Date.now()}`;
    await deviceTokenRepo.register(principal, { token, platform: "android" });
    await deviceTokenRepo.disableToken(token, "unregistered");

    const live = await deviceTokenRepo.findLiveForPrincipal(principal);
    assert.ok(!live.some((t) => t.token === token));
  });
});

describe("HTTP API", () => {
  const auth = (req) => req.set("Authorization", `Bearer ${customerToken}`);

  test("the inbox is scoped — a customer never sees another principal's rows", async () => {
    const c = { type: "customer", id: customer.id };
    const s = { type: "staff", id: staff.id };
    await clearInbox(c);
    await clearInbox(s);

    await notifyAndWait("system.announcement", {
      to: { staffId: staff.id },
      data: { title: "Staff only", body: "Not for customers", announcementId: key("scope-1") },
    });

    const res = await auth(request(app).get(BASE));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.data.length, 0, "a staff notification must not appear in a customer inbox");
  });

  test("list, badge, read and read-all move together", async () => {
    const principal = { type: "customer", id: customer.id };
    await clearInbox(principal);

    await notifyAndWait("system.announcement", {
      to: { customerId: customer.id },
      data: { title: "First", body: "one", announcementId: key("api-1") },
    });
    await notifyAndWait("system.announcement", {
      to: { customerId: customer.id },
      data: { title: "Second", body: "two", announcementId: key("api-2") },
    });

    const list = await auth(request(app).get(BASE));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.data.length, 2);
    assert.equal(list.body.data.unreadCount, 2);
    // Newest first.
    assert.equal(list.body.data.data[0].title, "Second");

    const badge = await auth(request(app).get(`${BASE}/unread-count`));
    assert.equal(badge.body.data.unreadCount, 2);
    assert.equal(badge.body.data.byCategory.system, 2);

    const id = list.body.data.data[0].id;
    const read = await auth(request(app).patch(`${BASE}/${id}/read`));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.unreadCount, 1);

    const all = await auth(request(app).post(`${BASE}/read-all`)).send({});
    assert.equal(all.status, 200);
    assert.equal(all.body.data.unreadCount, 0);
  });

  test("reading someone else's notification is a 404, not a 403", async () => {
    // 404 rather than 403: a 403 would confirm the row exists.
    await clearInbox({ type: "staff", id: staff.id });
    const sent = await notifyAndWait("system.announcement", {
      to: { staffId: staff.id },
      data: { title: "Theirs", body: "x", announcementId: key("cross-1") },
    });
    const foreignId = sent.results[0].notification.id;

    const res = await auth(request(app).patch(`${BASE}/${foreignId}/read`));
    assert.equal(res.status, 404);
  });

  test("preferences round-trip and report the effective state", async () => {
    const principal = { type: "customer", id: customer.id };
    await notificationPreferenceRepo.reset(principal);

    const before = await auth(request(app).get(`${BASE}/preferences`));
    assert.equal(before.status, 200);
    assert.ok(before.body.data.preferences.length > 0);
    assert.deepEqual(before.body.data.alwaysOn, ["security"]);

    const patched = await auth(request(app).patch(`${BASE}/preferences`)).send({
      preferences: [{ category: "orders", sms: false }],
      quietHoursEnabled: true,
      quietHoursStart: 1320,
      quietHoursEnd: 420,
      timezone: "Africa/Lagos",
    });
    assert.equal(patched.status, 200);

    const orders = patched.body.data.preferences.find((p) => p.category === "orders");
    assert.equal(orders.sms, false, "the muted channel is stored");
    assert.equal(orders.push, true, "channels not named in the patch are untouched");
    assert.equal(patched.body.data.settings.quietHoursEnabled, true);
    assert.equal(patched.body.data.settings.timezone, "Africa/Lagos");

    await notificationPreferenceRepo.reset(principal);
  });

  test("an invalid timezone is rejected at the boundary", async () => {
    // Stored unchecked, a plausible-looking zone would silently disable quiet
    // hours at send time instead of failing here.
    const res = await auth(request(app).patch(`${BASE}/preferences`)).send({ timezone: "Mars/Olympus" });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body.errors), /IANA/);
  });

  test("device registration is idempotent", async () => {
    const body = {
      token: `api-tok-${Date.now()}`,
      platform: "android",
      deviceId: "api-device",
      deviceName: "Pixel",
    };
    const first = await auth(request(app).post(`${BASE}/devices`)).send(body);
    assert.equal(first.status, 201);
    const second = await auth(request(app).post(`${BASE}/devices`)).send(body);
    assert.equal(second.status, 201);
    assert.equal(first.body.data.id, second.body.data.id, "re-registering must not create a second row");

    const list = await auth(request(app).get(`${BASE}/devices`));
    assert.equal(list.body.data.filter((d) => d.deviceId === "api-device").length, 1);

    const removed = await auth(request(app).delete(`${BASE}/devices`)).send({ token: body.token });
    assert.equal(removed.status, 200);
  });

  test("registering a device rejects an unknown platform", async () => {
    const res = await auth(request(app).post(`${BASE}/devices`)).send({
      token: "x".repeat(40),
      platform: "blackberry",
    });
    assert.equal(res.status, 400);
  });

  test("/stream refuses an unauthenticated connection with JSON, not a stream", async () => {
    const res = await request(app).get(`${BASE}/stream`);
    assert.equal(res.status, 401);
    assert.match(res.headers["content-type"], /json/);
  });

  test("a stream ticket is single-use", async () => {
    const res = await auth(request(app).post(`${BASE}/stream-ticket`));
    assert.equal(res.status, 200);
    const { ticket } = res.body.data;

    const first = streamTicket.redeem(ticket);
    assert.equal(first.type, "customer");
    assert.equal(first.id, customer.id);
    assert.equal(streamTicket.redeem(ticket), null, "a captured ticket must not replay");
  });
});

describe("admin API", () => {
  const asAdmin = (req) => req.set("Authorization", `Bearer ${adminToken}`);

  test("a broadcast to specific recipients reaches them", async () => {
    const principal = { type: "customer", id: customer.id };
    await clearInbox(principal);

    const res = await asAdmin(request(app).post(`${ADMIN_BASE}/broadcast`)).send({
      title: "Scheduled maintenance",
      body: "The portal will be briefly unavailable tonight.",
      audience: "specific",
      customerIds: [customer.id],
      channels: ["in_app"],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.recipients, 1);

    const { rows } = await notificationRepo.findForPrincipal(principal, { limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Scheduled maintenance");
  });

  test("a broadcast must name its recipients", async () => {
    const res = await asAdmin(request(app).post(`${ADMIN_BASE}/broadcast`)).send({
      title: "Oops",
      body: "No audience",
      audience: "specific",
    });
    assert.equal(res.status, 400);
  });

  test("health reports channel stats and provider configuration", async () => {
    const res = await asAdmin(request(app).get(`${ADMIN_BASE}/health`));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.providers.push.configured, false);
    assert.ok(res.body.data.engine.types > 0);
    assert.ok(res.body.data.stream);
  });

  test("the delivery log is queryable by channel", async () => {
    const res = await asAdmin(request(app).get(`${ADMIN_BASE}/deliveries?channel=push&limit=5`));
    assert.equal(res.status, 200);
    for (const row of res.body.data.data) assert.equal(row.channel, "push");
  });
});
