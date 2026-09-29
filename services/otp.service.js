const { customerOtpRepo, customerRepo } = require("../repositories");
const { sendSMSWithFallback } = require("./sms.service");
const { checkSmsEligibility, toE164 } = require("../utils/phone");

/**
 * OTP issuance for customer phone authentication and account deletion.
 *
 * Controllers own HTTP response shapes; this module owns whether an SMS should
 * leave the building, and the shared verify path so every purpose gets the
 * same attempt / consume rules.
 */

const CODE_TTL_MINUTES = 10;
const DEFAULT_DAILY_CAP = 500;

const { PURPOSE_AUTH, PURPOSE_ACCOUNT_DELETION } = customerOtpRepo;

/**
 * Per-action limits, counted from customer_otps rather than in memory.
 *
 * The per-phone budget is the precise control: it is tied to the thing being
 * attacked and cannot be evaded by rotating source addresses.
 *
 * The per-IP budget is deliberately loose — a backstop, not a gate. Nigerian
 * mobile networks use carrier-grade NAT heavily, so thousands of legitimate
 * customers can share one public address; a tight per-IP cap would lock out a
 * whole carrier during a busy hour while barely inconveniencing an attacker
 * with a proxy pool. The real bound on a distributed attack is the global
 * daily send cap, not this.
 *
 * Both are env-tunable so ops can react without a deploy.
 */
const envInt = (key, fallback) => {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

const LIMITS = {
  register: {
    get perPhone() {
      return envInt("OTP_REGISTER_PER_PHONE", 2);
    },
    get perIp() {
      return envInt("OTP_REGISTER_PER_IP", 30);
    },
    windowMinutes: 60,
  },
  login: {
    get perPhone() {
      return envInt("OTP_LOGIN_PER_PHONE", 3);
    },
    get perIp() {
      return envInt("OTP_LOGIN_PER_IP", 60);
    },
    windowMinutes: 60,
  },
  delete: {
    get perPhone() {
      return envInt("OTP_DELETE_PER_PHONE", 3);
    },
    get perIp() {
      return envInt("OTP_DELETE_PER_IP", 30);
    },
    windowMinutes: 60,
  },
};

const ACTION_PURPOSE = {
  register: PURPOSE_AUTH,
  login: PURPOSE_AUTH,
  delete: PURPOSE_ACCOUNT_DELETION,
};

/**
 * Development bypass: a fixed, predictable code and no SMS dispatch.
 *
 * It does NOT skip verification — the code is still hashed, stored, expired
 * and attempt-capped. Only generation and delivery are stubbed, so the
 * verification path under test is the production one.
 *
 * Opt-in and fail-closed: both variables must be set, and it is never inferred
 * from the absence of NODE_ENV. server.js refuses to boot if it is on in
 * production or alongside a live Paystack key.
 */
function devMode() {
  return process.env.OTP_DEV_MODE === "true" && Boolean(process.env.OTP_DEV_CODE);
}

/**
 * The fixed code, but ONLY in dev mode — for surfacing on the OTP screen so
 * testers on an environment with no live SMS can sign in. Null otherwise, and
 * dev mode cannot boot in production, so this is never exposed there.
 */
function devCode() {
  return devMode() ? process.env.OTP_DEV_CODE : null;
}

/**
 * Store-review demo account: a static OTP for one (or a few) designated
 * numbers. Unlike OTP_DEV_MODE this is allowed in production, because App
 * Store / Play reviewers cannot receive SMS, and a global bypass is not
 * acceptable. Both env vars must be set; an empty allowlist or a missing
 * code is fail-closed.
 *
 * OTP_DEMO_PHONES is comma-separated; each entry is normalised to E.164 so
 * "0803…" and "+234803…" both match the same account.
 */
function demoCode() {
  const code = process.env.OTP_DEMO_CODE;
  return typeof code === "string" && /^\d{6}$/.test(code) ? code : null;
}

function demoPhones() {
  const raw = process.env.OTP_DEMO_PHONES;
  if (!raw || !String(raw).trim() || !demoCode()) return new Set();
  return new Set(
    String(raw)
      .split(",")
      .map((p) => toE164(p.trim()))
      .filter(Boolean)
  );
}

function isDemoAccount(phone) {
  const e164 = toE164(phone);
  return Boolean(e164 && demoPhones().has(e164));
}

async function isDemoCustomer(customerId) {
  if (!demoCode() || demoPhones().size === 0) return false;
  const customer = await customerRepo.findById(customerId);
  return Boolean(customer && isDemoAccount(customer.phone));
}

function dailyCap() {
  const raw = Number(process.env.OTP_DAILY_SEND_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_CAP;
}

/**
 * Have we spent today's SMS budget?
 *
 * Every send writes a customer_otps row, so this needs no separate counter.
 * Turnstile reduces volume; only a cap bounds it — and unlike a captcha it
 * also covers retry loops, bad deploys and runaway crons.
 */
async function isOverDailyCap() {
  return (await customerOtpRepo.countToday()) >= dailyCap();
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
async function checkRateLimits(action, { customerId, requestIp }) {
  const limit = LIMITS[action];
  if (!limit) throw new TypeError(`otp.service: unknown action ${JSON.stringify(action)}`);

  if (customerId) {
    const perPhone = await customerOtpRepo.countSince({
      customerId,
      sinceMinutes: limit.windowMinutes,
    });
    if (perPhone >= limit.perPhone) return { ok: false, reason: "phone_rate_limited" };
  }

  if (requestIp) {
    const perIp = await customerOtpRepo.countSince({
      requestIp,
      sinceMinutes: limit.windowMinutes,
    });
    if (perIp >= limit.perIp) return { ok: false, reason: "ip_rate_limited" };
  }

  return { ok: true };
}

function smsBody(action, code) {
  if (action === "delete") {
    return `Your Soroman account deletion code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. If you did not request this, ignore this message.`;
  }
  return `Your Soroman verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`;
}

/**
 * Issue a code and send it.
 *
 * Returns a reason rather than throwing, because the caller answers
 * identically whatever happens here — the reason is for logs only.
 *
 * @returns {{sent: boolean, reason: string|null, capped?: boolean}}
 */
async function issueAndSend(customer, { action, requestIp, sendTo } = {}) {
  const purpose = ACTION_PURPOSE[action];
  if (!purpose) throw new TypeError(`otp.service: unknown action ${JSON.stringify(action)}`);

  /**
   * The handset this code goes to.
   *
   * Defaults to the primary, but a customer may hold several numbers and any
   * of them signs in (db/migrations/0019_customer_phone_numbers.sql). Someone
   * who typed their second line must receive the code THERE — sending to the
   * primary instead leaves them waiting on a phone they may not be holding,
   * with nothing on screen to explain why.
   *
   * Every eligibility, demo and rate-limit check below reads this rather than
   * `customer.phone`, so an alternate that cannot receive an SMS is refused on
   * its own merits instead of being waved through on the primary's.
   */
  const destination = sendTo || customer.phone;

  const useDemoAccount = isDemoAccount(destination);
  const eligibility = checkSmsEligibility(destination);
  // Demo numbers skip the SMS-capability gate: the reviewer never receives a
  // message, and a landline/VOIP misclassification must not strand review.
  if (!eligibility.ok && !useDemoAccount) return { sent: false, reason: eligibility.reason };

  if (!useDemoAccount) {
    const limited = await checkRateLimits(action, { customerId: customer.id, requestIp });
    if (!limited.ok) return { sent: false, reason: limited.reason };

    // Checked immediately before issuing, so a burst cannot slip past a stale read.
    if (await isOverDailyCap()) {
      return { sent: false, reason: "daily_cap_reached", capped: true };
    }
  }

  const useDevMode = devMode();
  const fixedCode = useDevMode
    ? process.env.OTP_DEV_CODE
    : useDemoAccount
      ? demoCode()
      : undefined;
  const { code } = await customerOtpRepo.issue(customer.id, {
    ttlMinutes: CODE_TTL_MINUTES,
    requestIp,
    purpose,
    code: fixedCode,
  });

  if (useDevMode) {
    console.warn(
      `[otp] DEV MODE: using the fixed code for customer ${customer.id} (${action}); no SMS sent.`
    );
    return { sent: true, reason: "dev_mode" };
  }

  if (useDemoAccount) {
    console.warn(
      `[otp] DEMO ACCOUNT: using the store-review code for customer ${customer.id} (${action}); no SMS sent.`
    );
    return { sent: true, reason: "demo_account" };
  }

  // sendSMSWithFallback (OTP-only helper): tries Termii `dnd` first, then
  // `generic`. Termii docs say OTP/verification traffic belongs on dnd —
  // `generic` is promotional, skips DND-registered numbers, and is blocked
  // 8PM–8AM WAT on MTN Nigeria, so a bare sendSMSTermii() (which defaults to
  // generic) silently dropped codes for exactly those customers. It also
  // soft-fails as { success: false } without throwing, so the return value
  // must be checked rather than relying on a try/catch alone.
  // Under the brand, like every other text the platform sends. This used to go
  // out as Termii's shared "N-Alert" because that ID was DND-whitelisted and
  // "Soroman" was not — but an unbranded code is one the customer cannot place,
  // and a verification code nobody recognises is a verification code nobody
  // trusts. If a DND-registered handset stops receiving codes, the whitelisting
  // is what to chase at Termii; the delivery log will say so.
  const result = await sendSMSWithFallback(destination, smsBody(action, code), {
    type: `otp.${action || "verify"}`,
    category: "otp",
    audience: "customer",
    customerId: customer.id ?? null,
    recipientName: customer.name || "",
  });

  if (!result.success) {
    // The row is already written, so the code stays valid and the customer can
    // retry. Logged, never surfaced — the response must not reveal whether a
    // send was attempted.
    //
    // `message` carries each channel's own complaint (Termii reports the real
    // reason in the response body, not the HTTP status: a 402 is "Insufficient
    // balance" only once response.data is unwrapped), so a billing or sender-ID
    // failure diagnoses itself from this one line.
    console.error(
      `[otp] SMS send failed for customer ${customer.id}: ${result.message}`
    );
    return { sent: false, reason: "send_failed" };
  }

  return { sent: true, reason: null };
}

/**
 * Shared verify path for every OTP purpose.
 *
 * @returns {{ ok: true } | { ok: false, reason: "invalid" | "exhausted" }}
 */
async function verifyCode(customerId, code, purpose = PURPOSE_AUTH) {
  if (typeof code !== "string" || !code) {
    return { ok: false, reason: "invalid" };
  }

  // Store-review bypass: the designated number always accepts the static
  // code, even if no SMS was issued or the 10-minute row has expired.
  // Reviewers sit on screens; a TTL would strand them. Checked only when
  // the submitted value equals the demo code, so other accounts pay no
  // extra lookup on a normal verify.
  if (demoCode() && code === demoCode() && (await isDemoCustomer(customerId))) {
    const liveDemo = await customerOtpRepo.findLive(customerId, purpose);
    if (liveDemo) await customerOtpRepo.consume(liveDemo.id);
    return { ok: true };
  }

  const live = await customerOtpRepo.findLive(customerId, purpose);
  if (!live) return { ok: false, reason: "invalid" };

  if (live.attempts >= customerOtpRepo.MAX_ATTEMPTS) {
    await customerOtpRepo.consume(live.id);
    return { ok: false, reason: "exhausted" };
  }

  const expected = customerOtpRepo.hashCode(customerId, code);
  if (expected !== live.codeHash) {
    const updated = await customerOtpRepo.recordFailedAttempt(live.id);
    if (updated && updated.attempts >= customerOtpRepo.MAX_ATTEMPTS) {
      await customerOtpRepo.consume(live.id);
    }
    return { ok: false, reason: "invalid" };
  }

  const consumed = await customerOtpRepo.consume(live.id);
  if (!consumed) return { ok: false, reason: "invalid" };

  return { ok: true };
}

module.exports = {
  CODE_TTL_MINUTES,
  LIMITS,
  PURPOSE_AUTH,
  PURPOSE_ACCOUNT_DELETION,
  devMode,
  devCode,
  demoCode,
  isDemoAccount,
  dailyCap,
  isOverDailyCap,
  checkRateLimits,
  issueAndSend,
  verifyCode,
};
