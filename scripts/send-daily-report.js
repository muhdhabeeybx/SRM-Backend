#!/usr/bin/env node
/**
 * Build and send the daily report.
 *
 *   npm run report:daily                 today's report
 *   npm run report:daily -- --date=2026-08-09
 *   npm run report:daily -- --dry        write the HTML, send nothing
 *   npm run report:daily -- --to=a@b.com,c@d.com
 *
 * Django ran these from Celery Beat. The scheduled trigger now lives in
 * jobs/scheduler.js, as a pg-boss cron at 23:50 Africa/Lagos — and it calls the
 * SAME function this script does, services/dailyReportDispatch.js. That is the
 * point: two triggers, one send path, so the scheduled report and the hand-run
 * one cannot drift apart.
 *
 * This script stays because a report sometimes has to be re-sent by hand, for a
 * past date, or previewed without mailing anybody.
 *
 *   --force  send again even though tonight's is already logged as sent
 *
 * One report goes out: the SOROMAN Sales & Operations Report — depot sales,
 * loading and exit gate, expenses, commissions, truck sales, filling stations
 * and every desk's sheet — sent as the email body itself, no attachment. The
 * depot-grouped combined report and the staff-sales .xlsx it used to send
 * alongside are both retired; see services/dailyReportDispatch.
 *
 * Recipients come from REPORT_RECIPIENTS (comma-separated) unless --to is given.
 * With neither set the script refuses rather than silently mailing nobody —
 * Django's equivalent read a ReportRecipient table that was empty on a fresh
 * install, and the reports quietly went nowhere for weeks.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { buildPfiDailyReportData } = require("../services/pfiDailyReport.service");
const { renderPfiDailyReportEmail } = require("../notifications/templates/pfiDailyReportEmail");
const { dispatchDailyReports, resolveRecipients } = require("../services/dailyReportDispatch.service");
const { client } = require("../db");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

(async () => {
  const dateArg = arg("date");
  const date = dateArg ? new Date(dateArg) : new Date();
  if (Number.isNaN(date.getTime())) {
    console.error(`Not a date: ${dateArg}`);
    process.exit(1);
  }

  const only = arg("only");
  const dry = flag("dry");
  const force = flag("force");

  // --dry never sends, so it never goes through the dispatcher: it builds the
  // same artefacts and writes them to disk for inspection.
  if (dry) {
    const data = await buildPfiDailyReportData(date);
    const { html, text, subject } = renderPfiDailyReportEmail(data);
    const out = path.join(process.cwd(), `daily-report-${data.reportDate}.html`);
    fs.writeFileSync(out, html);

    const s = data.summary;
    console.log(`→ reports.pfi_daily  ${data.reportDate}`);
    console.log(`  subject: ${subject}`);
    console.log(
      `  ${s.activePfis} active PFI(s), ${s.activeBatches} truck-sales batch(es), ` +
        `${s.activeStations} filling station(s)`
    );
    console.log(
      `  sold ${Number(s.litresSold).toLocaleString("en-NG")}  ` +
        `value ₦${Math.round(s.salesValue).toLocaleString("en-NG")}  ` +
        `received ₦${Math.round(s.fundsReceived).toLocaleString("en-NG")}`
    );
    console.log(`  text part:\n${text.split("\n").map((l) => `    ${l}`).join("\n")}`);
    // Gmail clips a message at ~102KB and the cut lands mid-table, which is the
    // one failure a daily report cannot have. Worth seeing on every dry run.
    console.log(`  html written to ${out}  (${Math.round(html.length / 1024)}KB — Gmail clips at 102KB)`);
    console.log(`  nothing sent (--dry)`);
  } else {
    const recipients = resolveRecipients(arg("to"));
    if (recipients.length === 0) {
      console.error(
        "No recipients. Set REPORT_RECIPIENTS in .env or pass --to=a@b.com.\n" +
          "Refusing to build a report nobody receives."
      );
      process.exit(1);
    }

    const result = await dispatchDailyReports({ date, to: arg("to"), only, force });
    console.log(`→ daily report ${result.reportDate}`);
    if (result.sent.length) console.log(`  sent: ${result.sent.join(", ")} → ${result.recipients.join(", ")}`);
    if (result.skipped.length) {
      console.log(
        `  skipped (already sent today): ${result.skipped.join(", ")}  — re-send with --force`
      );
    }
  }

  await client.end({ timeout: 5 });
  process.exit(0);
})().catch((err) => {
  console.error("send-daily-report failed:", err.message || err);
  process.exit(1);
});
