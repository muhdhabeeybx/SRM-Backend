// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const nock = require("nock");

const { eq } = require("drizzle-orm");
const botCheck = require("../services/botCheck.service");
const { sendSMSTermii, route, MESSAGE_CLASS } = require("../services/sms.service");
const otpService = require("../services/otp.service");
const { customerOtpRepo, customerRepo } = require("../repositories");
const { db } = require("../config/db");
const { customerOtps } = require("../db/schema");
const { closeDb } = require("./helpers");

const TURNSTILE_HOST = "https://challenges.cloudflare.com";
const TURNSTILE_PATH = "/turnstile/v0/siteverify";
// Termii v4 base URL — the default sms.service uses when TERMII_BASE_URL is unset.
const TERMII_HOST = "https://v4.api.termii.com";
const TERMII_PATH = "/api/sms/send";

/**
 * Real network is blocked here (loopback to Postgres/the app stays allowed), so
 * a mock that doesn't match fails loudly instead of reaching Termii/Cloudflare
 * for real — the exact trap that let a stale mock URL hit production Termii.
 * SMS is force-enabled because the wider suite runs with SMS_ENABLED=false, but
 * this file's whole job is to exercise the real send path against the mocks.
 */
describe("external boundaries — Turnstile and Termii", () => {
  const ORIGINAL_SMS_ENABLED = process.env.SMS_ENABLED;
  const ORIGINAL_BASE_URL = process.env.TERMII_BASE_URL;

  before(() => {
    process.env.SMS_ENABLED = "true";
    // Pinned to the host the mocks below are registered against. A developer
    // whose .env points TERMII_BASE_URL at another Termii region would
    // otherwise fail every test in this file with "Disallowed net connect",
    // which reads as a broken sender rather than a mismatched fixture.
    process.env.TERMII_BASE_URL = TERMII_HOST;
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  after(async () => {
    nock.enableNetConnect();
    if (ORIGINAL_SMS_ENABLED === undefined) delete process.env.SMS_ENABLED;
    else process.env.SMS_ENABLED = ORIGINAL_SMS_ENABLED;
    if (ORIGINAL_BASE_URL === undefined) delete process.env.TERMII_BASE_URL;
    else process.env.TERMII_BASE_URL = ORIGINAL_BASE_URL;
    await closeDb();
  });

  // --- Turnstile -----------------------------------------------------------

  describe("botCheck.verify", () => {
    const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;

    beforeEach(() => {
      process.env.TURNSTILE_SECRET_KEY = "test-secret";
    });

    afterEach(() => {
      if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
      else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
    });

    test("is skipped entirely when no secret is configured", async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      // No interceptor registered: if this made a request it would fail.
      const result = await botCheck.verify("any-token", "1.2.3.4");
      assert.deepEqual(result, { ok: true, skipped: true });
    });

    test("accepts a token Cloudflare confirms", async () => {
      nock(TURNSTILE_HOST).post(TURNSTILE_PATH).reply(200, { success: true });
      const result = await botCheck.verify("good-token", "1.2.3.4");
      assert.equal(result.ok, true);
      assert.equal(result.skipped, undefined);
    });

    test("sends the secret, the token and the caller's IP", async () => {
      let received;
      nock(TURNSTILE_HOST)
        .post(TURNSTILE_PATH, (body) => {
          received = body;
          return true;
        })
        .reply(200, { success: true });

      await botCheck.verify("tok-123", "203.0.113.9");

      // Sent as form encoding, which is what the endpoint expects.
      const params = new URLSearchParams(received);
      assert.equal(params.get("secret"), "test-secret");
      assert.equal(params.get("response"), "tok-123");
      assert.equal(params.get("remoteip"), "203.0.113.9");
    });

    test("rejects a token Cloudflare refuses, surfacing the error codes", async () => {
      nock(TURNSTILE_HOST)
        .post(TURNSTILE_PATH)
        .reply(200, { success: false, "error-codes": ["invalid-input-response", "timeout-or-duplicate"] });

      const result = await botCheck.verify("bad-token", "1.2.3.4");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "invalid-input-response,timeout-or-duplicate");
    });

    test("rejects a missing token without calling Cloudflare", async () => {
      const result = await botCheck.verify(undefined, "1.2.3.4");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "missing_token");
      assert.equal(nock.pendingMocks().length, 0, "no request should have been attempted");
    });

    test("FAILS OPEN when Cloudflare is unreachable", async () => {
      // The deliberate choice: blocking every signup during a third-party
      // outage is worse than absorbing some bots, and the daily send cap still
      // bounds the cost. Previously asserted only by a code comment.
      nock(TURNSTILE_HOST).post(TURNSTILE_PATH).replyWithError("ECONNREFUSED");

      const result = await botCheck.verify("tok", "1.2.3.4");
      assert.equal(result.ok, true, "must not block the request");
      assert.equal(result.degraded, true, "but must mark itself degraded");
    });

    test("FAILS OPEN on a Cloudflare 5xx", async () => {
      nock(TURNSTILE_HOST).post(TURNSTILE_PATH).reply(503, "upstream unavailable");
      const result = await botCheck.verify("tok", "1.2.3.4");
      assert.equal(result.ok, true);
      assert.equal(result.degraded, true);
    });

    test("FAILS OPEN on timeout", async () => {
      nock(TURNSTILE_HOST).post(TURNSTILE_PATH).delayConnection(9000).reply(200, { success: true });
      const result = await botCheck.verify("tok", "1.2.3.4");
      assert.equal(result.ok, true);
      assert.equal(result.degraded, true);
    });

    test("a malformed Cloudflare body is treated as a rejection, not a pass", async () => {
      // Absence of success:true must never read as success.
      nock(TURNSTILE_HOST).post(TURNSTILE_PATH).reply(200, { unexpected: "shape" });
      const result = await botCheck.verify("tok", "1.2.3.4");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "rejected");
    });
  });

  // --- Termii --------------------------------------------------------------

  describe("sendSMSTermii", () => {
    test("is actually exported", () => {
      // Regression guard: it was imported by name in otp.service but never
      // exported, so it silently resolved to undefined and every real OTP send
      // threw into a catch block that answered 200 anyway.
      assert.equal(typeof sendSMSTermii, "function");
    });

    test("posts the payload Termii expects", async () => {
      let body;
      nock(TERMII_HOST)
        .post(TERMII_PATH, (b) => {
          body = b;
          return true;
        })
        .reply(200, { message: "Successfully Sent" });

      process.env.TERMII_SENDER_ID = "SOROMAN";
      const result = await sendSMSTermii("08012345678", "Your code is 123456");

      assert.equal(result.success, true);
      assert.equal(body.to, "2348012345678", "E.164 digits with no leading +");
      assert.equal(body.from, "SOROMAN");
      assert.equal(body.sms, "Your code is 123456");
      assert.equal(body.type, "plain");
      assert.equal(body.channel, "generic");
      assert.ok("api_key" in body);
    });

    test("formats an international recipient correctly", async () => {
      let body;
      nock(TERMII_HOST)
        .post(TERMII_PATH, (b) => {
          body = b;
          return true;
        })
        .reply(200, { code: "ok" });

      await sendSMSTermii("+447400123456", "hello");
      assert.equal(body.to, "447400123456", "not coerced to a Nigerian prefix");
    });

    test("reports failure when Termii declines", async () => {
      nock(TERMII_HOST).post(TERMII_PATH).reply(200, { message: "Insufficient balance" });
      const result = await sendSMSTermii("08012345678", "hi");
      assert.equal(result.success, false);
      assert.equal(result.message, "Insufficient balance");
    });
  });

  // --- route: which Termii route, under which sender ----------------------

  describe("route", () => {
    const ORIGINAL = {
      sender: process.env.TERMII_SENDER_ID,
      promo: process.env.TERMII_PROMO_ON_DND,
    };

    beforeEach(() => {
      process.env.TERMII_SENDER_ID = "SOROMAN";
      delete process.env.TERMII_PROMO_ON_DND;
    });

    afterEach(() => {
      for (const [key, value] of [
        ["TERMII_SENDER_ID", ORIGINAL.sender],
        ["TERMII_PROMO_ON_DND", ORIGINAL.promo],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    /** Every send Termii was asked to make, in order. */
    const recordSends = (replies) => {
      const seen = [];
      let i = 0;
      nock(TERMII_HOST)
        .post(TERMII_PATH, (b) => {
          seen.push({ channel: b.channel, from: b.from });
          return true;
        })
        .times(replies.length)
        .reply(200, () => replies[i++]);
      return seen;
    };

    test("a transactional message tries dnd FIRST", async () => {
      // The whole point. `generic` never reaches a DND-registered handset, and
      // roughly a third of Nigerian numbers are on the register — an order's
      // payment instructions sent generic-first are ones those customers never
      // see.
      const seen = recordSends([{ message: "Successfully Sent", message_id: "m-1" }]);

      const result = await route("08012345678", "Please pay N500,000", {
        messageClass: MESSAGE_CLASS.TRANSACTIONAL,
      });

      assert.equal(result.success, true);
      assert.equal(result.channel, "dnd");
      assert.equal(result.messageId, "m-1");
      assert.deepEqual(seen, [{ channel: "dnd", from: "SOROMAN" }]);
    });

    test("transactional falls back to generic", async () => {
      const seen = recordSends([
        { message: "DND Active on phone number" },
        { message: "Successfully Sent", message_id: "m-2" },
      ]);

      const result = await route("08012345678", "Your ticket is ready", {
        messageClass: MESSAGE_CLASS.TRANSACTIONAL,
      });

      assert.equal(result.success, true);
      assert.equal(result.channel, "generic");
      assert.deepEqual(seen, [
        { channel: "dnd", from: "SOROMAN" },
        { channel: "generic", from: "SOROMAN" },
      ]);
    });

    test("a promotional message never touches the dnd route", async () => {
      // A DND registration IS the opt-out from marketing. Routing promos
      // around it is what gets a sender ID's DND approval revoked — and the
      // OTPs ride on that same approval.
      const seen = recordSends([{ message: "Successfully Sent", message_id: "m-3" }]);

      const result = await route("08012345678", "Half price this weekend", {
        messageClass: MESSAGE_CLASS.PROMOTIONAL,
      });

      assert.equal(result.success, true);
      assert.deepEqual(seen, [{ channel: "generic", from: "SOROMAN" }]);
    });

    test("TERMII_PROMO_ON_DND opens the dnd route to promos", async () => {
      process.env.TERMII_PROMO_ON_DND = "true";
      const seen = recordSends([{ message: "Successfully Sent", message_id: "m-4" }]);

      await route("08012345678", "Half price this weekend", {
        messageClass: MESSAGE_CLASS.PROMOTIONAL,
      });

      assert.deepEqual(seen, [{ channel: "dnd", from: "SOROMAN" }]);
    });

    test("defaults to transactional when no class is given", async () => {
      // A caller that forgets is far likelier to be sending a receipt than an
      // advert, and the cost of guessing wrong is a customer who never learns
      // where to pay.
      const seen = recordSends([{ message: "Successfully Sent" }]);
      await route("08012345678", "hello");
      assert.equal(seen[0].channel, "dnd");
    });

    test("every leg goes out under the one branded sender", async () => {
      // There is no per-route or per-message sender any more. The dnd leg used
      // to ride Termii's shared "N-Alert" because the brand was not
      // DND-whitelisted; an unbranded text is one the customer cannot place,
      // so the brand goes on both legs and the whitelisting is Termii's side
      // to fix.
      process.env.TERMII_SENDER_ID = "SOROMAN";
      const seen = recordSends([{ message: "Insufficient balance" }, { message: "Successfully Sent" }]);

      await route("08012345678", "Your code is 123456");

      assert.deepEqual(seen, [
        { channel: "dnd", from: "SOROMAN" },
        { channel: "generic", from: "SOROMAN" },
      ]);
      assert.ok(!seen.some((a) => /alert/i.test(a.from)), "no shared Termii sender ID survives");
    });

    test("both routes' complaints survive into one error", async () => {
      recordSends([{ message: "DND rejected" }, { message: "Insufficient balance" }]);
      const result = await route("08012345678", "hi");
      assert.equal(result.success, false);
      assert.match(result.message, /dnd: DND rejected/);
      assert.match(result.message, /generic: Insufficient balance/);
    });

    test("SMS_ENABLED=false stops after one leg and stays honest", async () => {
      // Reported as disabled, not as a two-route failure: "dnd: … | generic: …"
      // in the delivery log reads as a DND problem when it is an ops one, and
      // the second attempt could only produce the same refusal twice.
      process.env.SMS_ENABLED = "false";
      try {
        const result = await route("08012345678", "hi");
        assert.equal(result.success, false);
        assert.equal(result.disabled, true);
      } finally {
        process.env.SMS_ENABLED = "true";
      }
    });
  });

  // --- the real OTP send path ---------------------------------------------

  describe("otp.service with the dev bypass OFF", () => {
    const ORIGINAL_DEV = process.env.OTP_DEV_MODE;
    let customer;

    before(async () => {
      customer = await customerRepo.findByPhone("+2348122000001");
      if (!customer) {
        customer = await customerRepo.create({
          name: "SMS Path Fixture",
          phone: "+2348122000001",
          status: "Active",
        });
      }
    });

    beforeEach(async () => {
      // The suite normally runs with the bypass on, which skips dispatch
      // entirely — so this whole path was previously never executed.
      process.env.OTP_DEV_MODE = "false";
      // Both tests here send a login OTP to the one fixture phone, and the
      // per-phone rate window is 60 min. Clear the fixture's history (not just
      // the live code) so a rerun within the hour starts under the cap.
      await db.delete(customerOtps).where(eq(customerOtps.customerId, customer.id));
    });

    afterEach(() => {
      process.env.OTP_DEV_MODE = ORIGINAL_DEV;
    });

    test("issues a random code and dispatches it over SMS", async () => {
      let body;
      nock(TERMII_HOST)
        .post(TERMII_PATH, (b) => {
          body = b;
          return true;
        })
        .reply(200, { message: "Successfully Sent" });

      const result = await otpService.issueAndSend(customer, {
        action: "login",
        requestIp: "203.0.113.10",
      });

      assert.equal(result.sent, true);
      assert.equal(result.reason, null);
      assert.equal(body.channel, "dnd", "OTP prefers Termii dnd over generic");
      assert.equal(body.from, "SOROMAN", "an OTP is branded like every other text");

      const sentCode = body.sms.match(/\b(\d{6})\b/)?.[1];
      assert.ok(sentCode, `no 6-digit code found in: ${body.sms}`);
      assert.notEqual(sentCode, process.env.OTP_DEV_CODE, "a real random code, not the dev one");

      // The code that went out is the one that verifies.
      const live = await customerOtpRepo.findLive(customer.id);
      assert.equal(live.codeHash, customerOtpRepo.hashCode(customer.id, sentCode));
    });

    test("a failed dispatch leaves the code usable and reports the reason", async () => {
      // OTP tries dnd then generic; both must fail for send_failed.
      nock(TERMII_HOST).post(TERMII_PATH).twice().replyWithError("network down");

      const result = await otpService.issueAndSend(customer, {
        action: "login",
        requestIp: "203.0.113.11",
      });

      assert.equal(result.sent, false);
      assert.equal(result.reason, "send_failed");
      assert.ok(
        await customerOtpRepo.findLive(customer.id),
        "the row stays live so the customer can retry rather than being stuck"
      );
    });

    test("an SMS-incapable number is refused before any dispatch", async () => {
      const tollFree = { id: customer.id, phone: "+2348000000001" };
      const result = await otpService.issueAndSend(tollFree, {
        action: "login",
        requestIp: "203.0.113.12",
      });

      assert.equal(result.sent, false);
      assert.match(result.reason, /not_sms_capable/);
      assert.equal(nock.pendingMocks().length, 0, "no Termii call attempted");
    });
  });
});
