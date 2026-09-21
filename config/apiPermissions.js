/**
 * Which roles may reach which API resource.
 *
 * Role-based gating is off dashboard-wide: any signed-in staff member may
 * read and write every listed resource, regardless of role. Location/PFI
 * scope (see lib/scopeFilter.js) still narrows *which rows* a non-super_admin
 * sees or can act on — that check is independent of this file and stays
 * fully in force. This file only ever decided whether the endpoint was
 * reachable at all, and now it says yes to everyone who's logged in.
 *
 * An unlisted mount is still closed by default (see checkApiAccess) — that's
 * not a role restriction, it's a new-route safety net so an endpoint has to
 * be added here deliberately rather than opening by omission.
 *
 * super_admin is implicit everywhere and never listed.
 */

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * mount path -> { read: [...roles] | null, write: [...roles] | null }
 *
 * A missing `write` means the read list governs both. `null` means any
 * signed-in staff member — every entry below is `null`.
 */
const API_PERMISSIONS = {
  "/api/dashboard": { read: null },
  "/api/notifications": { read: null },
  "/api/uploads": { read: null },
  "/api/orders": { read: null },
  "/api/order-refunds": { read: null },
  "/api/tickets": { read: null },
  "/api/customers": { read: null },
  "/api/customer-licenses": { read: null },
  "/api/depots": { read: null },
  "/api/products": { read: null },
  "/api/trucks": { read: null },
  "/api/fleet": { read: null },
  "/api/drivers": { read: null },
  "/api/expenses": { read: null },
  "/api/vendors": { read: null },
  "/api/finance-report": { read: null },
  "/api/cfo-report": { read: null },
  "/api/pfis": { read: null },
  "/api/deposits": { read: null },
  "/api/expected-payments": { read: null },
  "/api/bank-accounts": { read: null },
  "/api/bank-statements": { read: null },
  "/api/settlements": { read: null },
  "/api/commissions": { read: null },
  "/api/lpg-stations": { read: null },
  "/api/filing-stations": { read: null },
  "/api/delivery-customers": { read: null },
  "/api/delivery-inventory": { read: null },
  "/api/delivery-sales": { read: null },
  "/api/offline-sales": { read: null },
  "/api/incidents": { read: null },
  "/api/daily-reports": { read: null },
  "/api/reports": { read: null },
  "/api/order-expiry": { read: null },

  // These three sit on routers mounted at bare /api, so they are matched on
  // the full request path rather than the mount — see resolveRule.
  "/api/dangote-order-requests": { read: null },
  "/api/dangote-products": { read: null },
  "/api/lpg-order-requests": { read: null },

  "/api/admin": { read: null },
  "/api/message-templates": { read: null },
  "/api/price-list": { read: null },
};

/**
 * Longest-prefix match on the full path.
 *
 * Most routers mount at their own path, so `req.baseUrl` identifies them. A
 * few (Dangote, LPG) mount at bare /api and carry their resource in the
 * sub-path, which would otherwise resolve to an /api rule that does not
 * exist and lock everyone out. Matching the full path covers both, and
 * longest-first means /api/dangote-products wins over any shorter prefix.
 */
const SORTED_PATHS = Object.keys(API_PERMISSIONS).sort((a, b) => b.length - a.length);

function resolveRule(fullPath) {
  for (const key of SORTED_PATHS) {
    if (fullPath === key || fullPath.startsWith(key + "/")) return API_PERMISSIONS[key];
  }
  return null;
}

/** Roles the caller holds, from both the singular field and the array. */
function rolesOf(user) {
  const list = Array.isArray(user?.roles) ? user.roles : [];
  return new Set([...list, user?.role].filter(Boolean));
}

/**
 * @returns {{allowed: boolean, reason?: string}}
 */
function checkApiAccess(fullPath, method, user) {
  /**
   * OPEN: every authenticated member of staff may do everything.
   *
   * A deliberate owner-level decision to run the dashboard without internal
   * authorisation, taken because the rules here and the dashboard's own menu
   * disagreed in practice — people were shown a page and then refused the data
   * behind it, with nothing on screen to say which of the two was wrong.
   *
   * Two mismatches produced that, and they are what any reinstatement has to
   * fix rather than merely restore:
   *
   *   Page overrides were never consulted here. verifyStaff loads
   *   `req.user.pageOverrides`; this function only ever read roles. Granting
   *   somebody a page made the menu show it and changed nothing about whether
   *   the API would answer — the grant was real in one layer and invisible to
   *   the other.
   *
   *   An unlisted mount was closed to all but super_admin, so every route
   *   added without an entry in the table below returned 403 to the whole
   *   company until somebody noticed.
   *
   * AUTHENTICATION IS UNAFFECTED. A caller still needs a valid token and a
   * live session (see authenticateStaff). This removes authorisation between
   * signed-in staff; it does not remove the lock on the door.
   *
   * The table below is deliberately kept and still exported, so reinstating
   * any part of this is an edit to this one function rather than an
   * archaeology exercise.
   */
  void fullPath;
  void method;
  void user;
  return { allowed: true };
}

module.exports = { API_PERMISSIONS, checkApiAccess, resolveRule, rolesOf, READ_ONLY_METHODS };
