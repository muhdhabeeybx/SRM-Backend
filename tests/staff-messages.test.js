// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffRepo } = require("../repositories");
const { staffContact, pickContacts } = require("../notifications/recipients");
const engine = require("../notifications/engine");
const { CATALOG } = require("../notifications/catalog");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Alternate contacts for staff, the SMS copy to email, and messages between
 * staff.
 *
 * What has to hold: texts and emails go to the main, alternate or both
 * contacts as the person chose, falling back rather than going nowhere;
 * password mail only ever goes to the login address; a staff text is copied
 * to email only while STAFF_SMS_EMAIL_ENABLED is on; a message is readable by
 * its two people alone; one alert goes per conversation until it is read; and
 * the admin view never carries a word of any message.
 */
const RUN = Date.now();
const staffIds = [];
let a;
let b;
let c;
let admin;

const person = async (roles, tag) => {
  const s = await staffTokenWithRoles(roles, `msg-${tag}-${RUN}@soroman.test`);
  staffIds.push(Number(s.staff.id));
  return { id: Number(s.staff.id), token: s.accessToken };
};

const as = (who) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${who.token}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${who.token}`).send(body),
});

before(async () => {
  a = await person(["finance"], "a");
  b = await person(["ticketing"], "b");
  c = await person(["finance"], "c");
  admin = await person(["admin"], "admin");
});

after(async () => {
  if (staffIds.length) {
    await client`DELETE FROM staff_messages WHERE sender_id IN ${client(staffIds)} OR recipient_id IN ${client(staffIds)}`;
    await client`DELETE FROM notifications WHERE staff_id IN ${client(staffIds)}`;
    await client`DELETE FROM notification_deliveries WHERE staff_id IN ${client(staffIds)}`;
  }
  await closeDb();
});

describe("which contacts a staff message goes to", () => {
  const row = (over) => ({
    firstName: "Musa", surname: "Bello", email: "musa@soroman.co", phoneNumber: "08031234567",
    altEmail: "musa.home@gmail.com", altPhoneNumber: "08097654321", smsTo: "both", emailTo: "both", ...over,
  });

  test("both sends to the main and the alternate", () => {
    const contact = staffContact(row());
    assert.deepEqual(contact.phones, ["08031234567", "08097654321"]);
    assert.deepEqual(contact.emails, ["musa@soroman.co", "musa.home@gmail.com"]);
    assert.equal(contact.phone, "08031234567");
    assert.equal(contact.mainEmail, "musa@soroman.co");
  });

  test("main and alternate send to that one alone", () => {
    const contact = staffContact(row({ smsTo: "alternate", emailTo: "main" }));
    assert.deepEqual(contact.phones, ["08097654321"]);
    assert.deepEqual(contact.emails, ["musa@soroman.co"]);
  });

  test("a choice naming a missing contact falls back to the other", () => {
    assert.deepEqual(staffContact(row({ smsTo: "alternate", altPhoneNumber: null })).phones, ["08031234567"]);
    assert.deepEqual(staffContact(row({ smsTo: "main", phoneNumber: "" })).phones, ["08097654321"]);
    assert.deepEqual(staffContact(row({ altPhoneNumber: null, altEmail: null })).phones, ["08031234567"]);
  });

  test("the same number written twice is texted once", () => {
    assert.deepEqual(staffContact(row({ altPhoneNumber: "+2348031234567" })).phones, ["08031234567"]);
    assert.deepEqual(pickContacts("both", "A@x.co", "a@x.co"), ["A@x.co"]);
  });
});

describe("staff texts copied to email", () => {
  const entry = { channels: ["in_app", "push", "sms"], category: "operations" };
  const staff = { type: "staff", id: 1 };
  const contact = { email: "x@soroman.co", phone: "0803" };
  const gate = (principal = staff) =>
    engine.gateChannels({ entry, rendered: { priority: "normal" }, principal, contact, prefs: null, settings: null });

  test("off by default", () => {
    delete process.env.STAFF_SMS_EMAIL_ENABLED;
    assert.ok(!gate().allowed.includes("email"));
  });

  test("on, a staff text also emails — past the staff email pause — and a customer's does not", () => {
    process.env.STAFF_SMS_EMAIL_ENABLED = "true";
    try {
      assert.ok(gate().allowed.includes("email"));
      assert.ok(!gate({ type: "customer", id: 1 }).allowed.includes("email"));
    } finally {
      delete process.env.STAFF_SMS_EMAIL_ENABLED;
    }
  });

  test("a notice with no email of its own is emailed as its text", () => {
    process.env.STAFF_SMS_EMAIL_ENABLED = "true";
    try {
      const rendered = engine.render("staff.direct_message", CATALOG["staff.direct_message"],
        { senderName: "Aisha Bello", senderId: 5, messageId: 9, firstName: "Musa" }, { principal: staff, contact });
      assert.equal(rendered.email, null);
      assert.match(rendered.sms, /^Hello Musa, Aisha Bello sent you a message/);
    } finally {
      delete process.env.STAFF_SMS_EMAIL_ENABLED;
    }
  });
});

describe("password mail goes to the login address only", () => {
  test("an alternate email never receives a reset link", async () => {
    await staffRepo.update(a.id, { altEmail: `msg-alt-${RUN}@soroman.test`, emailTo: "both" });
    await engine.dispatch("account.password_reset", {
      to: { staffId: a.id },
      data: { firstName: "Weak", resetUrl: "https://example.invalid/reset" },
    });
    const rows = await client`
      SELECT destination FROM notification_deliveries
       WHERE staff_id = ${a.id} AND type = 'account.password_reset' AND channel = 'email'`;
    assert.ok(rows.length >= 1);
    assert.deepEqual([...new Set(rows.map((r) => r.destination))], [`msg-a-${RUN}@soroman.test`]);
  });
});

describe("messages between staff", () => {
  const alertsTo = async (id) => {
    // Alerts are fire-and-forget; give them a moment to land.
    await new Promise((r) => setTimeout(r, 400));
    const rows = await client`SELECT id FROM notifications WHERE staff_id = ${id} AND type = 'staff.direct_message'`;
    return rows.length;
  };

  test("one alert per conversation until it is read", async () => {
    const first = await as(a).post(`/api/staff-messages/with/${b.id}`, { body: "Please check PFI 47 tickets" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.alerted, true);

    const second = await as(a).post(`/api/staff-messages/with/${b.id}`, { body: "And the gate list" });
    assert.equal(second.body.data.alerted, false);
    assert.equal(await alertsTo(b.id), 1);

    const unread = await as(b).get("/api/staff-messages/unread-count");
    assert.equal(unread.body.data.unread, 2);

    const thread = await as(b).get(`/api/staff-messages/with/${a.id}`);
    assert.equal(thread.status, 200);
    assert.deepEqual(thread.body.data.messages.map((m) => m.body), ["Please check PFI 47 tickets", "And the gate list"]);
    assert.ok(thread.body.data.messages.every((m) => !m.fromMe && m.readAt));
    assert.equal((await as(b).get("/api/staff-messages/unread-count")).body.data.unread, 0);

    const third = await as(a).post(`/api/staff-messages/with/${b.id}`, { body: "Thanks" });
    assert.equal(third.body.data.alerted, true);
  });

  test("the alert says who, never what", async () => {
    const [n] = await client`
      SELECT title, body FROM notifications WHERE staff_id = ${b.id} AND type = 'staff.direct_message' LIMIT 1`;
    assert.match(n.title, /New message from Weak Staff/);
    assert.doesNotMatch(`${n.title} ${n.body}`, /PFI 47|gate list/);
  });

  test("nobody else can read a conversation", async () => {
    const theirs = await as(c).get(`/api/staff-messages/with/${a.id}`);
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body.data.messages, []);
    const people = await as(c).get("/api/staff-messages/people");
    const bRow = people.body.data.people.find((p) => p.id === b.id);
    assert.ok(bRow);
    assert.equal(bRow.lastMessage, null);
  });

  test("the people list carries each person's own conversation", async () => {
    const res = await as(b).get("/api/staff-messages/people");
    const aRow = res.body.data.people.find((p) => p.id === a.id);
    assert.equal(aRow.lastMessage.preview, "Thanks");
    assert.equal(aRow.lastMessage.fromMe, false);
    assert.equal(aRow.unread, 1);
    assert.ok(!res.body.data.people.some((p) => p.id === b.id), "never lists yourself");
  });

  test("bad sends are refused", async () => {
    assert.equal((await as(a).post(`/api/staff-messages/with/${a.id}`, { body: "me" })).status, 400);
    assert.equal((await as(a).post(`/api/staff-messages/with/${b.id}`, { body: "   " })).status, 400);
    assert.equal((await as(a).post(`/api/staff-messages/with/${b.id}`, { body: "x".repeat(4001) })).status, 400);
    assert.equal((await as(a).post(`/api/staff-messages/with/999999999`, { body: "hi" })).status, 404);
    await staffRepo.update(c.id, { suspended: true });
    try {
      assert.equal((await as(a).post(`/api/staff-messages/with/${c.id}`, { body: "hi" })).status, 400);
    } finally {
      await staffRepo.update(c.id, { suspended: false });
    }
  });

  test("admins see who wrote to whom, and not a word of it", async () => {
    assert.equal((await as(a).get("/api/staff-messages/activity")).status, 403);
    const res = await as(admin).get("/api/staff-messages/activity");
    assert.equal(res.status, 200);
    const pair = res.body.data.pairs.find((p) => p.senderId === a.id && p.recipientId === b.id);
    assert.equal(pair.messages, 3);
    assert.equal(pair.texts, 2);
    assert.equal(pair.unread, 1);
    assert.doesNotMatch(JSON.stringify(res.body), /PFI 47|gate list|Thanks/);
  });
});
