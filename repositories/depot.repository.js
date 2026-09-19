const { eq, and, or, ilike, desc, asc, count, inArray, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const {
  depots,
  depotStaff,
  depotProductCapacities,
  depotProductPrices,
  depotPriceHistory,
  depotPriceChanges,
  products,
  staff,
} = require("../db/schema");
const { scopeCondition } = require("../lib/scopeFilter");

/** postgres-js hands back an array; node-postgres wraps it in `.rows`. */
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

const findById = async (id, tx = db) => {
  const [row] = await tx.select().from(depots).where(eq(depots.id, id)).limit(1);
  return row || null;
};

const findByCode = async (code) => {
  const [row] = await db
    .select()
    .from(depots)
    .where(eq(depots.code, code))
    .limit(1);
  return row || null;
};

const findAll = async ({ search, status, scopeUser, page = 1, limit = 50 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  // A location-scoped user only sees the depots they're assigned to — same
  // fail-closed rule already applied to /pfis.
  const scope = scopeCondition(scopeUser, { depotColumn: depots.id });
  if (scope) conditions.push(scope);

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(depots.name, pattern),
        ilike(depots.code, pattern),
        ilike(depots.city, pattern),
        ilike(depots.state, pattern)
      )
    );
  }

  if (status && status !== "all") {
    conditions.push(eq(depots.status, status));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(depots)
      .where(whereClause)
      // createdAt alone ties for depots seeded/created at the same instant,
      // and Postgres doesn't preserve tie order across queries — especially
      // after an UPDATE rewrites a row. id is a strictly increasing tiebreaker
      // that keeps the list order stable regardless of what gets edited.
      .orderBy(desc(depots.createdAt), asc(depots.id))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(depots)
      .where(whereClause),
  ]);

  return {
    depots: rows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data) => {
  const [row] = await db.insert(depots).values(data).returning();
  return row;
};

const update = async (id, data) => {
  const [row] = await db
    .update(depots)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(depots.id, id))
    .returning();
  return row || null;
};

const deleteById = async (id) => {
  const [row] = await db.delete(depots).where(eq(depots.id, id)).returning();
  return row || null;
};

// ─── Staff ───────────────────────────────────────────────────────────────────

const getStaff = async (depotId) => {
  const numericDepotId = parseInt(depotId, 10) || depotId;
  const rows = await db
    .select({
      id: depotStaff.id,
      adminId: depotStaff.staffId,
      firstName: staff.firstName,
      surname: staff.surname,
      email: staff.email,
    })
    .from(depotStaff)
    .leftJoin(staff, eq(depotStaff.staffId, staff.id))
    .where(eq(depotStaff.depotId, numericDepotId));

  return rows.map((r) => ({
    ...r,
    _id: String(r.adminId),
  }));
};

const setStaff = async (depotId, adminIds) => {
  const numericDepotId = parseInt(depotId, 10) || depotId;
  await db.delete(depotStaff).where(eq(depotStaff.depotId, numericDepotId));
  if (adminIds && adminIds.length > 0) {
    // Column is `staffId`, not `adminId`: an `adminId` key is silently dropped
    // by Drizzle, leaving the NOT NULL `staff_id` unset and the insert failing.
    await db
      .insert(depotStaff)
      .values(adminIds.map((adminId) => ({ depotId: numericDepotId, staffId: parseInt(adminId, 10) || adminId })));
  }
};

// ─── Product Capacities ──────────────────────────────────────────────────────

const getProductCapacities = async (depotId) => {
  const numericDepotId = parseInt(depotId, 10) || depotId;
  const rows = await db
    .select({
      id: depotProductCapacities.id,
      productId: depotProductCapacities.productId,
      capacity: depotProductCapacities.capacity,
      productName: products.name,
      productSku: products.sku,
      productCategory: products.category,
      productUnit: products.unit,
    })
    .from(depotProductCapacities)
    .leftJoin(products, eq(depotProductCapacities.productId, products.id))
    .where(eq(depotProductCapacities.depotId, numericDepotId));

  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    capacity: r.capacity,
    productName: r.productName,
    productSku: r.productSku,
    productCategory: r.productCategory,
    product: {
      _id: String(r.productId),
      id: String(r.productId),
      name: r.productName || "Unknown Product",
      sku: r.productSku || "",
      category: r.productCategory || "",
      unit: r.productUnit || "Liters",
    },
  }));
};

const upsertProductCapacity = async (depotId, productId, capacity) => {
  const numericProductId = parseInt(productId, 10) || productId;
  const [existing] = await db
    .select()
    .from(depotProductCapacities)
    .where(
      and(
        eq(depotProductCapacities.depotId, depotId),
        eq(depotProductCapacities.productId, numericProductId)
      )
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(depotProductCapacities)
      .set({ capacity, updatedAt: new Date() })
      .where(eq(depotProductCapacities.id, existing.id))
      .returning();
    return row;
  }

  const [row] = await db
    .insert(depotProductCapacities)
    .values({ depotId, productId: numericProductId, capacity })
    .returning();
  return row;
};

const setProductCapacities = async (depotId, capacitiesList) => {
  const numericDepotId = parseInt(depotId, 10) || depotId;
  if (!Array.isArray(capacitiesList)) return;

  const validProductIds = capacitiesList.map((pc) => parseInt(pc.product, 10) || pc.product);

  const existingCapacities = await db
    .select()
    .from(depotProductCapacities)
    .where(eq(depotProductCapacities.depotId, numericDepotId));

  for (const existing of existingCapacities) {
    if (!validProductIds.includes(existing.productId) && !validProductIds.includes(String(existing.productId))) {
      await db
        .delete(depotProductCapacities)
        .where(eq(depotProductCapacities.id, existing.id));
    }
  }

  for (const pc of capacitiesList) {
    await upsertProductCapacity(numericDepotId, pc.product, pc.capacity);
  }
};

// ─── Product Prices ──────────────────────────────────────────────────────────

const getProductPrices = async (depotId) => {
  const rows = await db
    .select({
      id: depotProductPrices.id,
      productId: depotProductPrices.productId,
      currentPrice: depotProductPrices.currentPrice,
      productName: products.name,
      productSku: products.sku,
      productCategory: products.category,
      productUnit: products.unit,
    })
    .from(depotProductPrices)
    .leftJoin(products, eq(depotProductPrices.productId, products.id))
    .where(eq(depotProductPrices.depotId, depotId));

  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    currentPrice: parseFloat(r.currentPrice),
    productName: r.productName,
    productSku: r.productSku,
    productCategory: r.productCategory,
    product: {
      _id: String(r.productId),
      id: String(r.productId),
      name: r.productName || "Unknown Product",
      sku: r.productSku || "",
      category: r.productCategory || "",
      unit: r.productUnit || "Liters",
    },
  }));
};

const getProductPrice = async (depotId, productId, tx = db) => {
  const [row] = await tx
    .select()
    .from(depotProductPrices)
    .where(
      and(
        eq(depotProductPrices.depotId, depotId),
        eq(depotProductPrices.productId, productId)
      )
    )
    .limit(1);
  return row || null;
};

/**
 * Ask for a price. Nothing goes live here.
 *
 * current_price is what an order is priced from, so it is not touched: the
 * depot goes on selling at the price it has while the new one waits. Only
 * approvePriceChange moves it.
 *
 * A price identical to the one in force is not a change and is dropped — a
 * bulk save of eight products where one moved should not put seven rows in
 * front of somebody to approve.
 *
 * A second proposal for the same product supersedes the pending one rather
 * than queueing behind it. Two pending prices for one product is a question
 * nobody can answer, and the later one is what is meant. Done inside the
 * transaction so the partial unique index can never see both.
 */
const proposePriceChanges = async ({ depotId, items, staffId }) => {
  return db.transaction(async (tx) => {
    const proposed = [];
    const unchanged = [];

    for (const { productId, price } of items) {
      const [existing] = await tx
        .select()
        .from(depotProductPrices)
        .where(
          and(
            eq(depotProductPrices.depotId, Number(depotId)),
            eq(depotProductPrices.productId, Number(productId)),
          ),
        )
        .limit(1);

      const previous = existing ? String(existing.currentPrice) : null;
      if (previous != null && Number(previous) === Number(price)) {
        unchanged.push(Number(productId));
        continue;
      }

      await tx
        .update(depotPriceChanges)
        .set({ status: "superseded", reviewedAt: new Date() })
        .where(
          and(
            eq(depotPriceChanges.depotId, Number(depotId)),
            eq(depotPriceChanges.productId, Number(productId)),
            eq(depotPriceChanges.status, "pending"),
          ),
        );

      const [row] = await tx
        .insert(depotPriceChanges)
        .values({
          depotId: Number(depotId),
          productId: Number(productId),
          previousPrice: previous,
          proposedPrice: String(price),
          requestedBy: staffId ?? null,
        })
        .returning();
      proposed.push(row);
    }

    return { proposed, unchanged };
  });
};

/**
 * Approve a waiting price, and only then move the live one.
 *
 * Everything in one transaction: a change marked approved whose price never
 * landed is worse than one that was never approved, because the register says
 * the depot is selling at a price it is not.
 *
 * depot_price_history is still written, so anything already reading that trail
 * is unaffected, and it carries the change id rather than a second copy of the
 * names — one of the two copies would go stale.
 */
const approvePriceChange = async ({ changeId, staffId, note = "" }) => {
  return db.transaction(async (tx) => {
    const [change] = await tx
      .select()
      .from(depotPriceChanges)
      .where(eq(depotPriceChanges.id, Number(changeId)))
      .limit(1);

    if (!change) return { ok: false, reason: "not_found" };
    if (change.status !== "pending") return { ok: false, reason: change.status };

    const [existing] = await tx
      .select()
      .from(depotProductPrices)
      .where(
        and(
          eq(depotProductPrices.depotId, change.depotId),
          eq(depotProductPrices.productId, change.productId),
        ),
      )
      .limit(1);

    let priceRow;
    if (existing) {
      [priceRow] = await tx
        .update(depotProductPrices)
        .set({ currentPrice: change.proposedPrice, updatedAt: new Date() })
        .where(eq(depotProductPrices.id, existing.id))
        .returning();
    } else {
      [priceRow] = await tx
        .insert(depotProductPrices)
        .values({
          depotId: change.depotId,
          productId: change.productId,
          currentPrice: change.proposedPrice,
        })
        .returning();
    }

    await tx.insert(depotPriceHistory).values({
      depotProductPriceId: priceRow.id,
      price: change.proposedPrice,
      changeId: change.id,
    });

    const [updated] = await tx
      .update(depotPriceChanges)
      .set({
        status: "approved",
        reviewedBy: staffId ?? null,
        reviewedAt: new Date(),
        reviewNote: note,
      })
      .where(eq(depotPriceChanges.id, change.id))
      .returning();

    return { ok: true, change: updated, price: priceRow };
  });
};

/** Refuse a waiting price. current_price is not touched, by definition. */
const rejectPriceChange = async ({ changeId, staffId, note = "" }) => {
  const [row] = await db
    .update(depotPriceChanges)
    .set({
      status: "rejected",
      reviewedBy: staffId ?? null,
      reviewedAt: new Date(),
      reviewNote: note,
    })
    .where(
      and(eq(depotPriceChanges.id, Number(changeId)), eq(depotPriceChanges.status, "pending")),
    )
    .returning();
  return row || null;
};

/**
 * The trail: every change, with the names on both ends.
 *
 * Both people are resolved here rather than by the caller, because "changed by
 * whom, approved by whom" is the whole question this table exists to answer
 * and a screen that had to fetch staff separately would show ids while it
 * waited.
 */
const listPriceChanges = async ({ depotId = null, status = null, limit = 200 } = {}) => {
  return rowsOf(await db.execute(sql`
    SELECT c.id, c.depot_id AS "depotId", c.product_id AS "productId",
           c.previous_price AS "previousPrice", c.proposed_price AS "proposedPrice",
           c.status, c.requested_at AS "requestedAt", c.reviewed_at AS "reviewedAt",
           c.review_note AS "reviewNote",
           d.name AS "depotName", p.name AS "productName", p.unit AS "productUnit",
           NULLIF(TRIM(CONCAT_WS(' ', rq.first_name, rq.surname)), '') AS "requestedByName",
           NULLIF(TRIM(CONCAT_WS(' ', rv.first_name, rv.surname)), '') AS "reviewedByName"
      FROM depot_price_changes c
      JOIN depots d   ON d.id = c.depot_id
      JOIN products p ON p.id = c.product_id
      LEFT JOIN staff rq ON rq.id = c.requested_by
      LEFT JOIN staff rv ON rv.id = c.reviewed_by
     WHERE (${depotId}::int IS NULL OR c.depot_id = ${depotId}::int)
       AND (${status}::text IS NULL OR c.status = ${status}::text)
     ORDER BY c.requested_at DESC, c.id DESC
     LIMIT ${Math.min(Number(limit) || 200, 1000)}
  `));
};

const upsertProductPrice = async (depotId, productId, price) => {
  const [existing] = await db
    .select()
    .from(depotProductPrices)
    .where(
      and(
        eq(depotProductPrices.depotId, depotId),
        eq(depotProductPrices.productId, productId)
      )
    )
    .limit(1);

  if (existing) {
    const [row] = await db
      .update(depotProductPrices)
      .set({ currentPrice: price, updatedAt: new Date() })
      .where(eq(depotProductPrices.id, existing.id))
      .returning();
    // Add price history
    await db.insert(depotPriceHistory).values({
      depotProductPriceId: existing.id,
      price,
    });
    return row;
  }

  const [row] = await db
    .insert(depotProductPrices)
    .values({ depotId, productId, currentPrice: price })
    .returning();
  // Add price history
  await db.insert(depotPriceHistory).values({
    depotProductPriceId: row.id,
    price,
  });
  return row;
};

/**
 * Take every product off sale, everywhere: set all depot prices to 0.
 *
 * Zero is how this system records "we do not sell this here" — see
 * schemas/depot.schema.js. Doing it one depot at a time is thirteen dialogs
 * and thirteen chances to miss one, and a missed one leaves that depot quietly
 * still trading, which is exactly the state this action exists to prevent.
 *
 * One transaction, and every row keeps its history: the price it held before
 * is written to depot_price_history alongside the zero, so "what was PMS at
 * Calabar before we closed everything" is still answerable afterwards. A bulk
 * action that erased that would be worse than doing it by hand.
 *
 * Rows already at 0 are skipped — they are already off sale, and re-writing
 * them would put a meaningless 0-to-0 entry in the history of every one.
 *
 * @returns {{updated: number, skipped: number, before: Array}} what moved
 */
const zeroAllProductPrices = async () => {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: depotProductPrices.id,
        depotId: depotProductPrices.depotId,
        productId: depotProductPrices.productId,
        currentPrice: depotProductPrices.currentPrice,
      })
      .from(depotProductPrices)
      .for("update");

    const toZero = rows.filter((r) => Number(r.currentPrice) !== 0);
    if (!toZero.length) {
      return { updated: 0, skipped: rows.length, before: [] };
    }

    await tx
      .update(depotProductPrices)
      .set({ currentPrice: "0.00", updatedAt: new Date() })
      .where(inArray(depotProductPrices.id, toZero.map((r) => r.id)));

    await tx.insert(depotPriceHistory).values(
      toZero.map((r) => ({ depotProductPriceId: r.id, price: "0.00" })),
    );

    return {
      updated: toZero.length,
      skipped: rows.length - toZero.length,
      // What each one was, so the response and the audit row can say.
      before: toZero.map((r) => ({
        depotId: r.depotId,
        productId: r.productId,
        price: r.currentPrice,
      })),
    };
  });
};

const getPriceHistory = async (depotProductPriceId) => {
  return db
    .select()
    .from(depotPriceHistory)
    .where(eq(depotPriceHistory.depotProductPriceId, depotProductPriceId))
    .orderBy(desc(depotPriceHistory.setAt));
};

const updateSubaccountFields = async (id, data) => {
  const [row] = await db
    .update(depots)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(depots.id, id))
    .returning();
  return row || null;
};

module.exports = {
  findById,
  findByCode,
  findAll,
  create,
  update,
  deleteById,
  getStaff,
  setStaff,
  getProductCapacities,
  setProductCapacities,
  upsertProductCapacity,
  getProductPrices,
  getProductPrice,
  upsertProductPrice,
  proposePriceChanges,
  approvePriceChange,
  rejectPriceChange,
  listPriceChanges,
  zeroAllProductPrices,
  getPriceHistory,
  updateSubaccountFields,
};
