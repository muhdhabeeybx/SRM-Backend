const asyncHandler = require("express-async-handler");
const messageLog = require("../../services/messageLog.service");

/**
 * Every message the platform sent, and what each SMS cost. The ledger and its
 * rules live in services/messageLog.service.js.
 */

const filtersOf = (q) => ({
  from: q.from || null,
  to: q.to || null,
  channel: q.channel || "all",
  audience: q.audience || "all",
  category: q.category || "all",
  status: q.status || "all",
  search: q.search || "",
  page: q.page,
  limit: q.limit,
});

/** GET /notifications/message-log */
const listMessages = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await messageLog.list(filtersOf(req.query)) });
});

/** GET /notifications/message-log/summary — totals by day, audience, category, channel. */
const messageSummary = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await messageLog.summary(filtersOf(req.query)) });
});

/**
 * POST /notifications/message-log/sync — bring charges in from Termii now,
 * rather than waiting for the half-hourly sync.
 */
const syncMessages = asyncHandler(async (req, res) => {
  const result = await messageLog.syncTermii({ full: false });
  if (!result.ok) return res.status(502).json({ success: false, message: result.error || "Termii sync failed" });
  res.json({
    success: true,
    message: `Brought in ${result.rows.toLocaleString()} message${result.rows === 1 ? "" : "s"} from Termii`,
    data: result,
  });
});

module.exports = { listMessages, messageSummary, syncMessages };
