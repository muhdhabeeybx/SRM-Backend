const { registerWorker, scheduleCron } = require("../config/queue");
const { expiryTimeOfDay, EXPIRY_TZ } = require("../config/orderExpiry");
const { expireStaleOrders } = require("../services/order.service");
const { expireStaleRequests } = require("../services/requestExpiry.service");
const { dispatchDailyReports, resolveRecipients } = require("../services/dailyReportDispatch.service");
const { notify } = require("../notifications");
const { runDeskNudges } = require("../services/deskNudge.service");

// An ad-hoc pg-boss queue created on demand, mirroring the WhatsApp maintenance
// cron — not part of the WhatsApp queue set.
const EXPIRY_QUEUE = "order-expiry-sweep";
const DAILY_REPORT_QUEUE = "daily-report-send";
const DESK_NUDGE_QUEUE = "desk-nudge-sweep";

/**
 * 08:00 Africa/Lagos, every day — the start of the working day, when a desk
 * can still act on what it is told. Local time with an explicit tz for the
 * same reason the daily report uses it.
 */
const DESK_NUDGE_CRON = process.env.DESK_NUDGE_CRON || "0 8 * * *";

/**
 * 23:50 Africa/Lagos, every day.
 *
 * Written as local time with an explicit tz rather than as "50 22 * * *" UTC.
 * Nigeria has no DST so the two are equivalent today, but the UTC form is a
 * silent trap: it reads as 22:50 to anyone checking whether the report went out
 * on time, and it would break the day Nigeria ever changed its offset.
 */
const DAILY_REPORT_CRON = process.env.DAILY_REPORT_CRON || "50 23 * * *";
const DAILY_REPORT_TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";

/**
 * Opt-in in-process scheduler. Runs only when SCHEDULED_JOBS_ENABLED=true, so
 * default boot behaviour is unchanged and dev/test/CI never start it. The
 * manual POST /api/order-expiry/run endpoint stays available either way.
 *
 * Only the order-expiry sweep is scheduled here. Settlement is deliberately NOT
 * automated — it moves money and stays a gated, human/infra-triggered action
 * (see server.js and the settlement route).
 */
const start = async () => {
  await registerWorker(EXPIRY_QUEUE, async () => {
    const expired = await expireStaleOrders();
    const requests = await expireStaleRequests();
    return { expired, requests };
  });

  // ── The nightly expiry sweep ──────────────────────────────────────────────
  //
  // 23:59 Africa/Lagos, every day: unpaid orders lapse at the end of the day
  // they were placed, handing their stock reservation back before the next
  // trading day opens. See config/orderExpiry.js for why it is a day boundary
  // rather than a rolling window.
  //
  // The expression is DERIVED from the same ORDER_EXPIRY_AT that computes the
  // deadline customers are shown, so the countdown on the dashboard and the
  // job that enforces it cannot drift apart. Local time with an explicit tz,
  // for the reason spelled out on the daily report below.
  const [expiryHour, expiryMinute] = expiryTimeOfDay();
  const cron = process.env.ORDER_EXPIRY_CRON || `${expiryMinute} ${expiryHour} * * *`;
  const expiryTz = EXPIRY_TZ();
  await scheduleCron(EXPIRY_QUEUE, cron, {}, { tz: expiryTz });
  console.log(`[scheduler] order-expiry sweep scheduled (${cron} ${expiryTz})`);

  // ── The daily report ──────────────────────────────────────────────────────
  //
  // Fails loudly on purpose. Throwing hands the job back to pg-boss, which
  // retries it with backoff and finally dead-letters it; swallowing the error
  // would leave the queue believing the report went out. The send itself is
  // idempotent per report date, so a retry cannot mail the list twice.
  await registerWorker(DAILY_REPORT_QUEUE, async () => {
    try {
      const result = await dispatchDailyReports();
      console.log(
        `[scheduler] daily report ${result.reportDate} — sent [${result.sent.join(", ") || "none"}]` +
          `${result.skipped.length ? `, already sent [${result.skipped.join(", ")}]` : ""}` +
          ` to ${result.recipients.length} recipient(s)`
      );
      return result;
    } catch (err) {
      // A report nobody hears about failing is the failure. Staff get told
      // before the error is re-thrown for pg-boss to retry.
      console.error("[scheduler] daily report FAILED:", err.message);
      try {
        await notify("staff.report_send_failed", {
          to: { roles: ["admin", "super_admin"] },
          data: { reason: err.message, at: new Date().toISOString() },
        });
      } catch (notifyErr) {
        console.error("[scheduler] could not raise the failure alert:", notifyErr.message);
      }
      throw err;
    }
  });

  await scheduleCron(DAILY_REPORT_QUEUE, DAILY_REPORT_CRON, {}, { tz: DAILY_REPORT_TZ });

  // ── Desk backlogs ─────────────────────────────────────────────────────────
  //
  // Tells ticketing, the entrance gate and the exit gate what is still sitting
  // on them. Swallows its own failure rather than dead-lettering: a nudge that
  // did not go out is a nudge, not a lost report, and retrying it an hour
  // later would arrive as a duplicate of a queue that has since moved.
  await registerWorker(DESK_NUDGE_QUEUE, async () => {
    try {
      const results = await runDeskNudges();
      const said = results.filter((r) => r.notified).map((r) => `${r.desk} ${r.count}`);
      console.log(`[scheduler] desk nudges — ${said.join(", ") || "every desk clear"}`);
      return { results };
    } catch (err) {
      console.error("[scheduler] desk nudges failed:", err.message);
      return { failed: true };
    }
  });
  await scheduleCron(DESK_NUDGE_QUEUE, DESK_NUDGE_CRON, {}, { tz: DAILY_REPORT_TZ });
  console.log(`[scheduler] desk nudges scheduled (${DESK_NUDGE_CRON} ${DAILY_REPORT_TZ})`);
  console.log(
    `[scheduler] daily report scheduled (${DAILY_REPORT_CRON} ${DAILY_REPORT_TZ})`
  );

  // Say at boot whether this can actually work, rather than at 23:50 when
  // nobody is looking. An unset REPORT_RECIPIENTS is the single most likely
  // reason for a report that "just stopped arriving".
  try {
    const recipients = resolveRecipients();
    if (recipients.length === 0) {
      console.warn(
        "[scheduler] WARNING: REPORT_RECIPIENTS is empty — the daily report will fail at send time."
      );
    } else {
      console.log(`[scheduler] daily report recipients: ${recipients.length} configured`);
    }
  } catch (err) {
    console.warn(`[scheduler] WARNING: ${err.message}`);
  }
};

module.exports = { start, EXPIRY_QUEUE, DAILY_REPORT_QUEUE, DAILY_REPORT_CRON };
