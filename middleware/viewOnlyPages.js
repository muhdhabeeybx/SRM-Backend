/**
 * Pages somebody may look at but not change.
 *
 * Manage Users gives each page one of three answers: not theirs, view only, or
 * full. View only is a page grant with view_only set (migration 0090). On such
 * a page they can open everything and download its reports; anything that
 * adds, edits or removes is refused here.
 *
 * ── Which page a request comes from ──────────────────────────────────────
 *
 * The API has no idea of pages: one endpoint serves several of them, and
 * /api/orders is written to from the order page, the PFI page and the finance
 * report alike. So the dashboard says which page it is on, in the
 * X-Dashboard-Page header, as the page's own path from the menu (soromanfe
 * lib/view-only.ts pageOf). A write sent from a view-only page is refused,
 * whatever endpoint it is for — which is exactly "on this page you can't
 * change anything", and needs no table of which endpoint belongs to which page.
 *
 * The dashboard refuses the same writes before they are sent, and hides the
 * buttons; this is the server's half, so a page left with a button nobody hid
 * still cannot save. It follows the page the dashboard names: it is a desk
 * rule for staff, not a lock against somebody rewriting their own requests.
 *
 * ── What stays allowed ────────────────────────────────────────────────────
 *
 * Reading, always — GET is how every page and every download is fetched. And
 * a person's own account, from whatever page they are on: signing out, their
 * own profile and password, and their own bell (marking read, preferences),
 * which the header bar writes on every page. A broadcast is not their own
 * bell, so it is not let through.
 *
 * A super admin is never view only: they are the ones who set it, and a slip
 * on their own account must not take Manage Users away from them.
 */

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_PAGE_LENGTH = 100;

/** Their own account, writable from any page. */
function isOwnAccount(path) {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (path === "/api/admin/me" || path.startsWith("/api/admin/me/")) return true;
  if (path.startsWith("/api/notifications/")) return !path.startsWith("/api/notifications/broadcast");
  return false;
}

/** The page path the dashboard sent, or null when it sent none worth reading. */
function pageFrom(req) {
  const raw = req.get ? req.get("X-Dashboard-Page") : req.headers?.["x-dashboard-page"];
  if (typeof raw !== "string") return null;
  const page = raw.trim();
  if (!page.startsWith("/") || page.length > MAX_PAGE_LENGTH) return null;
  return page;
}

/**
 * Whether this person holds `page` as view only — by their own tick, or, with
 * no tick on it, by the set their roles give (services/rolePages.service.js).
 */
function isViewOnlyPage(user, page) {
  if (!user || !page) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (roles.includes("super_admin")) return false;
  const row = (user.pageOverrides || []).find((o) => o.routePath === page);
  if (row) return Boolean(row.allowed && row.viewOnly);
  const fromRoles = (user.rolePages || []).find((p) => p.routePath === page);
  return Boolean(fromRoles?.viewOnly);
}

/**
 * The refusal for this request, or null when it may go ahead.
 * @returns {{ status: number, body: object } | null}
 */
function viewOnlyRefusal(req) {
  if (READS.has(String(req.method || "").toUpperCase())) return null;
  const path = String(req.originalUrl || "").split("?")[0];
  if (isOwnAccount(path)) return null;
  const page = pageFrom(req);
  if (!isViewOnlyPage(req.user, page)) return null;
  return {
    status: 403,
    body: {
      success: false,
      code: "VIEW_ONLY",
      message: "This page is view only for you. You can look and download, but not add, edit or remove anything.",
      page,
    },
  };
}

module.exports = { viewOnlyRefusal, isViewOnlyPage, isOwnAccount, pageFrom };
