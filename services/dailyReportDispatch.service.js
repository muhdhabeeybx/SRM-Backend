/**
 * Sending the daily report — the one path, used by both callers.
 *
 * There are two triggers: `scripts/send-daily-report.js`, run by hand, and the
 * pg-boss cron in jobs/scheduler.js that fires at 23:50 Africa/Lagos. They must
 * do the same thing. Kept as two implementations they would drift, which is how
 * the SMS copy ended up with the same message written two different ways; the
 * script is now a thin CLI over this module.
 *
 * What "without failure" actually requires, and where each part lives:
 *
 *   the job runs at all      pg-boss cron, DB-coordinated so it fires once even
 *                            across several Railway instances (jobs/scheduler)
 *   transient faults retry   pg-boss retryLimit/retryBackoff (config/queue)
 *   it cannot send twice     the idempotency check below, keyed on the report
 *                            date, because a retry after a PARTIAL success
 *                            would otherwise re-send to everyone
 *   failure is noticed       dispatchDailyReports throws, the queue dead-letters,
 *                            and jobs/scheduler raises staff.report_send_failed
 *
 * The piece people forget is the third: a retry is only safe if the work is
 * idempotent, and "send an email" is not.
 */
const { notifyAndWait } = require("../notifications");
const { buildPfiDailyReportData } = require("./pfiDailyReport.service");
const { dayBounds } = require("./dailyCombinedReport.service");
const { client } = require("../db");

/**
 * One report goes out at night, and it is the Sales & Operations Report.
 *
 * There were two. The depot-grouped combined report was the body of the mail,
 * and a second mail carried the staff-sales workbook as an .xlsx and nothing
 * else. Both are retired here:
 *
 *   * the nightly body is now the per-PFI report (`reports.pfi_daily`) — the
 *     same one the Reports Hub's button has been sending, so the scheduled
 *     report and the hand-sent one are finally the same document. The old
 *     format stays in the code behind `reports.hub_email`, unscheduled.
 *   * the workbook mail is gone. The report body now carries everything it
 *     held, and the Hub's Download button still produces the file for anyone
 *     who wants to work the numbers at a desk.
 *
 * There is deliberately no STAFF_SALES name left to pass. An `--only=staff-sales`
 * still in somebody's shell history now throws by name below, rather than
 * matching nothing and quietly sending the daily report in its place — which is
 * what the old `only !== STAFF_SALES` shape would have done.
 */
const REPORTS = Object.freeze({ DAILY: "daily" });

/**
 * Who gets it.
 *
 * REPORT_RECIPIENTS, comma-separated. There is deliberately no fallback: the
 * Django version read a ReportRecipient table that was empty on a fresh
 * install and the reports went nowhere for weeks, so an unset value is an
 * error rather than a quiet no-op.
 */
const resolveRecipients = (override) => {
  const raw = override || process.env.REPORT_RECIPIENTS || "";
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const bad = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad.length) {
    throw new Error(`REPORT_RECIPIENTS contains invalid address(es): ${bad.join(", ")}`);
  }
  return list;
};

/**
 * Has this report already gone out today?
 *
 * pg-boss retries a failed job, and a job can fail AFTER the mail is away — a
 * dropped database connection while writing the log, say. Without this, one
 * bad night would mail the whole recipient list the same report four times.
 *
 * The marker is an audit row rather than a new table: the audit log already
 * exists, is already backed up, and the question "did tonight's report go?" is
 * exactly the kind of thing it is for.
 */

/**
 * `audit_logs.entity_id` is an integer, so the report date is carried as one:
 * 2026-09-04 → 20260904. Readable in the trail, sorts correctly, and well
 * inside int4. The kind of report goes in `action` rather than the metadata so
 * the check is a plain indexed lookup rather than a jsonb probe.
 *
 * `actor_type` is NOT NULL and guarded by a CHECK that permits 'system' only
 * with both actor ids null — which is exactly what a cron send is.
 */
const dateKey = (reportDate) => Number(reportDate.replace(/-/g, ""));
const ACTION = { [REPORTS.DAILY]: "report.sent.daily" };

const alreadySent = async (reportDate, kind) => {
  const rows = await client`
    SELECT 1 FROM audit_logs
     WHERE entity_type = 'daily_report'
       AND entity_id   = ${dateKey(reportDate)}
       AND action      = ${ACTION[kind]}
     LIMIT 1`;
  return rows.length > 0;
};

const markSent = async (reportDate, kind, recipients) => {
  await client`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
    VALUES (
      'daily_report',
      ${dateKey(reportDate)},
      ${ACTION[kind]},
      'system',
      ${JSON.stringify({ reportDate, recipients, sentAt: new Date().toISOString() })}::jsonb,
      NOW()
    )`;
};

/**
 * Build and send the daily reports for a date.
 *
 * @param {object}  opts
 * @param {Date}    [opts.date]        defaults to now
 * @param {string}  [opts.to]          comma-separated override
 * @param {string}  [opts.only]        one of REPORTS, or omit
 * @param {boolean} [opts.force]       send even if already logged as sent
 * @returns {Promise<{reportDate, sent: string[], skipped: string[], recipients: string[]}>}
 * @throws if there are no recipients, or if any send fails
 */
const dispatchDailyReports = async ({ date = new Date(), to, only, force = false } = {}) => {
  const recipients = resolveRecipients(to);
  if (recipients.length === 0) {
    throw new Error(
      "No recipients. Set REPORT_RECIPIENTS, or pass --to=a@b.com. " +
        "Refusing to build a report nobody receives."
    );
  }

  const { dayStr: reportDate } = dayBounds(date);
  const addressed = recipients.map((email) => ({ email }));
  const sent = [];
  const skipped = [];

  if (only && only !== REPORTS.DAILY) {
    // Loudly, rather than sending the daily report to a caller who asked for
    // something else. See REPORTS above.
    throw new Error(`Unknown report "${only}". The only report is "${REPORTS.DAILY}".`);
  }

  if (!force && (await alreadySent(reportDate, REPORTS.DAILY))) {
    skipped.push(REPORTS.DAILY);
  } else {
    const data = await buildPfiDailyReportData(date);
    await notifyAndWait("reports.pfi_daily", { to: addressed, data });
    await markSent(reportDate, REPORTS.DAILY, recipients);
    sent.push(REPORTS.DAILY);
  }

  return { reportDate, sent, skipped, recipients };
};

module.exports = { dispatchDailyReports, resolveRecipients, alreadySent, REPORTS };
