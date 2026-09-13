const asyncHandler = require("express-async-handler");
const deskNudge = require("../../services/deskNudge.service");

/**
 * The desk backlogs, and the two ways of chasing them.
 *
 * GET  /desk-nudges            what is outstanding, and who would be told
 * POST /desk-nudges/notify     send the in-app nudge now
 * POST /desk-nudges/sms        text the desk — deliberate, admin-only
 *
 * The daily sweep already nudges in-app at 08:00. These exist because an admin
 * looking at a queue that has been sitting for months should not have to wait
 * until tomorrow morning to chase it, and because in-app plainly has not been
 * enough for the ones that have.
 */

/** Read-only. Nothing is sent; this is the "who would I be chasing" view. */
const getDeskNudges = asyncHandler(async (req, res) => {
  const desks = await deskNudge.runDeskNudges({ dryRun: true });

  // The contact list per desk, so the page can say who a text would reach
  // before anybody decides to send one.
  const withContacts = await Promise.all(
    desks.map(async (d) => ({
      ...d,
      contacts: await deskNudge.deskContacts(d.desk),
    })),
  );

  res.json({ success: true, data: { desks: withContacts } });
});

const sendDeskNudges = asyncHandler(async (req, res) => {
  const results = await deskNudge.runDeskNudges();
  const told = results.filter((r) => r.notified);
  res.json({
    success: true,
    message: told.length
      ? `Notified ${told.map((r) => `${r.desk} (${r.count})`).join(", ")}`
      : "Every desk is clear — nobody was notified",
    data: { results },
  });
});

/**
 * Text a desk. One desk per call, on purpose.
 *
 * SMS costs money and interrupts somebody's evening, so it is never a sweep
 * over all three — it is a decision taken about one queue while looking at it.
 * `dryRun` returns the exact message and recipient list without sending.
 */
const smsDeskNudge = asyncHandler(async (req, res) => {
  const { desk, dryRun } = req.body;
  const result = await deskNudge.smsDesk(desk, { dryRun: dryRun === true });

  if (dryRun === true) {
    return res.json({ success: true, message: "Nothing sent — preview only", data: result });
  }

  const sent = result.sent?.length || 0;
  const failed = result.failed?.length || 0;
  res.json({
    success: failed === 0,
    message: result.count === 0
      ? "Nothing outstanding on that desk — nobody was texted"
      : `Texted ${sent}${failed ? `, ${failed} failed` : ""}${result.unreachable?.length ? `, ${result.unreachable.length} have no number on file` : ""}`,
    data: result,
  });
});

module.exports = { getDeskNudges, sendDeskNudges, smsDeskNudge };
