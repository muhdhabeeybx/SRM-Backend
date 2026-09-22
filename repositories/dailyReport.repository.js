const { eq, and, ilike, asc, desc, count, gte, lte, inArray, or, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { dailyReports, depots, lpgStations, pfis, staff } = require("../db/schema");

/**
 * Who filed it, resolved against the staff table rather than trusted from the
 * row.
 *
 * `submitted_by_name` is written at submission time, and for a long stretch
 * that value was the filer's EMAIL — utils/actor.js used req.user.email as the
 * display name because the name was not being carried onto req.user. 24 of the
 * 416 reports on file still read as an address in the Staff column because of
 * it.
 *
 * Reading through the join fixes every one of those without touching the
 * stored data, and keeps the column current if someone's name is corrected
 * later. The stored value remains the fallback: it is the only record of who
 * filed a report whose staff row has since been deleted.
 */
const SUBMITTED_BY_NAME = sql`COALESCE(
  NULLIF(TRIM(CONCAT_WS(' ', ${staff.firstName}, ${staff.surname})), ''),
  NULLIF(${dailyReports.submittedByName}, ''),
  ''
)`.as("submittedByName");

// Whitelist, not passthrough: sort input never reaches SQL unvalidated.
const SORTABLE = {
  reportDate: dailyReports.reportDate,
  location: dailyReports.location,
  createdAt: dailyReports.createdAt,
  totalSalesAmount: dailyReports.totalSalesAmount,
  litresSold: dailyReports.litresSold,
};

const findById = async (id) => {
  const [row] = await db
    .select({ ...dailyReports, submittedByName: SUBMITTED_BY_NAME })
    .from(dailyReports)
    .leftJoin(staff, eq(staff.id, dailyReports.submittedBy))
    .where(eq(dailyReports.id, id))
    .limit(1);
  return row || null;
};

/**
 * A location/PFI-scoped viewer's reports are matched by name, not id —
 * `daily_reports.location`/`pfi_number` are free text typed on the filing
 * form, not foreign keys. Resolves the scope's depot/LPG-station ids to the
 * names filers would have typed, plus every PFI number that scope reaches
 * (held directly, or sitting at one of the scoped depots/stations).
 */
const scopedNames = async ({ depotIds = [], lpgStationIds = [], pfiIds = [] } = {}) => {
  const [depotRows, stationRows, pfiRows] = await Promise.all([
    depotIds.length ? db.select({ name: depots.name }).from(depots).where(inArray(depots.id, depotIds)) : [],
    lpgStationIds.length
      ? db.select({ name: lpgStations.name }).from(lpgStations).where(inArray(lpgStations.id, lpgStationIds))
      : [],
    pfiIds.length || depotIds.length || lpgStationIds.length
      ? db
          .select({ number: pfis.pfiNumber })
          .from(pfis)
          .where(
            or(
              pfiIds.length ? inArray(pfis.id, pfiIds) : sql`false`,
              depotIds.length ? inArray(pfis.locationId, depotIds) : sql`false`,
              lpgStationIds.length ? inArray(pfis.lpgStationId, lpgStationIds) : sql`false`,
            ),
          )
      : [],
  ]);
  return {
    locationNames: [...depotRows.map((r) => r.name), ...stationRows.map((r) => r.name)],
    pfiNumbers: pfiRows.map((r) => r.number),
  };
};

const findAll = async ({
  /**
   * Filtered in SQL, not after the fact.
   *
   * The system this replaces fetched 50 mixed rows and filtered client-side,
   * so a busy week of other people's reports could push yours off the page
   * entirely — and the pager would still say "1 of 1".
   */
  reportType,
  location,
  status,
  pfiNumber,
  submittedBy,
  dateFrom,
  dateTo,
  sort,
  order,
  /** The authenticated caller — only set for a location/PFI-scoped viewer
   * who otherwise has oversight of every report (see the controller). */
  scopeUser,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (reportType) conditions.push(eq(dailyReports.reportType, reportType));
  if (location) conditions.push(ilike(dailyReports.location, `%${location}%`));
  if (status) conditions.push(eq(dailyReports.status, status));
  if (pfiNumber) conditions.push(eq(dailyReports.pfiNumber, pfiNumber));
  if (submittedBy) conditions.push(eq(dailyReports.submittedBy, submittedBy));
  if (dateFrom) conditions.push(gte(dailyReports.reportDate, dateFrom));
  if (dateTo) conditions.push(lte(dailyReports.reportDate, dateTo));

  if (scopeUser && !scopeUser.canViewAllLocations) {
    const { locationNames, pfiNumbers } = await scopedNames(scopeUser.scope);
    const clauses = [];
    // A PFI assignment is the whole answer (lib/scopeFilter): somebody on a
    // PFI and a location sees that PFI's reports, not every PFI's reports at
    // the location. Location scope applies only to somebody with no PFI.
    if (pfiNumbers.length) clauses.push(inArray(dailyReports.pfiNumber, pfiNumbers));
    else if (locationNames.length) clauses.push(inArray(dailyReports.location, locationNames));
    // Whatever the scope says, a person always sees the reports they filed
    // themselves. Without this, someone scoped to a location that has since
    // been renamed — or assigned nothing at all, which fell through to the
    // fail-closed branch below — could not find a single report they had
    // written, which reads as data loss rather than as a permission.
    if (scopeUser.id != null) clauses.push(eq(dailyReports.submittedBy, Number(scopeUser.id)));
    conditions.push(clauses.length ? or(...clauses) : sql`false`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...dailyReports, submittedByName: SUBMITTED_BY_NAME })
      .from(dailyReports)
      .leftJoin(staff, eq(staff.id, dailyReports.submittedBy))
      .where(whereClause)
      .orderBy(
        (order === "asc" ? asc : desc)(SORTABLE[sort] || dailyReports.reportDate),
        desc(dailyReports.id)
      )
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(dailyReports).where(whereClause),
  ]);

  return {
    reports: rows,
    pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  };
};

const create = async (data) => {
  const [row] = await db.insert(dailyReports).values(data).returning();
  return row;
};

const update = async (id, data) => {
  const [row] = await db
    .update(dailyReports)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(dailyReports.id, id))
    .returning();
  return row || null;
};

/** Hard delete — a report is a submission, not a ledger entry. */
const remove = async (id) => {
  const [row] = await db.delete(dailyReports).where(eq(dailyReports.id, Number(id))).returning();
  return row || null;
};

module.exports = { findById, findAll, create, update, remove };
