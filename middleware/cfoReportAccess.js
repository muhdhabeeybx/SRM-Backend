/**
 * Who may reach the CFO report.
 *
 * The report is the company's money on one sheet: per batch, per day, what was
 * sold, what came in, what it cost and what is left. It was asked to be
 * visible to three people only — Habeeb Suleiman, General Admin and Muideen
 * Salami — so this is an allowlist, not a role.
 *
 * ── Why this is a server gate and not just a hidden menu item ──────────────
 *
 * Hiding a page is not restricting data. `/api/cfo-report` answers any signed-
 * in caller today (see config/apiPermissions.checkApiAccess — role gating is
 * deliberately open dashboard-wide), so removing the sidebar entry alone would
 * leave the whole sheet one devtools tab away from every gate officer and
 * driver on the system. deliveryInventory.controller.js already makes this
 * argument for trip costs and gates them the same way; this follows it.
 *
 * ── Why the per-person page override, and not a new table ──────────────────
 *
 * `staff_page_overrides` is the one grant the dashboard's own menu reads, so
 * gating on it is what keeps the two layers in agreement. That disagreement —
 * a page granted in one layer and invisible to the other — is the documented
 * reason role gating was switched off across the dashboard in the first place,
 * and it is the defect any new restriction has to avoid rather than repeat.
 *
 * ── Two ways this is deliberately stricter than /delivery-costing ──────────
 *
 * No role opens it, super_admin included. Four people hold super_admin and
 * only two of them were named, so a role bypass would admit exactly the people
 * the request excluded. "Only these three" has to mean these three.
 *
 * Absence is refusal. With no override row the answer is no, so a staff
 * member created next month is out until somebody grants them in — the way
 * round that fails safe. /delivery-costing falls back to super_admin instead;
 * that is a wider page and a different instruction, so it is left as it is.
 */

/**
 * The dashboard route, not the API mount. This is the string the sidebar's own
 * guard matches on, and the two MUST stay identical — a mismatch here is
 * silent, and it fails in the worse direction: the menu shows the page and the
 * API refuses it.
 */
const CFO_REPORT_ROUTE = "/cfo-report";

/** Staff the report was opened to, by id. See db/migrations/0041. */
const CFO_REPORT_STAFF_IDS = [
  1, // Habeeb Suleiman
  39, // General Admin
  85, // Muideen Salami
];

/**
 * @returns {boolean} whether this caller may see the CFO report at all.
 */
function maySeeCfoReport(user) {
  if (!user) return false;
  const override = (user.pageOverrides || []).find((o) => o.routePath === CFO_REPORT_ROUTE);
  // No row is a refusal, not a fallthrough — see the header.
  return override ? Boolean(override.allowed) : false;
}

/**
 * Refuse the whole endpoint, rather than serving a stripped version of it.
 *
 * Trip costs are a few columns on a page that has other reasons to exist, so
 * they are stripped and the page still loads. Every figure on this report is
 * the restricted thing, so there is nothing left to serve and a 403 is the
 * honest answer.
 *
 * The message names the report and says who to ask. A bare "Forbidden" on a
 * page the sidebar offered you is the confusing state this is meant to end.
 */
function requireCfoReportAccess(req, res, next) {
  if (maySeeCfoReport(req.user)) return next();

  return res.status(403).json({
    success: false,
    message: "The CFO report is restricted. Ask a super admin for access.",
  });
}

module.exports = {
  requireCfoReportAccess,
  maySeeCfoReport,
  CFO_REPORT_ROUTE,
  CFO_REPORT_STAFF_IDS,
};
