const { client } = require("../../config/db");
const { scopedPfiIds } = require("../../lib/pfiScope");

/*
  Staff assigned to a PFI see its reports and the ones they filed themselves
  — the same rule the list applies. A report outside that reads as not found.
*/
const pfiNumbersFor = async (user) => {
  const ids = scopedPfiIds(user);
  if (!ids) return null;
  const rows = await client`SELECT pfi_number FROM pfis WHERE id = ANY(${ids}::int[])`;
  // Trimmed, the way dailyReport.service resolves a report's PFI.
  return rows.map((r) => String(r.pfi_number || "").trim());
};
const samePfi = (numbers, value) => numbers.includes(String(value ?? "").trim());
const reportVisible = async (user, report) => {
  const numbers = await pfiNumbersFor(user);
  if (numbers === null) return true;
  if (Number(report.submittedBy) === Number(user?.id)) return true;
  return samePfi(numbers, report.pfiNumber);
};
const reportNotFound = (res) => res.status(404).json({ success: false, message: "Report not found" });
const visibleOr404 = async (req, res) => {
  const report = await dailyReportRepo.findById(req.params.id);
  if (report && !(await reportVisible(req.user, report))) { reportNotFound(res); return false; }
  return true;
};
const asyncHandler = require("express-async-handler");
const { dailyReportRepo } = require("../../repositories");
const dailyReportService = require("../../services/dailyReport.service");
const reportActuals = require("../../services/reportActuals.service");
const { sendServiceResult } = require("../../utils/serviceResult");
const { staffActor } = require("../../utils/actor");
const { notifyAndWait } = require("../../notifications");
const { sendDailyReportToWhatsApp } = require("../../services/whatsappReport.service");
const { buildPfiDailyReportData } = require("../../services/pfiDailyReport.service");
const { renderPfiDailyReportEmail } = require("../../notifications/templates/pfiDailyReportEmail");
const reportReminders = require("../../services/reportReminders.service");

// Roles that manage reports rather than file them — the Reports Hub's own
// allowed-roles list (see rbac.ts '/admin-reports'). Everyone else only ever
// sees their own submissions, no matter what the query string asks for:
// trusting a client-supplied submittedBy here would let any reporting role
// read any other filer's numbers by hand-editing the request.
const CAN_VIEW_ALL_REPORTS = new Set([
  "admin",
  "super_admin",
  "audit",
  "expenditure_officer",
  // Owns the CFO stage of the expense chain and is treated as oversight
  // alongside audit throughout — see ALL_EXPENSES_ROLES in lib/expenseChain.js.
  "finance",
]);

const getDailyReports = asyncHandler(async (req, res) => {
  const roles = new Set(req.user?.roles || []);
  const canViewAll = [...roles].some((r) => CAN_VIEW_ALL_REPORTS.has(r));
  const result = await dailyReportRepo.findAll({
    ...req.query,
    submittedBy: canViewAll ? req.query.submittedBy : req.user?.id,
    // A role that oversees reports still only sees their assigned
    // locations/PFIs once an admin has scoped them — the role check alone
    // predates location/PFI scope and doesn't know about it.
    scopeUser: canViewAll ? req.user : null,
  });
  res.json({ success: true, data: result });
});

const getDailyReportById = asyncHandler(async (req, res) => {
  const report = await dailyReportRepo.findById(req.params.id);
  if (!report || !(await reportVisible(req.user, report))) return reportNotFound(res);
  res.json({ success: true, data: { report } });
});

/**
 * What the system holds for a PFI on a date — read live while a report is
 * being typed, so the filer sees the comparison before they submit rather
 * than a reviewer finding it afterwards.
 *
 * Read-only and never authoritative: it is shown beside what is being entered
 * and never written over it. See services/reportActuals.service.js.
 */
const getReportActuals = asyncHandler(async (req, res) => {
  const { date, pfiId, pfiNumber } = req.query;
  if (!date) {
    return res.status(400).json({ success: false, message: "A date is required" });
  }

  /**
   * The batch may be named rather than numbered.
   *
   * The entry form knows the id, because the filer picked the batch from a
   * list. The Reports Hub does not — a filed report stores the PFI NUMBER as
   * text, and asking the Hub to resolve a dozen of those to ids before it
   * could check anything would mean a second round trip per report. So both
   * are accepted.
   *
   * A NAMED BATCH THAT CANNOT BE RESOLVED ANSWERS NOTHING. Falling back to the
   * whole day here looks like it is being helpful and is the worst thing this
   * endpoint can do: every report asking about a different batch gets the same
   * company-wide figure back, so five locations all read "system 36" and the
   * comparison quietly becomes a lie. Better to say there is nothing to check
   * against and let the page show it as unchecked.
   */
  let id = pfiId ? Number(pfiId) : null;
  if (!id && pfiNumber) {
    id = await dailyReportService.pfiIdForNumber(String(pfiNumber));
    if (!id) {
      return res.json({
        success: true,
        data: {
          actuals: {
            date: String(date),
            pfiId: null,
            unresolvedPfi: String(pfiNumber),
            fields: null,
            context: null,
          },
        },
      });
    }
  }

  // The system's figures for a PFI are that PFI's business only.
  const scoped = scopedPfiIds(req.user);
  if (scoped && (!id || !scoped.includes(Number(id)))) {
    return res.status(403).json({ success: false, message: "That PFI is not yours." });
  }

  const actuals = await reportActuals.forReport({ date: String(date), pfiId: id });
  res.json({ success: true, data: { actuals } });
});

const submitDailyReport = asyncHandler(async (req, res) => {
  const numbers = await pfiNumbersFor(req.user);
  if (numbers !== null && !samePfi(numbers, req.body?.pfiNumber ?? req.body?.pfi_number)) {
    return res.status(403).json({ success: false, message: "You can only file reports for your PFI." });
  }
  const result = await dailyReportService.submitReport(req.body, { actor: staffActor(req) });
  sendServiceResult(res, result, { successStatus: 201, message: "Report submitted" });
});

const amendDailyReport = asyncHandler(async (req, res) => {
  if (!(await visibleOr404(req, res))) return;
  // Nor may an amendment move it onto another PFI.
  const numbers = await pfiNumbersFor(req.user);
  if (numbers !== null && req.body?.pfiNumber !== undefined && !samePfi(numbers, req.body.pfiNumber)) {
    return res.status(403).json({ success: false, message: "You can only file reports for your PFI." });
  }
  const result = await dailyReportService.amendReport(req.params.id, req.body, {
    actor: staffActor(req),
  });
  sendServiceResult(res, result, { message: "Report amended" });
});

const reviewDailyReport = asyncHandler(async (req, res) => {
  if (!(await visibleOr404(req, res))) return;
  const result = await dailyReportService.reviewReport(req.params.id, req.body, {
    actor: staffActor(req),
  });
  sendServiceResult(res, result, {
    message: req.body.approve ? "Report approved" : "Report rejected",
  });
});

/**
 * Remove a report. Only the person who filed it, or an admin.
 *
 * Role gating upstream was client-side only — localStorage decided which panel
 * rendered and the API enforced nothing, so any signed-in user could file or
 * remove any report type by hand.
 */
const deleteDailyReport = asyncHandler(async (req, res) => {
  if (!(await visibleOr404(req, res))) return;
  const existing = await dailyReportRepo.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: "Report not found" });

  const roles = new Set(req.user?.roles || []);
  const mine = Number(existing.submittedBy) === Number(req.user?.id);
  if (!mine && !roles.has("admin") && !roles.has("super_admin")) {
    return res.status(403).json({ success: false, message: "You can only delete your own reports" });
  }

  await dailyReportRepo.remove(existing.id);
  res.json({ success: true, message: "Report deleted" });
});

/**
 * The Hub's "Email report" button. Builds the same combined report as the
 * scheduled job (`scripts/send-daily-report.js`) for whatever date the admin
 * is looking at, and sends it to a recipient list typed in on the spot
 * rather than a fixed env var. The email is the readable summary and nothing
 * else — no attachment, and the location/PFI filter is ignored, since the
 * combined report already covers every depot for the date in one email.
 */
/**
 * The day's trading as a WhatsApp message, sent when somebody presses send.
 *
 * Text only and no attachment: this is read on a phone, and a workbook there
 * is a file nobody opens. Manual rather than scheduled for the same reason the
 * email is not — an email waits in an inbox, a WhatsApp message interrupts, so
 * who gets interrupted is a decision rather than a cron expression.
 */
const whatsappDailyReports = asyncHandler(async (req, res) => {
  const { recipients, reportDate, preview } = req.body;

  const result = await sendDailyReportToWhatsApp({ date: reportDate, recipients, preview });

  // A preview resolved everything and sent nothing, so it is a success with an
  // empty `sent` — which the partial-success rule below would otherwise read
  // as a total failure.
  if (result.preview) {
    return res.json({
      success: true,
      message: result.templateName
        ? `Would send template "${result.templateName}" with ${result.parameters.length} parameter${result.parameters.length === 1 ? "" : "s"}`
        : "Would send as plain text",
      data: result,
    });
  }

  /**
   * Always 200 on a request that was understood and carried out.
   *
   * This used to answer 502 when nothing sent, which was wrong twice over.
   * A gateway error describes infrastructure, and the commonest reason for
   * sending nothing is a setting — WHATSAPP_ENABLED being off. Worse, a
   * non-2xx makes the browser client throw, so the per-recipient reasons in
   * `failed` were discarded and the operator saw "502 Bad Gateway" with no
   * hint of the cause. The outcome belongs in the body, where it can be read.
   *
   * Partial success is still reported as partial: a send that reached two of
   * five managers and said "sent" is how the desk ends up believing somebody
   * was told something they never saw.
   */
  /**
   * When nothing sent, the headline IS the reason.
   *
   * "Could not send to any of those numbers" reads as a fact about the numbers,
   * and it never was: every real cause so far has been one fact about the
   * system — a template whose parameter count Meta rejects, an expired token,
   * a sender not registered. The numbers were fine. So an operator retyped
   * them, got the same sentence, and had nowhere else to go, while
   * `failed[].error` carried Meta's own words in the body the whole time.
   *
   * Every recipient fails for the same reason in practice, so the distinct
   * reasons are almost always one. Say it. Only fall back to the generic line
   * when there is genuinely no error text to show.
   */
  const reasons = [...new Set(result.failed.map((f) => f.error).filter(Boolean))];

  const ok = result.sent.length > 0;
  const message = ok
    ? `Sent to ${result.sent.length} number${result.sent.length === 1 ? "" : "s"}` +
      (result.failed.length ? `, ${result.failed.length} failed` : "")
    : result.disabled
      ? "WhatsApp sending is switched off — set WHATSAPP_ENABLED=true to send"
      : result.configHint
        // The template mismatch names its own fix; repeating the generic
        // "could not send" over it would bury the useful half.
        ? `${reasons[0] || "Template mismatch"}. ${result.configHint}`
        : reasons.length === 1
          ? `Could not send: ${reasons[0]}`
          : reasons.length > 1
            ? `Could not send. ${reasons.join(" / ")}`
            : "Could not send to any of those numbers";

  res.json({ success: ok, message, data: result });
});

/**
 * The Sales & Operations Report as data, for the Reports Hub to draw on screen.
 *
 * The very object the email is rendered from — same builder, same date
 * handling as emailDailyReports below — so what the Hub shows for a day is
 * what "Email report" sends for it. Two builders would be two reports.
 */
const getOperationsReport = asyncHandler(async (req, res) => {
  const { date } = req.validated?.query || req.query;
  const report = await buildPfiDailyReportData(new Date(`${date}T12:00:00Z`));
  res.json({ success: true, data: { report } });
});

/**
 * Every desk on every live batch for a day: filed, or who has not filed it.
 */
const getOutstandingReports = asyncHandler(async (req, res) => {
  const { date } = req.validated?.query || req.query;
  const data = await reportReminders.outstandingReports(date);
  res.json({ success: true, data });
});

/**
 * Text officers about the reports they have not filed. With dryRun, the
 * exact messages and nothing sent — the dialog shows them before Send.
 */
const sendReportReminders = asyncHandler(async (req, res) => {
  const { date, targets, note, dryRun } = req.body;
  const data = await reportReminders.sendReminders(
    { date, targets, note, dryRun: dryRun === true },
    { actor: staffActor(req) },
  );
  if (dryRun) return res.json({ success: true, data });
  const sent = data.results.filter((r) => r.ok).length;
  const failed = data.results.length - sent;
  const message = data.results.length === 0
    ? "Nobody to remind: every chosen desk has filed or the officers are not on it"
    : `Reminder sent to ${sent} of ${data.results.length}${failed ? ` — ${failed} failed` : ""}`;
  res.status(sent === 0 && data.results.length > 0 ? 422 : 200).json({ success: sent > 0 || data.results.length === 0, message, data });
});

/**
 * The report data for a date, with the sender's covering note on it.
 *
 * `reportDate` is a Lagos calendar day; noon UTC sits inside it whatever the
 * zone's offset, where midnight UTC would sit at its very edge.
 */
const reportDataFor = async (reportDate, note, req) => {
  const data = await buildPfiDailyReportData(new Date(`${reportDate}T12:00:00Z`));
  const trimmed = String(note || "").trim();
  return trimmed ? { ...data, note: trimmed, noteFrom: staffActor(req).name } : data;
};

/** The email as it would arrive — subject, HTML and text — sent to nobody. */
const previewDailyReportEmail = asyncHandler(async (req, res) => {
  const { reportDate, note } = req.body;
  const rendered = renderPfiDailyReportEmail(await reportDataFor(reportDate, note, req));
  res.json({ success: true, data: { subject: rendered.subject, html: rendered.html } });
});

/**
 * The Hub's "Email report" button: the Sales & Operations Report — the same
 * one the 23:50 cron sends (see dailyReportDispatch) — to the addresses typed
 * in, for the date on screen.
 *
 * ── One email per person ──────────────────────────────────────────────────
 *
 * Each address gets its own message, sent and judged on its own: nobody sees
 * who else it went to, and one bounced address does not decide the fate of the
 * rest. They go one delivery per address rather than as one list because a
 * list is resolved as a group — reordered, deduplicated, filtered by each
 * staff member's notification choices — and a result can then no longer be
 * matched back to the address it belongs to. The desk needs to know WHICH
 * address failed, so each is asked on its own.
 *
 * The report is built once and the same object goes to every address, so
 * everyone on one send reads identical figures.
 *
 * Success is judged from what the email channel actually did, never from the
 * call returning: a provider refusal is recorded, not thrown, and a send that
 * "succeeded" while the provider refused it is how an operator comes to
 * believe somebody was told something they never saw.
 */
const SEND_CONCURRENCY = 5;

const emailOutcome = (email, result) => {
  if (result?.error) return { email, status: "failed", error: result.error };
  const r = result?.results?.[0];
  if (!r) {
    return {
      email,
      status: "failed",
      error: "Not sent — this person has report emails switched off on Manage Users",
    };
  }
  const ch = r.channels?.email;
  if (ch === "sent" || ch === "partial") return { email, status: "sent" };
  const reason =
    r.error ||
    r.channelErrors?.email ||
    (r.suppressed || []).find((s) => s.channel === "email")?.reason ||
    "The email provider did not accept it";
  return { email, status: "failed", error: reason };
};

const emailDailyReports = asyncHandler(async (req, res) => {
  const { reportDate, note } = req.body;
  const recipients = [...new Set(req.body.recipients.map((e) => e.trim().toLowerCase()))];
  const data = await reportDataFor(reportDate, note, req);

  const results = [];
  for (let i = 0; i < recipients.length; i += SEND_CONCURRENCY) {
    const batch = recipients.slice(i, i + SEND_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async (email) =>
          emailOutcome(email, await notifyAndWait("reports.pfi_daily", { to: [{ email }], data }))
        )
      ))
    );
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const body = {
    success: sent > 0,
    message:
      sent === results.length
        ? `Sent to ${sent} recipient${sent === 1 ? "" : "s"}`
        : sent === 0
          ? results[0]?.error || "The report could not be sent"
          : `Sent to ${sent} of ${results.length} recipients`,
    data: { results },
  };
  // 422 rather than 502 when nothing went: an edge in front of this app turns
  // a 502 into its own error page with no CORS headers, and the provider's
  // reason never reaches the desk. A 4xx arrives untouched.
  res.status(sent === 0 ? 422 : 200).json(body);
});

module.exports = {
  deleteDailyReport,
  getDailyReports,
  getDailyReportById,
  submitDailyReport,
  getReportActuals,
  amendDailyReport,
  reviewDailyReport,
  emailDailyReports,
  previewDailyReportEmail,
  getOperationsReport,
  whatsappDailyReports,
  getOutstandingReports,
  sendReportReminders,
  CAN_VIEW_ALL_REPORTS,
};
