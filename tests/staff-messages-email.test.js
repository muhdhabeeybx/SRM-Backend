// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const staffMessages = require("../services/staffMessages.service");
const mailer = require("../services/staffMessageEmail.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Staff messages by email, both ways (migration 0087).
 *
 * What has to hold: every message is emailed to the recipient's chosen
 * addresses with a reply address of its own; a genuine reply posts the words
 * above the quoted email into the conversation, once, as the replier, and is
 * emailed on; a reply from an address not on the replier's account, a forged
 * reply address, failed sender authentication or an unsigned webhook posts
 * nothing.
 */
const RUN = Date.now();
const staffIds = [];
const SECRET = `whsec_${Buffer.from(`inbound-test-${RUN}`).toString("base64")}`;
const DOMAIN = "replies.soroman.example";
let a;
let b;
let sent;
let received;

const person = async (roles, tag) => {
  const s = await staffTokenWithRoles(roles, `mail-${tag}-${RUN}@soroman.test`);
  staffIds.push(Number(s.staff.id));
  return { id: Number(s.staff.id), token: s.accessToken };
};

/** A Resend (Svix) webhook delivery, signed the way Resend signs it. */
const deliver = (event, { secret = SECRET } = {}) => {
  const payload = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto
    .createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${ts}.${payload}`)
    .digest("base64");
  return request(app)
    .post("/api/webhooks/resend-inbound")
    .set("Content-Type", "application/json")
    .set("svix-id", id)
    .set("svix-timestamp", ts)
    .set("svix-signature", `v1,${sig}`)
    .send(payload);
};

const replyEvent = (to, emailId = crypto.randomUUID()) => ({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: { email_id: emailId, from: "x@x", to: [to], cc: [], bcc: [], received_for: [], subject: "Re: Message" },
});

const thread = async (x, y) => client`
  SELECT id, sender_id, recipient_id, body, via, read_at, emailed_at, emailed_to, inbound_email_id
    FROM staff_messages
   WHERE LEAST(sender_id, recipient_id) = ${Math.min(x, y)} AND GREATEST(sender_id, recipient_id) = ${Math.max(x, y)}
   ORDER BY id`;

const env = {};
before(async () => {
  for (const k of ["STAFF_MESSAGE_REPLY_DOMAIN", "RESEND_INBOUND_WEBHOOK_SECRET", "STAFF_MESSAGE_EMAIL_ENABLED"]) env[k] = process.env[k];
  process.env.STAFF_MESSAGE_REPLY_DOMAIN = DOMAIN;
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  delete process.env.STAFF_MESSAGE_EMAIL_ENABLED;

  a = await person(["finance"], "a");
  b = await person(["ticketing"], "b");
  // b reads at work and at home.
  await client`UPDATE staff SET alt_email = ${`b-home-${RUN}@gmail.com`}, email_to = 'both' WHERE id = ${b.id}`;

  mailer.deps.sendMail = async (payload) => {
    sent.push(payload);
    return { data: { id: `out-${sent.length}` } };
  };
  mailer.deps.getReceived = async (id) => ({ data: received.get(id) || null, error: received.has(id) ? null : { message: "not found" } });
});

beforeEach(() => {
  sent = [];
  received = new Map();
});

after(async () => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (staffIds.length) {
    await client`DELETE FROM staff_messages WHERE sender_id IN ${client(staffIds)} OR recipient_id IN ${client(staffIds)}`;
    await client`DELETE FROM notifications WHERE staff_id IN ${client(staffIds)}`;
    await client`DELETE FROM notification_deliveries WHERE staff_id IN ${client(staffIds)}`;
  }
  await client`DELETE FROM webhook_events WHERE event = 'resend.email.received' AND payload::text LIKE ${`%${DOMAIN}%`}`;
  await closeDb();
});

describe("a message, emailed", () => {
  test("goes to every address the recipient chose, with a reply address for the conversation", async () => {
    const { message } = await staffMessages.send(a.id, b.id, "Truck 4 is at the gate.\nPlease confirm.");
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.deepEqual(mail.to, [`mail-b-${RUN}@soroman.test`, `b-home-${RUN}@gmail.com`]);
    assert.equal(mail.replyTo, mailer.replyAddress(b.id, a.id));
    assert.match(mail.replyTo, new RegExp(`^chat-${b.id}-${a.id}-[0-9a-f]{16}@${DOMAIN.replace(/\./g, "\\.")}$`));
    assert.match(mail.text, /Truck 4 is at the gate\.\nPlease confirm\./);
    assert.match(mail.html, /Truck 4 is at the gate\.<br>Please confirm\./);
    assert.match(mail.from, /via Soroman </);

    const [row] = await client`SELECT emailed_at, emailed_to, email_error, via FROM staff_messages WHERE id = ${message.id}`;
    assert.ok(row.emailed_at, "the row says it was emailed");
    assert.equal(row.emailed_to, `mail-b-${RUN}@soroman.test, b-home-${RUN}@gmail.com`);
    assert.equal(row.via, "app");
    assert.ok(message.emailedAt, "and the conversation can show it");
  });

  test("says to answer in the dashboard while no reply domain is set", async () => {
    process.env.STAFF_MESSAGE_REPLY_DOMAIN = "";
    try {
      await staffMessages.send(a.id, b.id, "No domain yet");
      assert.equal(sent[0].replyTo, undefined);
      assert.match(sent[0].text, /answer on the Soroman dashboard/);
    } finally {
      process.env.STAFF_MESSAGE_REPLY_DOMAIN = DOMAIN;
    }
  });

  test("is not sent while STAFF_MESSAGE_EMAIL_ENABLED=false, and the message still is", async () => {
    process.env.STAFF_MESSAGE_EMAIL_ENABLED = "false";
    try {
      const { message } = await staffMessages.send(a.id, b.id, "Quiet one");
      assert.equal(sent.length, 0);
      assert.equal(message.emailedAt, null);
    } finally {
      delete process.env.STAFF_MESSAGE_EMAIL_ENABLED;
    }
  });
});

describe("the reply address", () => {
  test("names its conversation, and a changed one names nothing", () => {
    const address = mailer.replyAddress(b.id, a.id);
    assert.deepEqual(mailer.parseReplyAddress(address), { replierId: b.id, otherId: a.id });
    assert.deepEqual(mailer.parseReplyAddress(`Soroman <${address.toUpperCase()}>`), { replierId: b.id, otherId: a.id });
    const swapped = address.replace(`chat-${b.id}-${a.id}-`, `chat-${a.id}-${b.id}-`);
    assert.equal(mailer.parseReplyAddress(swapped), null, "the signature is over who is answering whom");
    assert.equal(mailer.parseReplyAddress(address.replace(DOMAIN, "elsewhere.example")), null);
    assert.equal(mailer.parseReplyAddress("orders@soromannl.com"), null);
  });
});

describe("what a reply says", () => {
  test("Gmail: the words above 'On … wrote:'", () => {
    const text = "Confirmed, loading now.\n\nOn Wed, 15 Oct 2026 at 10:02, Musa via Soroman <\norders@soromannl.com> wrote:\n> Truck 4 is at the gate.";
    assert.equal(mailer.replyText({ text }), "Confirmed, loading now.");
  });

  test("Outlook: the words above its From/Sent block", () => {
    const text = "Done.\n\nFrom: Musa via Soroman <orders@soromannl.com>\nSent: Wednesday, October 15, 2026 10:02 AM\nTo: b\nSubject: Message from Musa";
    assert.equal(mailer.replyText({ text }), "Done.");
  });

  test("a phone's signature and quoted lines are dropped", () => {
    assert.equal(mailer.replyText({ text: "OK\n\nSent from my iPhone" }), "OK");
    assert.equal(mailer.replyText({ text: "Yes\n> earlier\n> lines" }), "Yes");
  });

  test("HTML only: the quoted blockquote goes, line breaks stay", () => {
    const html = "<div>Two trucks left.<br>One more at 3pm &amp; done.</div><blockquote>Truck 4 is at the gate.</blockquote>";
    assert.equal(mailer.replyText({ text: null, html }), "Two trucks left.\nOne more at 3pm & done.");
    const dataUri = `data:text/html;base64,${Buffer.from("<p>Seen</p><div class=\"gmail_quote\">old</div>").toString("base64")}`;
    assert.equal(mailer.replyText({ text: null, html: dataUri }), "Seen");
  });
});

describe("a reply by email", () => {
  test("posts into the conversation as the replier, once, and goes on to the other person", async () => {
    await staffMessages.send(a.id, b.id, "Can you load truck 7?");
    sent = [];
    const ev = replyEvent(mailer.replyAddress(b.id, a.id));
    received.set(ev.data.email_id, {
      from: `b-home-${RUN}@gmail.com`,
      text: "Yes, loading it now.\n\nOn Wed, 15 Oct 2026, Musa wrote:\n> Can you load truck 7?",
      html: null,
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });

    const res = await deliver(ev);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "posted");

    const rows = await thread(a.id, b.id);
    const reply = rows.at(-1);
    assert.equal(reply.body, "Yes, loading it now.");
    assert.equal(Number(reply.sender_id), b.id);
    assert.equal(Number(reply.recipient_id), a.id);
    assert.equal(reply.via, "email");
    assert.equal(reply.inbound_email_id, ev.data.email_id);
    assert.ok(rows.filter((r) => Number(r.recipient_id) === b.id).every((r) => r.read_at), "answering is reading");

    assert.equal(sent.length, 1, "the reply is emailed on to the other person");
    assert.deepEqual(sent[0].to, [`mail-a-${RUN}@soroman.test`]);
    assert.equal(sent[0].replyTo, mailer.replyAddress(a.id, b.id));

    const again = await deliver(ev);
    assert.equal(again.body.status, "duplicate", "a second delivery of the same email posts nothing");
    assert.equal((await thread(a.id, b.id)).length, rows.length);

    const [logged] = await client`
      SELECT status FROM webhook_events WHERE event = 'resend.email.received' AND payload->'data'->>'email_id' = ${ev.data.email_id} ORDER BY id LIMIT 1`;
    assert.equal(logged.status, "processed");
  });

  test("from an address not on the replier's account posts nothing", async () => {
    const before = (await thread(a.id, b.id)).length;
    const ev = replyEvent(mailer.replyAddress(b.id, a.id));
    received.set(ev.data.email_id, { from: "someone@else.example", text: "Pay me", authentication: { dmarc: "pass" } });
    const res = await deliver(ev);
    assert.equal(res.body.status, "ignored");
    assert.match(res.body.reason, /not an address on/);
    assert.equal((await thread(a.id, b.id)).length, before);
  });

  test("that failed DMARC posts nothing, even from the right address", async () => {
    const before = (await thread(a.id, b.id)).length;
    const ev = replyEvent(mailer.replyAddress(b.id, a.id));
    received.set(ev.data.email_id, { from: `mail-b-${RUN}@soroman.test`, text: "Spoofed", authentication: { dmarc: "fail" } });
    assert.equal((await deliver(ev)).body.status, "ignored");
    assert.equal((await thread(a.id, b.id)).length, before);
  });

  test("to a forged reply address posts nothing", async () => {
    const forged = `chat-${b.id}-${a.id}-0000000000000000@${DOMAIN}`;
    const ev = replyEvent(forged);
    received.set(ev.data.email_id, { from: `mail-b-${RUN}@soroman.test`, text: "Hi", authentication: { dmarc: "pass" } });
    assert.equal((await deliver(ev)).body.status, "ignored");
  });

  test("an unsigned or wrongly signed delivery is refused", async () => {
    const ev = replyEvent(mailer.replyAddress(b.id, a.id));
    const wrong = await deliver(ev, { secret: `whsec_${Buffer.from("not-the-secret").toString("base64")}` });
    assert.equal(wrong.status, 401);
    const unsigned = await request(app).post("/api/webhooks/resend-inbound").set("Content-Type", "application/json").send(JSON.stringify(ev));
    assert.equal(unsigned.status, 401);
  });

  test("the conversation shows which messages came by email and which were emailed", async () => {
    const res = await request(app)
      .get(`/api/staff-messages/with/${b.id}`)
      .set("Authorization", `Bearer ${a.token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const messages = res.body.data.messages;
    assert.ok(messages.some((m) => m.via === "email" && !m.fromMe));
    assert.ok(messages.some((m) => m.fromMe && m.emailedAt));
  });
});
