/**
 * Live delivery test for the Termii DND channel.
 *
 * Sends ONE real SMS through Termii on the chosen channel (default: dnd) and
 * prints the raw provider response, so you can confirm a real DND-registered
 * number actually receives a code — the thing the mocked test suite can't
 * prove. This is a REAL, BILLABLE send; run it deliberately, not in CI.
 *
 * It reuses the app's own request shape (services/sms.service.js) and phone
 * formatter (utils/phone.js), but INTENTIONALLY ignores SMS_ENABLED — the
 * point is to actually send. Needs the production TERMII_API_KEY.
 *
 * Usage:
 *   TERMII_API_KEY=sk_live_... TERMII_SENDER_ID=SOROMAN \
 *     node scripts/termii-dnd-livetest.js --to=+2348012345678
 *
 *   # pick a channel / custom message:
 *   node scripts/termii-dnd-livetest.js --to=+234... --channel=generic
 *   node scripts/termii-dnd-livetest.js --to=+234... --message="Test 123456"
 */
require("dotenv").config();
const axios = require("axios");
const { toSmsRecipient } = require("../utils/phone");

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

(async () => {
  const base =
    arg("base") || process.env.TERMII_BASE_URL || "https://v4.api.termii.com";
  const apiKeyEarly = process.env.TERMII_API_KEY;

  // --balance: read the account's REAL wallet balance (GET /api/get-balance).
  // The `balance` echoed in a send response is unreliable (returns 0 on some
  // routes); this is the authoritative figure. A read, no SMS billed.
  if (process.argv.includes("--balance")) {
    if (!apiKeyEarly || /^plac/i.test(apiKeyEarly)) {
      console.error("Set a real TERMII_API_KEY to check the balance.");
      process.exit(1);
    }
    try {
      const r = await axios.get(`${base}/api/get-balance?api_key=${encodeURIComponent(apiKeyEarly)}`);
      const d = r.data || {};
      console.log(`Termii balance on ${base}:`);
      console.log(`  ${d.balance} ${d.currency || ""}  (account: ${d.user || d.application || "?"})`);
      process.exit(0);
    } catch (err) {
      const b = err.response?.data;
      console.error("HTTP", err.response?.status || "(no response)");
      console.error(b ? JSON.stringify(b, null, 2) : err.message);
      if (err.response?.status === 401) {
        console.error(
          "\n401 = wrong base URL for this key, or wrong key. Pass --base=<url> or set TERMII_BASE_URL."
        );
      }
      process.exit(1);
    }
  }

  // --check-senders: list the account's registered sender IDs and their status,
  // so you can confirm "Soroman" is approved on THIS base URL / account.
  if (process.argv.includes("--check-senders")) {
    if (!apiKeyEarly || /^plac/i.test(apiKeyEarly)) {
      console.error("Set a real TERMII_API_KEY to check sender IDs.");
      process.exit(1);
    }
    try {
      const r = await axios.get(`${base}/api/sender-id?api_key=${encodeURIComponent(apiKeyEarly)}`);
      console.log(`Sender IDs on ${base}:`);
      console.log(JSON.stringify(r.data, null, 2));
      process.exit(0);
    } catch (err) {
      const b = err.response?.data;
      console.error("HTTP", err.response?.status || "(no response)");
      console.error(b ? JSON.stringify(b, null, 2) : err.message);
      if (err.response?.status === 401) {
        console.error(
          "\n401 here = wrong base URL for this key, or wrong key. Get your account's" +
            " base URL from app.termii.com and pass --base=<that-url> (or set TERMII_BASE_URL)."
        );
      }
      process.exit(1);
    }
  }

  const to = arg("to");
  const channel = arg("channel", "dnd");
  const message =
    arg("message") || "Your Soroman verification code is 123456. It expires in 10 minutes.";

  if (!to) {
    console.error("Missing --to=<phone>. Example: --to=+2348012345678");
    process.exit(1);
  }
  if (!["dnd", "generic"].includes(channel)) {
    console.error(`--channel must be 'dnd' or 'generic' (got '${channel}')`);
    process.exit(1);
  }

  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey || /^plac/i.test(apiKey)) {
    console.error(
      "TERMII_API_KEY is missing or a placeholder. Run this with the REAL production key:\n" +
        "  TERMII_API_KEY=<real-key> node scripts/termii-dnd-livetest.js --to=+234..."
    );
    process.exit(1);
  }

  const recipient = toSmsRecipient(to);
  const sender = arg("from") || process.env.TERMII_SENDER_ID || "SOROMAN";

  console.log("── Termii live send ──────────────────────────────");
  console.log(`  to (formatted): ${recipient}`);
  console.log(`  from (sender) : ${sender}`);
  console.log(`  channel       : ${channel}`);
  console.log(`  endpoint      : ${base}/api/sms/send`);
  console.log(`  message       : ${message}`);
  console.log("──────────────────────────────────────────────────");

  try {
    const res = await axios.post(
      `${base}/api/sms/send`,
      { to: recipient, from: sender, sms: message, type: "plain", channel, api_key: apiKey },
      { headers: { "Content-Type": "application/json" } }
    );
    const ok = res.data.message === "Successfully Sent" || res.data.code === "ok";
    console.log("\nHTTP", res.status);
    console.log("Response:", JSON.stringify(res.data, null, 2));
    console.log(
      ok
        ? `\n✅ Termii ACCEPTED the ${channel} send. Check the handset for actual delivery.`
        : `\n⚠️  Termii did NOT accept it — message above is the reason (channel not enabled, balance, sender ID, etc.).`
    );
    process.exit(ok ? 0 : 2);
  } catch (err) {
    // Termii puts the real reason in the response body, not the HTTP status.
    const body = err.response?.data;
    console.error("\nHTTP", err.response?.status || "(no response)");
    console.error("Error body:", body ? JSON.stringify(body, null, 2) : err.message);
    const status = err.response?.status;
    if (status === 401) {
      console.error(
        "\n❌ 401 Unauthorized — this is AUTHENTICATION, not DND. Either the base URL" +
          " is wrong for this account (Termii assigns each account its own region base" +
          " URL — find it at app.termii.com and pass --base=<url> or set TERMII_BASE_URL)," +
          " or the api_key is not from that dashboard."
      );
    } else if (status === 402) {
      console.error("\n❌ 402 — Termii billing (insufficient balance).");
    } else {
      console.error(
        `\n❌ The ${channel} send failed — see the reason above. 'Channel not enabled'` +
          " would mean DND is not live on this account yet."
      );
    }
    process.exit(1);
  }
})();
