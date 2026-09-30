const { verifyAccessToken } = require("../services/token.service");
const sessionService = require("../services/session.service");
const { staffScopeRepo } = require("../repositories");

// Role VALUES, not table names — these are data, consumed by config/roleMapping.js
// and by the frontend. They are unrelated to the `staff` table rename.
const ELEVATED_ROLES = ["admin", "super_admin"];
const { checkApiAccess } = require("../config/apiPermissions");

/**
 * Verifies the bearer token, confirms the session behind it is still live, and
 * populates req.user. Authentication only — it makes no authorisation decision.
 *
 * The session check is what makes revocation immediate. Verifying the JWT
 * alone would leave a revoked session working until its 15-minute access token
 * expired, which defeats logout-all, suspension and reuse detection alike.
 */
const authenticateStaff = async (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  let claims;
  try {
    claims = verifyAccessToken("staff", token);
  } catch (err) {
    if (err.code === "expired") {
      return res.status(401).json({ success: false, message: "Token expired" });
    }
    // Preserved from the previous implementation: a malformed or wrongly
    // signed token is 403, not 401. Clients branch on this.
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  const active = await sessionService.loadActive("staff", claims.sid, claims.id);
  if (!active.ok) {
    return res.status(401).json({ success: false, message: "Session is no longer valid" });
  }

  // Shape preserved from the previous `decoded.UserInfo` payload so the 16
  // route files and their controllers keep working unchanged — the fields
  // below are additive, nothing existing was removed.
  //
  // Roles come from the freshly loaded row, not from the token: a role revoked
  // mid-session must take effect now, not when the access token expires. Scope
  // and page overrides are loaded fresh for the same reason — an admin editing
  // someone's depot/PFI access must take effect on their very next request.
  const authContext = await staffScopeRepo.getAuthContext(active.principal.id);

  req.user = {
    id: active.principal.id,
    email: active.principal.email,
    // The principal IS the staff row (see sessionRepo.findWithPrincipal), so
    // the name is already loaded — it just was not being carried across, which
    // left everything attributing actions to an email address.
    name: [active.principal.firstName, active.principal.surname]
      .filter(Boolean)
      .join(" ")
      .trim(),
    roles: active.principal.roles || [],
    canViewAllLocations: authContext.canViewAllLocations,
    scope: authContext.scope,
    pageOverrides: authContext.pageOverrides,
  };
  // Deliberately not `req.session` — that name belongs to express-session, and
  // colliding with it would be a confusing trap if it is ever added.
  req.authSession = active.session;

  next();
};

/**
 * Authorisation: the caller must hold at least one of the given roles.
 * Realm-neutral, so the name stays correct.
 */
function requireRole(...allowedRoles) {
  // Optional trailing { message } preserves caller-specific wording.
  let message = "Insufficient permissions";
  const last = allowedRoles[allowedRoles.length - 1];
  if (last && typeof last === "object" && last.message) {
    message = last.message;
    allowedRoles = allowedRoles.slice(0, -1);
  }

  // OPEN: every authenticated member of staff holds every role's rights.
  // See config/apiPermissions.checkApiAccess for why, and for the two defects
  // a reinstatement has to fix rather than simply restore.
  //
  // The arguments are still accepted and still read at each call site, so the
  // thirteen route files keep documenting who a route was FOR. That intent is
  // the only record of the old model left in the routing layer, and it costs
  // nothing to keep.
  return (req, res, next) => {
    void allowedRoles;
    void message;
    next();
  };
}

/**
 * Authorisation that is actually enforced — for the handful of actions that
 * move money or change what a cargo is.
 *
 * requireRole above is deliberately open app-wide. That leaves the screen as
 * the only thing between any signed-in member of staff and deleting a PFI,
 * releasing one to trade, approving a price, confirming or removing a payment,
 * or marking a refund paid — the API answered all of them for anybody. These
 * few routes use this instead: the caller must hold one of the roles, and a
 * super admin always may. Everyone who performed these acts on the live book
 * in the 60 days before this (2026-09-29) holds a role that is allowed.
 */
function enforceRole(...allowedRoles) {
  let message = "You do not have permission to do this";
  const last = allowedRoles[allowedRoles.length - 1];
  if (last && typeof last === "object" && last.message) {
    message = last.message;
    allowedRoles = allowedRoles.slice(0, -1);
  }
  const allowed = new Set([...allowedRoles, "super_admin"]);
  return (req, res, next) => {
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    if (roles.some((r) => allowed.has(r))) return next();
    return res.status(403).json({ success: false, message });
  };
}

/**
 * Authorise against the API permission table.
 *
 * Resolves the mount path from `req.baseUrl` — a router mounted at
 * /api/orders sees that regardless of the sub-path — and asks
 * config/apiPermissions.js whether these roles may read or write it.
 *
 * This replaced a flat `["admin", "super_admin"]` check. The dashboard has
 * shipped a 19-role guard for a while, but the server admitted two, so every
 * other role got a full menu and a 403 behind each item.
 */
function authoriseByRoute(req, res, next) {
  // baseUrl + path: routers mounted at their own prefix and those mounted at
  // bare /api both resolve correctly this way.
  const fullPath = (req.baseUrl || '') + (req.path === '/' ? '' : req.path || '');
  const { allowed, reason } = checkApiAccess(fullPath, req.method, req.user);
  if (allowed) return next();

  return res.status(403).json({
    success: false,
    message: reason || "You do not have permission to perform this action",
  });
}

/**
 * Default export: authenticate, then authorise against the route's own rule.
 */
const verifyStaff = [authenticateStaff, authoriseByRoute];

module.exports = verifyStaff;
module.exports.authenticateStaff = authenticateStaff;
module.exports.requireRole = requireRole;
module.exports.enforceRole = enforceRole;
module.exports.ELEVATED_ROLES = ELEVATED_ROLES;
module.exports.authoriseByRoute = authoriseByRoute;
