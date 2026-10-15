/**
 * Who may reach the books (/api/accounts).
 *
 * The owner's instruction of 15 Oct 2026: the accounts pages are the admins'
 * for now — finance and audit included only once somebody grants them. So an
 * admin or super admin may, and anybody else only by a per-person page grant
 * from Manage Users, the same grant the dashboard's menu reads (soromanfe
 * lib/rbac.ts ROLE_OPENED['/accounts']). The two MUST agree: a page the menu
 * offers and the API refuses is the state role gating was switched off to end.
 *
 * Hiding the menu alone would restrict nothing — the API answers any signed-in
 * caller by default (config/apiPermissions) — so the gate is here too, as it
 * is for the CFO report (middleware/cfoReportAccess.js).
 *
 * A grant on /accounts decides, either way, even for an admin. With none, the
 * admin roles decide; and a grant on any one /accounts/… page opens the API,
 * which cannot tell the pages apart.
 */

const ACCOUNTS_ROUTE = "/accounts";
const ADMIN_ROLES = ["admin", "super_admin"];

/** @returns {boolean} whether this caller may read or write the books. */
function maySeeAccounts(user) {
  if (!user) return false;
  const overrides = user.pageOverrides || [];
  const own = overrides.find((o) => o.routePath === ACCOUNTS_ROUTE);
  if (own) return Boolean(own.allowed);
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (roles.some((r) => ADMIN_ROLES.includes(r))) return true;
  return overrides.some((o) => o.allowed && String(o.routePath || "").startsWith(`${ACCOUNTS_ROUTE}/`));
}

function requireAccountsAccess(req, res, next) {
  if (maySeeAccounts(req.user)) return next();
  return res.status(403).json({
    success: false,
    message: "The accounts pages are for admins for now. Ask an admin for access.",
  });
}

module.exports = { requireAccountsAccess, maySeeAccounts, ACCOUNTS_ROUTE };
