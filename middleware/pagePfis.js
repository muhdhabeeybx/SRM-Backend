const { pageFrom, isOwnAccount } = require("./viewOnlyPages");

/**
 * A page that shows somebody a PFI list of its own.
 *
 * Somebody's PFIs (pfi_staff) narrow every page alike. The owner (28 Oct
 * 2026): "someone can only see pending payments on only selected pfis and can
 * see other pfis on delivery inventory too". So in Manage Users a page they
 * have may carry its own PFIs (staff_page_overrides.pfi_ids, migration 0100),
 * and every request sent from that page is answered as if those were their
 * PFIs. The page is the one the dashboard names in X-Dashboard-Page, exactly
 * as view only reads it (middleware/viewOnlyPages.js).
 *
 * ── How ───────────────────────────────────────────────────────────────────
 *
 * req.user's scope is swapped before any controller sees it, so every reader
 * that already narrows by PFI — lib/scopeFilter, lib/pfiBankScope, lib/pfiScope
 * and the rest — narrows to the page's list with nothing of its own to change.
 * A PFI assignment is already the whole answer wherever a row has a PFI
 * (scopeCondition), so the page's list decides those rows. Rows with no PFI
 * stay as they were: somebody on "Everything" keeps every depot, station and
 * plant; somebody narrowed to places keeps theirs.
 *
 * It is a different list, not a wider gate. The page's PFIs can include ones
 * they do not otherwise have — that is the point of "other PFIs on delivery
 * inventory" — but only on that page.
 *
 * ── What it does not change ───────────────────────────────────────────────
 *
 *   PFIs that name them in a slot. A PFI Tracking slot (Finance Officer on
 *   49B) always shows on every page, at the owner's choice: their texts and
 *   reminders send them to it.
 *
 *   Who they are. The areas with no PFI link turn away people confined to
 *   PFIs (lib/pfiScope denyPfiScoped). Somebody on "Everything" with a PFI
 *   list on Pending Payments is not confined to PFIs, and a customer look-up
 *   from that page must not be refused as if they were. Those questions read
 *   `assigned`, their own reach (pfiScope isConfined).
 *
 *   Their own account and their bell, from any page: the header bar sends
 *   those from every page and they must read the same everywhere. The menu
 *   counts likewise; each count takes its own page's list instead
 *   (services/workQueues.service.js).
 *
 * A super admin is never narrowed this way.
 */

const toIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];

/** Counted per page, not per request: services/workQueues.service.js. */
const MENU_COUNTS = "/api/dashboard/work-queues";

/** The PFIs this page's grant names for them, or null when the page has no list of its own. */
function pagePfiIds(user, page) {
  if (!user || !page) return null;
  if ((user.roles || []).includes("super_admin")) return null;
  const row = (user.pageOverrides || []).find((o) => o.routePath === page);
  if (!row?.allowed) return null;
  const ids = toIds(row.pfiIds);
  return ids.length ? ids : null;
}

/**
 * This person as a request from `page` sees them: that page's PFIs, and every
 * PFI that names them in a slot, in place of their own. The same person when
 * the page has no list of its own.
 */
function asOnPage(user, page) {
  const ids = pagePfiIds(user, page);
  if (!ids) return user;
  const everywhere = Boolean(user.canViewAllLocations);
  const scope = user.scope || {};
  const kept = (key) => (everywhere ? [] : scope[key] || []);
  return {
    ...user,
    canViewAllLocations: false,
    scope: {
      ...scope,
      depotIds: kept("depotIds"),
      lpgStationIds: kept("lpgStationIds"),
      fillingStationIds: kept("fillingStationIds"),
      pfiIds: toIds([...ids, ...toIds(user.slotPfiIds)]),
    },
    assigned: user.assigned || { canViewAllLocations: user.canViewAllLocations, scope: user.scope },
  };
}

/** Swaps in the page's PFIs on req.user, for a request sent from such a page. */
function applyPagePfis(req) {
  const path = String(req.originalUrl || "").split("?")[0];
  if (isOwnAccount(path) || path === MENU_COUNTS) return;
  req.user = asOnPage(req.user, pageFrom(req));
}

module.exports = { applyPagePfis, asOnPage, pagePfiIds };
