// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const nock = require("nock");
const { sql, like } = require("drizzle-orm");

const { db } = require("../config/db");
const { messageLog, staff } = require("../db/schema");
const { closeDb, staffTokenWithRoles } = require("./helpers");
const smsService = require("../services/sms.service");
const ledger = require("../services/messageLog.service");

/**
 * Every message sent is in the ledger, with what it cost. Asserted here: an
 * SMS is written at the moment it leaves, a refusal is written too, a one-time
 * code never reaches the table, Termii's charge lands on the same row by its
 * message id, a message only Termii knows about is added, and each is matched
 * to the person it went to.
 */
const BASE = "https://termii.test";
const RUN = Date.now();
const PHONE = `0803${String(RUN).slice(-7)}`;
const TAG = `ledger-test-${RUN}`;

let staffMember;
const saved = {};

describe("message ledger — every message, and what it cost", () => {
  before(async () => {
    for (const k of ["TERMII_BASE_URL", "TERMII_API_KEY", "SMS_ENABLED"]) saved[k] = process.env[k];
    process.env.TERMII_BASE_URL = BASE;
    process.env.TERMII_API_KEY = "test-key";
    process.env.SMS_ENABLED = "true";
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
    ({ staff: staffMember } = await staffTokenWithRoles(["finance"], `ledger-${RUN}@soroman.test`));
    await db.execute(sql`UPDATE staff SET phone_number = ${PHONE} WHERE id = ${staffMember.id}`);
  });

  after(async () => {
    await db.delete(messageLog).where(like(messageLog.recipient, `%${PHONE.slice(1)}%`));
    await db.delete(messageLog).where(like(messageLog.type, `${TAG}%`));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    nock.cleanAll();
    nock.enableNetConnect();
    await closeDb();
  });

  const rowsFor = () => db.select().from(messageLog).where(like(messageLog.recipient, `%${PHONE.slice(1)}%`));

  test("an SMS is written as it leaves, with its type and route", async () => {
    nock(BASE).post("/api/sms/send").reply(200, { code: "ok", message_id: `mid-${RUN}-1`, message: "Successfully Sent" });
    const res = await smsService.route(PHONE, "Your order is ready", { tag: { type: `${TAG}.ready` } });
    assert.equal(res.success, true);
    const [row] = (await rowsFor()).filter((r) => r.providerMessageId === `mid-${RUN}-1`);
    assert.ok(row, "the send is in the ledger");
    assert.equal(row.channel, "sms");
    assert.equal(row.type, `${TAG}.ready`);
    assert.equal(row.route, "dnd", "transactional goes dnd first");
    assert.equal(row.status, "sent");
    assert.equal(row.amount, null, "the charge comes from Termii's history, not the send");
  });

  test("a refused SMS is written too", async () => {
    nock(BASE).post("/api/sms/send").times(2).reply(400, { message: "Insufficient balance" });
    const res = await smsService.route(PHONE, "Refused text", { tag: { type: `${TAG}.refused` } });
    assert.equal(res.success, false);
    const [row] = (await rowsFor()).filter((r) => r.type === `${TAG}.refused`);
    assert.equal(row.status, "failed");
    assert.match(row.error, /Insufficient balance/);
  });

  test("a one-time code never reaches the table", async () => {
    nock(BASE).post("/api/sms/send").reply(200, { code: "ok", message_id: `mid-${RUN}-otp`, message: "Successfully Sent" });
    await smsService.sendSMSWithFallback(PHONE, "Your Soroman verification code is 482913. It expires in 10 minutes.", {
      type: `${TAG}.otp`, category: "otp",
    });
    const [row] = (await rowsFor()).filter((r) => r.providerMessageId === `mid-${RUN}-otp`);
    assert.doesNotMatch(row.body, /482913/);
    assert.match(row.body, /code is ••••••/);
    assert.equal(row.category, "otp");
  });

  test("Termii's charge lands on the same row; a message only Termii knew is added", async () => {
    const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Lagos", dateStyle: "short", timeStyle: "medium" })
      .format(new Date());
    nock(BASE)
      .get("/api/sms/inbox").query(true)
      .reply(200, [
        { message_id: `mid-${RUN}-1`, receiver: `234${PHONE.slice(1)}`, message: "Your order is ready", amount: 11.8, status: "Delivered", sms_type: "dnd", sender: "Soroman", created_at: stamp },
        { message_id: `mid-${RUN}-otp`, receiver: `234${PHONE.slice(1)}`, message: "Your Soroman verification code is 482913.", amount: 11.8, status: "Delivered", sms_type: "dnd", sender: "Soroman", created_at: stamp },
        { message_id: `mid-${RUN}-dash`, receiver: `234${PHONE.slice(1)}`, message: "Sent from the Termii dashboard, code is 7788", amount: 5.9, status: "Sent", sms_type: "plain", sender: "Soroman", created_at: stamp },
      ]);
    const result = await ledger.syncTermii({ full: true, maxPages: 1 });
    assert.equal(result.ok, true, JSON.stringify(result));

    const rows = await rowsFor();
    const sent = rows.find((r) => r.providerMessageId === `mid-${RUN}-1`);
    assert.equal(Number(sent.amount), 11.8);
    assert.equal(sent.status, "delivered");
    assert.equal(sent.origin, "app", "still the row written at send time");
    assert.equal(sent.type, `${TAG}.ready`);

    const otp = rows.find((r) => r.providerMessageId === `mid-${RUN}-otp`);
    assert.doesNotMatch(otp.body, /482913/, "the history's copy does not bring the code back");

    const dash = rows.find((r) => r.providerMessageId === `mid-${RUN}-dash`);
    assert.ok(dash, "a message sent outside the app is still in the ledger");
    assert.equal(dash.origin, "provider");
    assert.equal(Number(dash.amount), 5.9);
    assert.doesNotMatch(dash.body, /7788/);
  });

  test("each message is matched to who it went to", async () => {
    const rows = await rowsFor();
    assert.ok(rows.length >= 4);
    for (const r of rows) {
      assert.equal(r.audience, "staff", `${r.providerMessageId || r.type} went to a staff phone`);
      assert.equal(r.staffId, staffMember.id);
    }
  });

  test("the day's totals count every message and add up the charges", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
    const s = await ledger.summary({ from: today, to: today, search: PHONE.slice(-7) });
    assert.equal(s.total.messages, 4);
    assert.equal(s.total.failed, 1);
    assert.equal(Math.round(s.total.amount * 100), 2950, "11.80 + 11.80 + 5.90");
    const staffLine = s.byAudience.find((a) => a.key === "staff");
    assert.equal(staffLine.messages, 4);
    assert.equal(s.byDay[0].day, today);

    const listed = await ledger.list({ from: today, to: today, search: PHONE.slice(-7), limit: 10 });
    assert.equal(listed.pagination.total, 4);
  });
});
