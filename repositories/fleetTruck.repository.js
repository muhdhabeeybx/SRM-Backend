const { eq, and, or, ilike, desc, asc, count, lte, gte, sql, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { fleetTrucks, fleetLedgerEntries } = require("../db/schema");

const findById = async (id) => {
  const [row] = await db.select().from(fleetTrucks).where(eq(fleetTrucks.id, id)).limit(1);
  return row || null;
};

const findByPlate = async (plateNumber) => {
  const [row] = await db
    .select()
    .from(fleetTrucks)
    .where(eq(fleetTrucks.plateNumber, plateNumber))
    .limit(1);
  return row || null;
};

/**
 * The truck behind a plate however it was typed: "bwr 835-xb" is BWR835XB.
 * Plates on the register are written without spaces, but not always.
 */
const findByPlateLoose = async (plate) => {
  const key = String(plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!key) return null;
  const [row] = await db
    .select()
    .from(fleetTrucks)
    .where(sql`regexp_replace(upper(${fleetTrucks.plateNumber}), '[^A-Z0-9]', '', 'g') = ${key}`)
    .orderBy(asc(fleetTrucks.id))
    .limit(1);
  return row || null;
};

/** Several trucks in one round trip — what a batch posting validates against. */
const findByIds = async (ids) => {
  const wanted = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (wanted.length === 0) return [];
  return db.select().from(fleetTrucks).where(inArray(fleetTrucks.id, wanted));
};

// Whitelist, not passthrough: sort input never reaches SQL unvalidated.
const SORTABLE = {
  plateNumber: fleetTrucks.plateNumber,
  createdAt: fleetTrucks.createdAt,
  mileage: fleetTrucks.mileage,
  nextServiceDate: fleetTrucks.nextServiceDate,
};

const findAll = async ({ search, isActive, sort, order, page = 1, limit = 50 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(fleetTrucks.plateNumber, pattern),
        ilike(fleetTrucks.driverName, pattern),
        ilike(fleetTrucks.truckMake, pattern)
      )
    );
  }
  if (isActive !== undefined) conditions.push(eq(fleetTrucks.isActive, isActive));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const sortColumn = SORTABLE[sort] || fleetTrucks.plateNumber;
  const sortDir = order === "desc" ? desc : asc;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(fleetTrucks)
      .where(whereClause)
      .orderBy(sortDir(sortColumn), asc(fleetTrucks.id))
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(fleetTrucks).where(whereClause),
  ]);

  return {
    trucks: rows,
    pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  };
};

const create = async (data) => {
  const [row] = await db.insert(fleetTrucks).values(data).returning();
  return row;
};

const update = async (id, data) => {
  const [row] = await db
    .update(fleetTrucks)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(fleetTrucks.id, id))
    .returning();
  return row || null;
};

// Compliance watchlist: anything expiring on or before the given date.
const findExpiringCompliance = async (byDate) => {
  return db
    .select()
    .from(fleetTrucks)
    .where(
      and(
        eq(fleetTrucks.isActive, true),
        // A hired truck's papers are its owner's to keep, not ours to chase.
        eq(fleetTrucks.isThirdParty, false),
        or(
          lte(fleetTrucks.insuranceExpiry, byDate),
          lte(fleetTrucks.roadWorthinessExpiry, byDate),
          lte(fleetTrucks.nextServiceDate, byDate)
        )
      )
    )
    .orderBy(asc(fleetTrucks.plateNumber));
};

// ── Fleet ledger (append-only: no update, no delete) ─────────────────────────

const createLedgerEntry = async (data) => {
  const [row] = await db.insert(fleetLedgerEntries).values(data).returning();
  return row;
};

/**
 * Many entries in one statement.
 *
 * A single multi-row INSERT rather than a loop, so a batch posting is one
 * round trip and one implicit transaction: either every truck gets its line
 * or none does. A half-applied "July salaries" is the one outcome worth
 * ruling out at the database.
 */
const createLedgerEntries = async (rows) => {
  if (!rows || rows.length === 0) return [];
  return db.insert(fleetLedgerEntries).values(rows).returning();
};

const findLedgerEntries = async ({
  truckId,
  entryType,
  category,
  dateFrom,
  dateTo,
  page = 1,
  limit = 50,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (truckId) conditions.push(eq(fleetLedgerEntries.truckId, truckId));
  if (entryType) conditions.push(eq(fleetLedgerEntries.entryType, entryType));
  if (category) conditions.push(ilike(fleetLedgerEntries.category, `%${category}%`));
  if (dateFrom) conditions.push(gte(fleetLedgerEntries.entryDate, dateFrom));
  if (dateTo) conditions.push(lte(fleetLedgerEntries.entryDate, dateTo));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(fleetLedgerEntries)
      .where(whereClause)
      .orderBy(desc(fleetLedgerEntries.entryDate), desc(fleetLedgerEntries.id))
      .limit(limitNum)
      .offset(offset),
    db.select({ total: count() }).from(fleetLedgerEntries).where(whereClause),
  ]);

  return {
    entries: rows,
    pagination: { total, page: pageNum, pages: Math.ceil(total / limitNum) },
  };
};

// Totals for a truck (or the whole fleet when truckId is omitted).
const summarizeLedger = async ({ truckId, dateFrom, dateTo } = {}) => {
  const conditions = [];
  if (truckId) conditions.push(eq(fleetLedgerEntries.truckId, truckId));
  if (dateFrom) conditions.push(gte(fleetLedgerEntries.entryDate, dateFrom));
  if (dateTo) conditions.push(lte(fleetLedgerEntries.entryDate, dateTo));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [totals] = await db
    .select({
      expenses: sql`COALESCE(SUM(CASE WHEN ${fleetLedgerEntries.entryType} = 'expense' THEN ${fleetLedgerEntries.amount} ELSE 0 END), 0)`,
      income: sql`COALESCE(SUM(CASE WHEN ${fleetLedgerEntries.entryType} = 'income' THEN ${fleetLedgerEntries.amount} ELSE 0 END), 0)`,
      entryCount: sql`count(*)::int`,
    })
    .from(fleetLedgerEntries)
    .where(whereClause);

  const byCategory = await db
    .select({
      category: fleetLedgerEntries.category,
      entryType: fleetLedgerEntries.entryType,
      total: sql`COALESCE(SUM(${fleetLedgerEntries.amount}), 0)`,
      entryCount: sql`count(*)::int`,
    })
    .from(fleetLedgerEntries)
    .where(whereClause)
    .groupBy(fleetLedgerEntries.category, fleetLedgerEntries.entryType);

  return { totals, byCategory };
};

module.exports = {
  findById,
  findByPlate,
  findByPlateLoose,
  findByIds,
  findAll,
  create,
  update,
  findExpiringCompliance,
  createLedgerEntry,
  createLedgerEntries,
  findLedgerEntries,
  summarizeLedger,
};
