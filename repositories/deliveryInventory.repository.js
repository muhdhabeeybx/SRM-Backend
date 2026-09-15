const { eq, and, or, ilike, desc, count, sql, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const {
  deliveryInventory,
  fleetTrucks: trucks,
  pfis,
  deliveryCustomers,
} = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");
const { tripCosts } = require("../lib/tripCosts");

const findById = async (id) => {
  const [row] = await db
    .select()
    .from(deliveryInventory)
    .where(eq(deliveryInventory.id, id))
    .limit(1);
  return row || null;
};

/**
 * Every row leaves here with its trip costs worked out.
 *
 * Attached on read rather than stored, so a corrected diesel price or an edited
 * rate cannot leave a stale margin behind it. Spread onto the row rather than
 * nested, because every consumer wants `margin` beside `rate` and a nested
 * object would mean each of them reaching in for it differently.
 */
const withCosts = (row) => (row ? { ...row, ...tripCosts(row) } : row);

const findAll = async ({
  search,
  loading_status,
  truck_number,
  page = 1,
  limit = 500,
  scopeUser,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  /**
   * Scoped by the PFI the load was drawn from. The depot here is free text —
   * a name somebody typed, not an id — so it cannot be matched against an
   * assignment; the batch is the dimension that can.
   */
  const scope = scopeCondition(scopeUser, { pfiColumn: deliveryInventory.pfiId });
  if (scope) conditions.push(scope);

  if (loading_status) {
    conditions.push(eq(deliveryInventory.loadingStatus, loading_status));
  }

  if (truck_number) {
    conditions.push(ilike(deliveryInventory.truckNumber, `%${truck_number}%`));
  }

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(deliveryInventory.truckNumber, pattern),
        ilike(deliveryInventory.pfiNumber, pattern),
        ilike(deliveryInventory.pfiProduct, pattern),
        ilike(deliveryInventory.customerName, pattern),
        ilike(deliveryInventory.depot, pattern),
        ilike(deliveryInventory.allocationCode, pattern),
        ilike(deliveryInventory.location, pattern),
        ilike(deliveryInventory.notes, pattern)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(deliveryInventory)
      .where(whereClause)
      // A total order, so OFFSET paging cannot repeat or skip a row — see the
      // same note in deliverySale.repository.js.
      .orderBy(desc(deliveryInventory.createdAt), desc(deliveryInventory.id))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(deliveryInventory)
      .where(whereClause),
  ]);

  const costed = rows.map(withCosts);
  return {
    loadings: costed,
    inventory: costed,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data) => {
  const [row] = await db.insert(deliveryInventory).values(data).returning();
  return withCosts(row);
};

const update = async (id, data) => {
  const [row] = await db
    .update(deliveryInventory)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(deliveryInventory.id, id))
    .returning();
  return withCosts(row) || null;
};

const deleteById = async (id) => {
  const [row] = await db
    .delete(deliveryInventory)
    .where(eq(deliveryInventory.id, id))
    .returning();
  return withCosts(row) || null;
};

/**
 * Apply one set of trip costs to several trucks at once.
 *
 * Trucks on a batch usually take the same diesel at the same price on the same
 * day, and entering it twelve times is how twelve rows end up slightly
 * different from each other.
 *
 * `clearBlank` decides what an empty field means. Off, a blank leaves that
 * column alone, so a bulk pass can set feeding without disturbing diesel
 * somebody already entered. On, a blank clears it — which is how a mistaken
 * bulk entry gets undone.
 */
const setCosts = async (ids, values, { clearBlank = false, actor = null } = {}) => {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return [];

  const patch = {};
  for (const key of ["agoLitres", "agoPrice", "feedingAllowance", "productPrice"]) {
    const v = values[key];
    if (v === undefined) continue;
    if (v === null || v === "") {
      if (clearBlank) patch[key] = null;
      continue;
    }
    patch[key] = String(v);
  }
  if (!Object.keys(patch).length) return [];

  patch.costedAt = new Date();
  if (actor) patch.costedBy = actor;

  const rows = await db
    .update(deliveryInventory)
    .set(patch)
    .where(inArray(deliveryInventory.id, list))
    .returning();

  return rows.map(withCosts);
};

module.exports = {
  setCosts,
  findById,
  findAll,
  create,
  update,
  deleteById,
};
