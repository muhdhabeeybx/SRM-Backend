const { eq } = require("drizzle-orm");
const { db } = require("../config/db");
const { rolePagesSwitch, rolePageSets } = require("../db/schema");
const auditLogRepo = require("../repositories/auditLog.repository");
const { ROLE_MAP } = require("../config/roleMapping");

/**
 * The standard pages for each role (migration 0096).
 *
 * While the switch is on, a person's pages are the 'everyone' set plus the
 * sets of every role they hold, and their own ticks in Manage Users on top —
 * a tick still adds a page or takes one away. Admins and super admins are not
 * narrowed by any set: they see what they always have.
 *
 * The dashboard decides what the menu shows from the list this gives
 * (soromanfe lib/rbac.ts canAccessRoute). The server's part is view only: a
 * page a role opens as view only is refused writes the way a view-only tick is
 * (middleware/viewOnlyPages.js).
 *
 * Read on every request, so it is cached briefly. A change made here clears
 * the cache at once; another server process catches up within TTL_MS.
 */

const EVERYONE = "everyone";

/** Roles no set narrows — they keep every page. */
const NOT_NARROWED = new Set(["super_admin", "admin"]);

/**
 * Pages a set may not hold, by prefix. Each has its own rule, kept by the
 * server too, and a set naming one would offer a page whose data is refused:
 * the books and the CFO report open by grant (accountsAccess, cfoReportAccess),
 * Delivery Costing by grant, Gantry Tickets by the stock officer role or a
 * grant (gantryTickets.service maySeeDesk). soromanfe ROLE_OPENED,
 * GRANT_ONLY and CLOSED_BY_DEFAULT are the same list.
 */
const OWN_RULE_PAGES = ["/accounts", "/cfo-report", "/delivery-costing", "/gantry-tickets"];

const TTL_MS = 15_000;
let cache = null;

const load = async () => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const [[sw], rows] = await Promise.all([
    db.select().from(rolePagesSwitch).where(eq(rolePagesSwitch.id, 1)).limit(1),
    db.select().from(rolePageSets),
  ]);
  const sets = new Map();
  for (const r of rows) {
    if (!sets.has(r.role)) sets.set(r.role, []);
    sets.get(r.role).push({ routePath: r.routePath, viewOnly: Boolean(r.viewOnly) });
  }
  for (const list of sets.values()) list.sort((a, b) => a.routePath.localeCompare(b.routePath));
  cache = {
    at: Date.now(),
    enabled: Boolean(sw?.enabled),
    changedBy: sw?.changedBy ?? null,
    changedAt: sw?.changedAt ?? null,
    sets,
  };
  return cache;
};

const forget = () => {
  cache = null;
};

const isOn = async () => (await load()).enabled;

/**
 * Every page these roles open, the 'everyone' set included. A page one role
 * opens fully and another as view only is full.
 */
const pagesForRoles = (sets, roles = []) => {
  const byPath = new Map();
  for (const role of [EVERYONE, ...roles]) {
    for (const p of sets.get(role) || []) {
      const had = byPath.get(p.routePath);
      byPath.set(p.routePath, { routePath: p.routePath, viewOnly: had ? had.viewOnly && p.viewOnly : p.viewOnly });
    }
  }
  return [...byPath.values()].sort((a, b) => a.routePath.localeCompare(b.routePath));
};

/**
 * The pages a person with these roles is given, or null when sets do not
 * decide their pages — the switch is off, or they are an admin.
 */
const pagesFor = async (roles = []) => {
  const { enabled, sets } = await load();
  if (!enabled || roles.some((r) => NOT_NARROWED.has(r))) return null;
  return pagesForRoles(sets, roles);
};

/** The roles a set can be kept for: every staff role but the two no set narrows. */
const roleChoices = () => [EVERYONE, ...Object.values(ROLE_MAP).filter((r) => !NOT_NARROWED.has(r))];

const hasOwnRule = (path) => OWN_RULE_PAGES.some((base) => path === base || path.startsWith(base + "/"));

/** What the Role pages screen shows. */
const overview = async () => {
  forget();
  const { enabled, changedBy, changedAt, sets } = await load();
  return {
    enabled,
    changedBy,
    changedAt: changedAt ? new Date(changedAt).toISOString() : null,
    sets: Object.fromEntries(roleChoices().map((role) => [role, sets.get(role) || []])),
  };
};

const httpErr = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** Replace one role's pages. `pages` is [{ routePath, viewOnly }]. */
const setPages = async (role, pages, actorId) => {
  if (!roleChoices().includes(role)) throw httpErr(400, `There is no role "${role}" to keep pages for.`);
  const seen = new Map();
  for (const p of pages || []) {
    const routePath = String(p?.routePath || "").trim();
    if (!routePath.startsWith("/") || routePath.length > 255) throw httpErr(400, `"${routePath}" is not a page.`);
    if (hasOwnRule(routePath)) throw httpErr(400, `${routePath} is given person by person in Manage Users, not by role.`);
    seen.set(routePath, { routePath, viewOnly: Boolean(p.viewOnly) });
  }
  const next = [...seen.values()];

  const before = (await load()).sets.get(role) || [];
  await db.transaction(async (tx) => {
    await tx.delete(rolePageSets).where(eq(rolePageSets.role, role));
    if (next.length) {
      await tx.insert(rolePageSets).values(next.map((p) => ({ role, ...p, updatedBy: actorId ?? null, updatedAt: new Date() })));
    }
  });
  forget();

  const key = (p) => `${p.routePath}${p.viewOnly ? " (view only)" : ""}`;
  const was = new Set(before.map(key));
  const now = new Set(next.map(key));
  await auditLogRepo.record({
    // The switch row: there is one set of role pages.
    entityType: "role_pages",
    entityId: 1,
    action: "role_pages.changed",
    actor: actorId ? { type: "staff", staffId: actorId } : { type: "system" },
    metadata: { role, added: [...now].filter((k) => !was.has(k)), removed: [...was].filter((k) => !now.has(k)) },
  }).catch((err) => console.error("[role-pages] audit failed:", err.message));

  return (await load()).sets.get(role) || [];
};

/** Turn the switch. The caller gives or takes back the PFI roles that go with it. */
const setEnabled = async (enabled, actorId) => {
  await db
    .update(rolePagesSwitch)
    .set({ enabled: Boolean(enabled), changedBy: actorId ?? null, changedAt: new Date() })
    .where(eq(rolePagesSwitch.id, 1));
  forget();
  await auditLogRepo.record({
    entityType: "role_pages",
    entityId: 1,
    action: enabled ? "role_pages.switched_on" : "role_pages.switched_off",
    actor: actorId ? { type: "staff", staffId: actorId } : { type: "system" },
    metadata: {},
  }).catch((err) => console.error("[role-pages] audit failed:", err.message));
};

module.exports = {
  EVERYONE,
  OWN_RULE_PAGES,
  isOn,
  pagesFor,
  pagesForRoles,
  roleChoices,
  overview,
  setPages,
  setEnabled,
  forget,
};
