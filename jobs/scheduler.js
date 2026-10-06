const { registerWorker, scheduleCron, startQueue } = require("../config/queue");
const { rolesFor } = require("../notifications/staffChoices");
const { expiryTimeOfDay, EXPIRY_TZ } = require("../config/orderExpiry");
const { expireStaleOrders } = require("../services/order.service");
const { expireStaleRequests } = require("../services/requestExpiry.service");
const { dispatchDailyReports, resolveRecipients } = require("../services/dailyReportDispatch.service");
const { notify } = require("../notifications");
const {
  runRound: runWorkReminders,
  cronExpression: workReminderCron,
  settings: workReminderSettings,
} = require("../services/workReminders.service");
const { resetPricesForTheDay } = require("../services/priceReset.service");
const { syncTermii } = require("../services/messageLog.service");

// An ad-hoc pg-boss queue created on demand, mirroring the WhatsApp maintenance
// cron — not part of the WhatsApp queue set.
const EXPIRY_QUEUE = "order-expiry-sweep";
const DAILY_REPORT_QUEUE = "daily-report-send";
/** Retired 6 Oct 2026; its schedule is removed at boot. */
const DESK_NUDGE_QUEUE = "desk-nudge-sweep";
const WORK_REMINDER_QUEUE = "work-reminders";
const PRICE_RESET_QUEUE = "depot-price-reset";
const MESSAGE_COST_QUEUE = "message-cost-sync";
const MESSAGE_COST_CRON = process.env.MESSAGE_COST_CRON || "*/30 * * * *";

/**
 * 23:59 Africa/Lagos, every day: every depot price goes to 0, so no product is
 * on sale at yesterday's price. See services/priceReset.service.js.
 */
const PRICE_RESET_CRON = process.env.PRICE_RESET_CRON || "59 23 * * *";

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
          to: { roles: rolesFor("report_failures") },
          data: { reason: err.message, at: new Date().toISOString() },
        });
      } catch (notifyErr) {
        console.error("[scheduler] could not raise the failure alert:", notifyErr.message);
      }
      throw err;
    }
  });

  await scheduleCron(DAILY_REPORT_QUEUE, DAILY_REPORT_CRON, {}, { tz: DAILY_REPORT_TZ });

  // ── Reminders of waiting work ─────────────────────────────────────────────
  //
  // The owner's rules of 6 Oct 2026 (services/workReminders.service.js): work
  // reminders every two hours 8–20, daily reports at 20 and 22, no orders at
  // 18 — to the people assigned, and nobody else. ON unless
  // WORK_REMINDERS_ENABLED=false; while switched off nothing is scheduled.
  //
  // The old 08:00 desk nudge is retired for good: it told every holder of a
  // role, assigned or not. Its schedule is removed here, and so is the
  // reminders' own while they are switched off — pg-boss keeps a schedule in its
  // own table until told otherwise, so leaving one would fire it anyway.
  //
  // Swallows its own failure: a round that did not go out is followed by the
  // next, and a retry an hour late would only arrive as a duplicate.
  const unschedule = async (queue) => {
    try {
      const boss = await startQueue();
      await boss.unschedule(queue);
    } catch {
      // Never scheduled on this database — nothing to remove.
    }
  };

  await unschedule(DESK_NUDGE_QUEUE);
  if (!workReminderSettings().enabled) {
    await unschedule(WORK_REMINDER_QUEUE);
    console.log("[scheduler] work reminders are switched off (WORK_REMINDERS_ENABLED=false)");
  } else {
    await registerWorker(WORK_REMINDER_QUEUE, async () => {
      try {
        const result = await runWorkReminders({ trigger: "schedule" });
        console.log(
          result.skipped
            ? `[scheduler] work reminders — ${result.reason}`
            : `[scheduler] work reminders ${result.round} — ${result.messages} messages to ${result.people} people, ${result.texted} texted, ${result.failed} failed`
        );
        return { round: result.round, skipped: Boolean(result.skipped) };
      } catch (err) {
        console.error("[scheduler] work reminders failed:", err.message);
        return { failed: true };
      }
    });
    await scheduleCron(WORK_REMINDER_QUEUE, workReminderCron(), {}, { tz: DAILY_REPORT_TZ });
    console.log(`[scheduler] work reminders scheduled (${workReminderCron()} ${DAILY_REPORT_TZ})`);
  }
  console.log(
    `[scheduler] daily report scheduled (${DAILY_REPORT_CRON} ${DAILY_REPORT_TZ})`
  );

  // ── The nightly price reset ───────────────────────────────────────────────
  //
  // Fails loudly, like the daily report: a reset that silently did not happen
  // leaves yesterday's prices on sale all morning, so pg-boss retries it. It is
  // idempotent — prices already at 0 are skipped — so a retry changes nothing
  // twice.
  await registerWorker(PRICE_RESET_QUEUE, async () => {
    const result = await resetPricesForTheDay();
    console.log(`[scheduler] price reset — ${result.updated} set to 0, ${result.skipped} already 0`);
    return { updated: result.updated, skipped: result.skipped };
  });
  await scheduleCron(PRICE_RESET_QUEUE, PRICE_RESET_CRON, {}, { tz: DAILY_REPORT_TZ });
  console.log(`[scheduler] price reset scheduled (${PRICE_RESET_CRON} ${DAILY_REPORT_TZ})`);

  // ── What each SMS cost ────────────────────────────────────────────────────
  //
  // Reads Termii's message history into the message ledger (migration 0064):
  // the charge on every SMS, its delivery status, and any message sent from
  // Termii's own dashboard. Swallows its failure — the next run reads the same
  // two days again, so nothing is lost by missing one.
  await registerWorker(MESSAGE_COST_QUEUE, async () => {
    const result = await syncTermii({ full: false });
    if (!result.ok) console.error("[scheduler] message cost sync failed:", result.error);
    return result;
  });
  await scheduleCron(MESSAGE_COST_QUEUE, MESSAGE_COST_CRON, {}, { tz: DAILY_REPORT_TZ });
  console.log(`[scheduler] message cost sync scheduled (${MESSAGE_COST_CRON} ${DAILY_REPORT_TZ})`);

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

module.exports = { start, EXPIRY_QUEUE, DAILY_REPORT_QUEUE, DAILY_REPORT_CRON, PRICE_RESET_QUEUE, PRICE_RESET_CRON, WORK_REMINDER_QUEUE };
