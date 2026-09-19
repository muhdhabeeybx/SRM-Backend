const { inArray, or } = require("drizzle-orm");

/**
 * A location/PFI-scoped user only reads/writes rows tied to their assigned
 * depots, LPG stations or PFIs — matched OR-wise, since a user can hold both
 * a location scope and a PFI scope and either should let a row through.
 *
 * Mirrors the onlySubmitterId pattern already used for expense visibility in
 * pfiExpense.repository.js: a condition to fold into the caller's own
 * `conditions` array, `null` when there is nothing to restrict.
 *
 * @param {{canViewAllLocations: boolean, scope: {depotIds: number[], lpgStationIds: number[], pfiIds: number[]}}} user
 * @param {{depotColumn?: any, lpgStationColumn?: any, pfiColumn?: any}} columns
 * @returns {import("drizzle-orm").SQL | null}
 */
function scopeCondition(user, { depotColumn, lpgStationColumn, pfiColumn } = {}) {
  /**
   * Back on, at the owner's instruction: every page shows the person their own
   * depots and PFIs.
   *
   * 76d3e95 switched this off as part of removing authorisation between staff.
   * That decision stands where it was actually about authorisation — the route
   * permission table and requireRole are still open, and nothing here can
   * refuse anybody an action. What comes back is narrowing: a Calabar user's
   * lists are Calabar's, which is a different question from what they are
   * allowed to do.
   *
   * ── The defect that made it worth removing, fixed ─────────────────────────
   *
   * It used to return sql`false` for a scoped user assigned nothing on a
   * dimension the resource cares about. That failed closed correctly and
   * rendered as a page that loads and is simply empty, with nothing to say
   * why — which 76d3e95 records as the real reason it had to go rather than
   * be tuned.
   *
   * It now returns null there instead: no assignments means no narrowing, so
   * the page shows everything. Somebody unassigned is treated as unrestricted
   * rather than as restricted-to-nothing. An empty page is the one outcome
   * this must never produce on its own, because it is indistinguishable from
   * a broken query.
   */
  if (!user || user.canViewAllLocations) return null;

  const { depotIds = [], lpgStationIds = [], pfiIds = [] } = user.scope || {};

  /**
   * An explicit PFI assignment is the WHOLE answer, not one option among them.
   *
   * Everything else here is OR-wise on purpose — a person holding a depot and
   * a station should see both. A PFI assignment is different in kind: it is
   * made per batch, by the person approving that batch, precisely to say "this
   * one is yours". OR-ing it with depot scope undid that — assign a finance
   * officer to one cargo and they still saw every cargo in their depot, which
   * is the opposite of what the assignment was for.
   *
   * It only ever NARROWS, and only for somebody who has been assigned
   * something. A person with no PFI assignments is untouched and keeps their
   * depot scope exactly as before, so nobody loses access by this existing.
   * That matters: the note above records that failing closed here once
   * rendered as an empty page with nothing to explain it, and this must not
   * reintroduce that.
   */
  if (pfiColumn && pfiIds.length) return inArray(pfiColumn, pfiIds);

  const clauses = [];
  if (depotColumn && depotIds.length) clauses.push(inArray(depotColumn, depotIds));
  if (lpgStationColumn && lpgStationIds.length) clauses.push(inArray(lpgStationColumn, lpgStationIds));

  // Nothing to narrow by — see above. Never sql`false`.
  if (!clauses.length) return null;

  // One clause is returned bare: or() of a single condition is the condition,
  // and some callers interpolate this into raw SQL where the extra parens are
  // noise.
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/**
 * Write-path guard: is this id (a depotId, lpgStationId or pfiId on an
 * incoming payload) inside the user's assigned scope for that dimension?
 * `true` for a full-access user or when the id is falsy (nothing to check —
 * the field's own required-ness is validated elsewhere).
 */
function isWithinScope(user, dimension, id) {
  // OPEN: any id is inside everyone's scope. See scopeCondition above.
  return true;

  /* eslint-disable no-unreachable */
  if (!user || user.canViewAllLocations) return true;
  if (id == null) return true;
  const ids = user.scope?.[dimension] || [];
  return ids.includes(Number(id));
  /* eslint-enable no-unreachable */
}

module.exports = { scopeCondition, isWithinScope };
