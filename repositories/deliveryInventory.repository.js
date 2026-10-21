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
const { tripAgoFor } = require("../lib/tripAgo");

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

/**
 * A trip given its AGO on the AGO stock ledger reads the ledger's figure —
 * given + top-ups − retrieved — in place of the litres typed on it, and says
 * so (`agoFromLedger`), so Delivery Costing can lock the box. The typed figure
 * stays in its column untouched; a trip whose ledger entries are all deleted
 * reads it again. Done before the costs, so the AGO value, cost per litre and
 * margin are all worked from the ledger's litres. See migration 0093.
 */
const withLedgerAgo = async (rows) => {
  const nets = await tripAgoFor(rows.filter(Boolean).map((r) => r.id));
  return rows.map((r) => {
    if (!r) return r;
    const net = nets.get(Number(r.id));
    return net === undefined
      ? { ...r, agoFromLedger: false }
      : { ...r, agoLitres: net.toFixed(2), agoFromLedger: true };
  });
};

/**
 * Whose truck carried each trip (0094). A third party's is costed as haulage
 * (lib/tripCosts.js), and the screens name its owner. Read off the fleet
 * register in one query rather than joined into every select of this table.
 */
const truckOwners = async (truckIds) => {
  const ids = [...new Set(truckIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const found = await db
    .select({ id: trucks.id, isThirdParty: trucks.isThirdParty, ownerName: trucks.ownerName })
    .from(trucks)
    .where(inArray(trucks.id, ids));
  return new Map(found.map((t) => [Number(t.id), t]));
};

const withTruckOwners = async (rows) => {
  const owners = await truckOwners(rows.filter(Boolean).map((r) => r.truckId));
  return rows.map((r) => {
    if (!r) return r;
    const t = owners.get(Number(r.truckId));
    return { ...r, truckThirdParty: Boolean(t?.isThirdParty), truckOwner: t?.isThirdParty ? t.ownerName || "" : "" };
  });
};

const costedRows = async (rows) => (await withTruckOwners(await withLedgerAgo(rows))).map(withCosts);

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

  const costed = await costedRows(rows);
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

// `tx` so a write can share a transaction with what it changes elsewhere —
// an allocation's order, see services/allocationTrucks.service.js.
const create = async (data, tx = db) => {
  const [row] = await tx.insert(deliveryInventory).values(data).returning();
  return withCosts(row);
};

const update = async (id, data, tx = db) => {
  const [row] = await tx
    .update(deliveryInventory)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(deliveryInventory.id, id))
    .returning();
  if (!row) return null;
  // Inside an allocation's transaction the ledger is read by the caller's
  // next list instead: a second connection mid-transaction is not worth it.
  return tx === db ? (await costedRows([row]))[0] : withCosts(row);
};

const deleteById = async (id, tx = db) => {
  const [row] = await tx
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
  if (!list.length) return { rows: [], agoKept: 0, haulageSkipped: 0 };

  const patch = {};
  for (const key of ["agoLitres", "agoPrice", "feedingAllowance", "productPrice", "haulageAmount"]) {
    const v = values[key];
    if (v === undefined) continue;
    if (v === null || v === "") {
      if (clearBlank) patch[key] = null;
      continue;
    }
    patch[key] = String(v);
  }
  // Paid through Expenses or not. Absent leaves it alone, like a blank figure;
  // the dialog sends it only when somebody chose.
  if (typeof values.feedingInExpenses === "boolean") {
    patch.feedingInExpenses = values.feedingInExpenses;
  }
  if (!Object.keys(patch).length) return { rows: [], agoKept: 0, haulageSkipped: 0 };

  /**
   * A trip on the AGO stock ledger keeps the ledger's litres. Its other
   * figures (price, feeding, product price) still apply; only the litres are
   * left, and the caller is told how many — so a bulk pass or an import
   * cannot put a second, different AGO figure beside the ledger's.
   */
  const owned = "agoLitres" in patch ? await tripAgoFor(list) : new Map();

  /**
   * Haulage belongs on a hired truck's trip alone. On one of our own it would
   * turn the trip's diesel into AGO sold to an owner who does not exist, so a
   * bulk pass over a mixed batch writes it only to the third party's trucks.
   * A trip that already carries haulage can always have it corrected.
   */
  let hired = new Set();
  if ("haulageAmount" in patch) {
    const found = await db
      .select({ id: deliveryInventory.id })
      .from(deliveryInventory)
      .leftJoin(trucks, eq(trucks.id, deliveryInventory.truckId))
      .where(and(
        inArray(deliveryInventory.id, list),
        or(eq(trucks.isThirdParty, true), sql`${deliveryInventory.haulageAmount} IS NOT NULL`),
      ));
    hired = new Set(found.map((r) => Number(r.id)));
  }

  // Each trip's own patch, then one UPDATE per distinct patch.
  const groups = new Map();
  for (const id of list) {
    const set = { ...patch };
    if (owned.has(id)) delete set.agoLitres;
    if (!hired.has(id)) delete set.haulageAmount;
    if (!Object.keys(set).length) continue;
    const key = Object.keys(set).sort().join("|");
    if (!groups.has(key)) groups.set(key, { set, ids: [] });
    groups.get(key).ids.push(id);
  }

  const stamp = { costedAt: new Date(), ...(actor ? { costedBy: actor } : {}) };
  const rows = [];
  for (const { set, ids: some } of groups.values()) {
    rows.push(...(await db
      .update(deliveryInventory)
      .set({ ...set, ...stamp })
      .where(inArray(deliveryInventory.id, some))
      .returning()));
  }

  return {
    rows: await costedRows(rows),
    agoKept: list.filter((id) => owned.has(id)).length,
    haulageSkipped: "haulageAmount" in patch ? list.filter((id) => !hired.has(id)).length : 0,
  };
};

module.exports = {
  setCosts,
  findById,
  findAll,
  create,
  update,
  deleteById,
};
