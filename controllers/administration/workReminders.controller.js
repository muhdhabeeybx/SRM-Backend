const asyncHandler = require("express-async-handler");
const workReminders = require("../../services/workReminders.service");
const { staffActor } = require("../../utils/actor");

/**
 * The two-hourly reminders of waiting work.
 *
 * GET  /dashboard/work-reminders        who would be reminded of what, the
 *                                       exact text, and past rounds
 * POST /dashboard/work-reminders/send   send what is due now
 *
 * Both admin-only (enforceRole on the route): the page names individual staff
 * and what each is holding up, and sending texts people.
 */

const getWorkReminders = asyncHandler(async (req, res) => {
  const data = await workReminders.overview();
  res.json({ success: true, data });
});

/**
 * A round, now. People already reminded this hour come back as duplicates and
 * are not texted again — the round is the message's dedupe key.
 */
const sendWorkReminders = asyncHandler(async (req, res) => {
  const result = await workReminders.runRound({ trigger: "manual", actor: staffActor(req) });
  if (result.skipped) {
    return res.status(409).json({ success: false, message: result.reason });
  }
  const parts = [
    `${result.texted} texted`,
    result.appOnly ? `${result.appOnly} told in the app only` : null,
    result.duplicates ? `${result.duplicates} already reminded this hour` : null,
    result.switchedOff ? `${result.switchedOff} switched off` : null,
    result.failed ? `${result.failed} failed` : null,
  ].filter(Boolean);
  res.json({
    success: true,
    message: result.messages
      ? `${result.messages} reminder${result.messages === 1 ? "" : "s"} to ${result.people} ${result.people === 1 ? "person" : "people"}: ${parts.join(", ")}`
      : "Nothing is waiting on anybody assigned to it",
    data: result,
  });
});

module.exports = { getWorkReminders, sendWorkReminders };
