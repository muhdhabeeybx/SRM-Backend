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
const tripOwnerPayments = require("./tripOwnerPayment.repository");

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

/**
 * The Feeding payment request each trip's feeding is on (0095): its
 * reference and where it stands. A request deleted in Expenses reads as none.
 */
const feedingRequests = async (expenseIds) => {
  const ids = [...new Set(expenseIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const result = await db.execute(sql`
    SELECT id, reference_number AS reference, status::text AS status
      FROM pfi_expenses
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND deleted_at IS NULL`);
  return new Map((result.rows ?? result).map((e) => [Number(e.id), { id: Number(e.id), reference: e.reference, status: e.status }]));
};

const withFeedingRequests = async (rows) => {
  const found = await feedingRequests(rows.filter(Boolean).map((r) => r.feedingExpenseId));
  return rows.map((r) => (r ? { ...r, feedingRequest: found.get(Number(r.feedingExpenseId)) ?? null } : r));
};

/**
 * A hired truck's part of the payment requests raised to its owner (0098):
 * what is paid, what is asked for and not paid yet, and each request.
 */
const withOwnerPayments = async (rows) => {
  const ids = rows.filter(Boolean).map((r) => r.id);
  const [found, rates] = await Promise.all([tripOwnerPayments.forTrips(ids), tripOwnerPayments.haulageRates(ids)]);
  return rows.map((r) => (r
    ? { ...r, ownerPayments: found.get(Number(r.id)) ?? null, haulageRate: rates.get(Number(r.id)) ?? null }
    : r));
};

const costedRows = async (rows) =>
  (await withOwnerPayments(await withFeedingRequests(await withTruckOwners(await withLedgerAgo(rows))))).map(withCosts);

/** Past pending, a request's figures are being acted on: the feeding behind it is fixed. */
const FEEDING_OPEN = new Set(["pending", "rejected"]);
const feedingLockedIds = async (ids) => {
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length) return new Set();
  const result = await db.execute(sql`
    SELECT d.id, e.status::text AS status
      FROM delivery_inventory d
      JOIN pfi_expenses e ON e.id = d.feeding_expense_id AND e.deleted_at IS NULL
     WHERE d.id IN (${sql.join(list.map((id) => sql`${id}`), sql`, `)})`);
  return new Set((result.rows ?? result).filter((r) => !FEEDING_OPEN.has(r.status)).map((r) => Number(r.id)));
};

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
  if (!list.length) return { rows: [], agoKept: 0, haulageSkipped: 0, feedingLocked: 0, feedingSkippedHired: 0, feedingTouched: [] };

  /**
   * The haulage rate per litre (0098) is written apart from the drizzle
   * columns (repositories/tripOwnerPayment). `undefined` leaves it alone,
   * null clears it, as for the figures below.
   */
  let haulageRate;
  if (values.haulageRate !== undefined) {
    if (values.haulageRate === null || values.haulageRate === "") {
      if (clearBlank) haulageRate = null;
    } else {
      haulageRate = Number(values.haulageRate);
    }
  }

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
  const ratesHaulage = haulageRate !== undefined;
  if (!Object.keys(patch).length && !ratesHaulage) {
    return { rows: [], agoKept: 0, haulageSkipped: 0, feedingLocked: 0, feedingSkippedHired: 0, feedingTouched: [] };
  }

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
  if ("haulageAmount" in patch || ratesHaulage) {
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

  /**
   * A hired truck's driver is fed by its owner (the user, 2026-10-26), so
   * feeding is written only to our own trucks. Clearing it is always allowed.
   */
  let hiredTrucks = new Set();
  if (patch.feedingAllowance != null) {
    const found = await db
      .select({ id: deliveryInventory.id })
      .from(deliveryInventory)
      .innerJoin(trucks, eq(trucks.id, deliveryInventory.truckId))
      .where(and(inArray(deliveryInventory.id, list), eq(trucks.isThirdParty, true)));
    hiredTrucks = new Set(found.map((r) => Number(r.id)));
  }

  /**
   * Feeding on a payment request that finance has taken forward (verified,
   * approved or paid) is what that request was approved for: it is left as
   * it is, and the caller told how many.
   */
  const touchesFeeding = "feedingAllowance" in patch || "feedingInExpenses" in patch;
  const locked = touchesFeeding ? await feedingLockedIds(list) : new Set();

  // Each trip's own patch, then one UPDATE per distinct patch.
  const groups = new Map();
  const feedingTouched = [];
  for (const id of list) {
    const set = { ...patch };
    if (owned.has(id)) delete set.agoLitres;
    if (!hired.has(id)) delete set.haulageAmount;
    if (hiredTrucks.has(id)) {
      delete set.feedingAllowance;
      delete set.feedingInExpenses;
    }
    if (locked.has(id)) {
      delete set.feedingAllowance;
      delete set.feedingInExpenses;
    } else if (touchesFeeding && !hiredTrucks.has(id)) {
      feedingTouched.push(id);
    }
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
  // The rate goes on the hired trucks only, like a lump sum.
  if (ratesHaulage) {
    const rated = list.filter((id) => hired.has(id));
    if (rated.length) {
      await tripOwnerPayments.setHaulageRate(rated, haulageRate);
      const have = new Set(rows.map((r) => Number(r.id)));
      const more = rated.filter((id) => !have.has(id));
      await db.update(deliveryInventory).set(stamp).where(inArray(deliveryInventory.id, rated));
      if (more.length) rows.push(...(await db.select().from(deliveryInventory).where(inArray(deliveryInventory.id, more))));
    }
  }

  return {
    rows: await costedRows(rows),
    agoKept: list.filter((id) => owned.has(id)).length,
    haulageSkipped: "haulageAmount" in patch || ratesHaulage ? list.filter((id) => !hired.has(id)).length : 0,
    feedingLocked: locked.size,
    feedingSkippedHired: hiredTrucks.size,
    /** Trips whose feeding was written — their payment requests follow. */
    feedingTouched,
  };
};

/** Trips by id, costed — what a save hands back once its requests are settled. */
const findCostedByIds = async (ids) => {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!list.length) return [];
  return costedRows(await db.select().from(deliveryInventory).where(inArray(deliveryInventory.id, list)));
};

module.exports = {
  setCosts,
  costedRows,
  findCostedByIds,
  feedingLockedIds,
  findById,
  findAll,
  create,
  update,
  deleteById,
};
