const { eq, and, or, ilike, desc, asc, count, sql, gte, lte } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfis, depots, products, staff, pfiStaff, bankAccounts, deliveryInventory } = require("../db/schema");
const { lpgStations } = require("../db/schema/lpgStation");
const { scopeCondition } = require("../lib/scopeFilter");
const { orderReferenceSql } = require("../lib/orderReferenceSql");

/**
 * A batch's location, resolved rather than trusted.
 *
 * `pfis.location_name` is a denormalised copy written when a PFI is created,
 * and it is not reliably maintained — five active batches carry a blank one
 * against a perfectly good location_id, which left every consumer showing no
 * location at all (the daily-report form's "pick a PFI and the location
 * fills in" did nothing on exactly those batches).
 *
 * The foreign key is the truth, so this prefers the joined name and only
 * falls back to the stored copy for a row whose location was recorded as
 * free text with no id behind it.
 */
const LOCATION_NAME = sql`
  COALESCE(
    NULLIF(${depots.name}, ''),
    NULLIF(${lpgStations.name}, ''),
    NULLIF(${pfis.locationName}, ''),
    ''
  )
`;

const findById = async (id) => {
  const numericId = parseInt(id, 10) || id;
  const [row] = await db
    .select({ pfi: pfis, resolvedLocationName: LOCATION_NAME })
    .from(pfis)
    .leftJoin(depots, eq(pfis.locationId, depots.id))
    .leftJoin(lpgStations, eq(pfis.lpgStationId, lpgStations.id))
    .where(eq(pfis.id, numericId))
    .limit(1);
  if (!row) return null;
  return {
    ...row.pfi,
    locationName: row.resolvedLocationName || row.pfi.locationName || "",
    _id: String(row.pfi.id),
  };
};

const findByNumber = async (pfiNumber) => {
  const [row] = await db
    .select()
    .from(pfis)
    .where(eq(pfis.pfiNumber, pfiNumber))
    .limit(1);
  if (!row) return null;
  return { ...row, _id: String(row.id) };
};

const findAll = async ({ search, status, location, type, scopeUser, page = 1, limit = 100 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  const scope = scopeCondition(scopeUser, {
    depotColumn: pfis.locationId,
    lpgStationColumn: pfis.lpgStationId,
    pfiColumn: pfis.id,
  });
  if (scope) conditions.push(scope);

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(pfis.pfiNumber, pattern),
        ilike(pfis.description, pattern),
        ilike(pfis.locationName, pattern),
        ilike(pfis.productName, pattern)
      )
    );
  }

  if (status && status !== "all") {
    conditions.push(eq(pfis.status, status));
  }

  if (type && type !== "all") {
    conditions.push(eq(pfis.pfiType, type));
  }

  if (location) {
    const numericLocation = parseInt(location, 10) || location;
    conditions.push(eq(pfis.locationId, numericLocation));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ pfi: pfis, resolvedLocationName: LOCATION_NAME, resolvedProductName: products.name })
      .from(pfis)
      .leftJoin(depots, eq(pfis.locationId, depots.id))
      .leftJoin(lpgStations, eq(pfis.lpgStationId, lpgStations.id))
      // `product_name` is a denormalised copy and is blank on 27 of the 44
      // batches on the live book — every one of which has a perfectly good
      // product_id behind it. Joining the real name means stock can be
      // totalled per fuel instead of most of the book landing in an "unnamed
      // product" bucket. Same shape as the location join above.
      .leftJoin(products, eq(pfis.productId, products.id))
      .where(whereClause)
      .orderBy(asc(pfis.status), desc(pfis.createdAt))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(pfis)
      .where(whereClause),
  ]);

  const enrichedRows = rows.map(({ pfi, resolvedLocationName, resolvedProductName }) => ({
    ...pfi,
    locationName: resolvedLocationName || pfi.locationName || "",
    // The stored copy wins where it has one — it records what the batch was
    // called at the time, which a since-renamed product row would not.
    productName: pfi.productName || resolvedProductName || "",
    _id: String(pfi.id),
  }));

  return {
    pfis: enrichedRows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

/**
 * The batches a depot may sell from, for one product.
 *
 * Two ways to match, not one:
 *
 *   the batch lives here      `location_id` — a coastal cargo is sold out of
 *                             the depot it landed at, which is how this has
 *                             always worked
 *   the batch is lent here    a delivery allocation is loaded at one depot
 *                             and drawn on by others, so a depot on its
 *                             allowlist may sell from it too
 *
 * Deliberately a widening rather than a restriction. Every batch that matched
 * before still matches — the allowlist can only ADD, never subtract — so no
 * order that places today can start failing because of this. A delivery batch
 * whose locations nobody has set yet simply behaves like any other batch,
 * sellable at the depot it was loaded at and nowhere else, which is the safe
 * reading of an empty list rather than an unsellable one.
 */
const findActiveByDepotAndProduct = async (depotId, productId) => {
  return db
    .select()
    .from(pfis)
    .where(
      and(
        eq(pfis.productId, productId),
        eq(pfis.status, "active"),
        or(
          eq(pfis.locationId, depotId),
          sql`EXISTS (
            SELECT 1 FROM pfi_allowed_locations al
             WHERE al.pfi_id = ${pfis.id} AND al.depot_id = ${depotId}
          )`
        )
      )
    )
    .orderBy(asc(pfis.createdAt));
};

const create = async (data) => {
  const [row] = await db.insert(pfis).values(data).returning();
  return row;
};

/**
 * Release a PFI to trade: assign, grant sight, write the batch, record who.
 *
 * All of it in one transaction. Half of this is worse than none — a PFI marked
 * active whose officers were not granted sight of it is a batch nobody can
 * see, and a batch written to inventory under a PFI that failed to activate is
 * stock owed against nothing.
 */
const activate = async ({ pfiId, bankAccountIds = [], officers = {}, activatedBy, note = "" }) => {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(pfis).where(eq(pfis.id, pfiId)).limit(1);
    if (!current) throw new Error("PFI not found");

    const OFFICER_FIELDS = [
      "auditOfficerId", "productOfficerId", "itComplianceOfficerId",
      "securityExitOfficerId", "commissionOfficerId", "salesManagerId",
    ];
    const assigned = {};
    for (const field of OFFICER_FIELDS) {
      if (officers[field] != null && officers[field] !== "") {
        assigned[field] = Number(officers[field]);
      }
    }

    const [pfi] = await tx
      .update(pfis)
      .set({
        ...assigned,
        status: "active",
        activatedBy,
        activatedAt: new Date(),
        reviewNote: note,
        // Spent. Keeping it would leave a draft that reads as still-pending
        // beside the rows it has already become.
        pendingBatch: null,
        updatedAt: new Date(),
      })
      .where(eq(pfis.id, pfiId))
      .returning();

    /**
     * Assignment IS access. pfi_staff is what scopeCondition reads, so an
     * officer named on the PFI but absent here would be answerable for a batch
     * they cannot open.
     */
    const staffIds = [...new Set(
      OFFICER_FIELDS.map((f) => assigned[f] ?? current[f]).filter(Boolean).map(Number),
    )];
    for (const staffId of staffIds) {
      await tx.insert(pfiStaff).values({ pfiId, staffId }).onConflictDoNothing();
    }

    // Which accounts collect for this batch. Appended, never replaced: an
    // account already collecting for other PFIs must keep them.
    for (const accountId of bankAccountIds) {
      const [account] = await tx
        .select({ id: bankAccounts.id, pfiIds: bankAccounts.pfiIds })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, accountId))
        .limit(1);
      if (!account) continue;
      const existing = Array.isArray(account.pfiIds) ? account.pfiIds.map(Number) : [];
      if (existing.includes(Number(pfiId))) continue;
      await tx
        .update(bankAccounts)
        .set({ pfiIds: [...existing, Number(pfiId)], updatedAt: new Date() })
        .where(eq(bankAccounts.id, accountId));
    }

    // A trucking batch's loads reach the inventory here and nowhere earlier.
    let batch = null;
    const pending = current.pendingBatch;
    if (pending && Array.isArray(pending.trucks) && pending.trucks.length) {
      const code = String(pending.code || "").trim().toUpperCase().replace(/\s+/g, "-");
      for (const truck of pending.trucks) {
        await tx.insert(deliveryInventory).values({
          allocationCode: code,
          truckId: truck.truckId != null ? Number(truck.truckId) : null,
          truckNumber: truck.plateNumber || "",
          depot: pending.depotName || "",
          pfiProduct: pending.productName || "",
          quantityAllocated: Number(truck.loadedQty) || 0,
          dateAllocated: pending.dateAllocated || null,
          loadingStatus: "loaded",
        });
      }
      batch = { code, trucks: pending.trucks.length };
    }

    return { pfi, batch };
  });
};

const update = async (id, data) => {
  const [row] = await db
    .update(pfis)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(pfis.id, id))
    .returning();
  return row || null;
};

const deleteById = async (id) => {
  const [row] = await db.delete(pfis).where(eq(pfis.id, id)).returning();
  return row || null;
};

const reserveStock = async (pfiId, quantity, tx = db) => {
  const [row] = await tx
    .update(pfis)
    .set({
      soldQtyLitres: sql`${pfis.soldQtyLitres} + ${quantity}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pfis.id, pfiId),
        eq(pfis.status, "active"),
        sql`(${pfis.startingQtyLitres} - ${pfis.soldQtyLitres}) >= ${quantity}`
      )
    )
    .returning();
  return row || null;
};

const releaseStock = async (pfiId, quantity, tx = db) => {
  const [pfi] = await tx
    .select()
    .from(pfis)
    .where(eq(pfis.id, pfiId))
    .for("update")
    .limit(1);
  if (!pfi) return null;

  const wasFinished = pfi.status === "finished";

  const [row] = await tx
    .update(pfis)
    .set({
      soldQtyLitres: sql`GREATEST(${pfis.soldQtyLitres} - ${quantity}, 0)`,
      status: wasFinished ? "active" : pfi.status,
      updatedAt: new Date(),
    })
    .where(eq(pfis.id, pfiId))
    .returning();

  return row || null;
};

const markFinishedIfComplete = async (pfiId, tx = db) => {
  const [row] = await tx
    .update(pfis)
    .set({ status: "finished", updatedAt: new Date() })
    .where(
      and(
        eq(pfis.id, pfiId),
        sql`${pfis.soldQtyLitres} >= ${pfis.startingQtyLitres}`
      )
    )
    .returning();
  return row || null;
};

/**
 * Which depots may sell from a batch, and the trucks that carried it.
 *
 * Both are delivery-batch concerns. A coastal cargo is sold out of the depot
 * it landed at and measured into a tank, so neither table has rows for one —
 * an empty list here means "not a delivery batch", not "misconfigured".
 */
// postgres.js returns the rows array directly; the pg driver wraps them in
// `.rows`. Both shapes appear across this codebase, so neither is assumed.
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

const allowedDepots = async (pfiId) => {
  const rows = rowsOf(await db.execute(sql`
    SELECT d.id, d.name, d.city, d.state
      FROM pfi_allowed_locations al
      JOIN depots d ON d.id = al.depot_id
     WHERE al.pfi_id = ${Number(pfiId)}
     ORDER BY d.name ASC
  `));
  return rows;
};

/**
 * Replace the allowlist wholesale.
 *
 * Wholesale rather than a diff: the page edits it as a set of checkboxes, and
 * a diff would have to reconstruct what was ticked from what changed. Done in
 * one transaction so a half-applied list cannot leave a batch sellable
 * somewhere nobody chose.
 */
const setAllowedDepots = async (pfiId, depotIds, staffId = null) => {
  const unique = [...new Set((depotIds || []).map(Number).filter(Boolean))];
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM pfi_allowed_locations WHERE pfi_id = ${Number(pfiId)}`);
    for (const depotId of unique) {
      await tx.execute(sql`
        INSERT INTO pfi_allowed_locations (pfi_id, depot_id, created_by)
        VALUES (${Number(pfiId)}, ${depotId}, ${staffId})
        ON CONFLICT (pfi_id, depot_id) DO NOTHING
      `);
    }
    return unique;
  });
};

/** May this depot sell from this batch? */
const depotMaySell = async (pfiId, depotId) => {
  const rows = rowsOf(await db.execute(sql`
    SELECT 1 FROM pfi_allowed_locations
     WHERE pfi_id = ${Number(pfiId)} AND depot_id = ${Number(depotId)}
     LIMIT 1
  `));
  return rows.length > 0;
};

const trucksFor = async (pfiId) => {
  const rows = rowsOf(await db.execute(sql`
    SELECT pt.id, pt.truck_id AS "truckId", pt.plate_number AS "plateNumber",
           pt.capacity_litres AS "capacity", pt.loaded_qty_litres AS "loadedQty",
           pt.loaded_at AS "loadedAt", pt.notes,
           (pt.capacity_litres - pt.loaded_qty_litres) AS "shortBy"
      FROM pfi_trucks pt
     WHERE pt.pfi_id = ${Number(pfiId)}
     ORDER BY pt.loaded_at ASC NULLS LAST, pt.id ASC
  `));
  return rows;
};

/**
 * Replace the manifest. The batch's own quantity is not touched.
 *
 * It used to be: saving a manifest rewrote `starting_qty_litres` to the sum of
 * what the trucks loaded, on the reasoning that a delivery batch IS its
 * trucks. The cost of that was a PFI type whose headline figure nobody could
 * state — it was owned by the truck rows, could not be typed on the form, and
 * changed under the batch whenever a manifest was edited.
 *
 * A delivery PFI is a PFI that happens to be delivered. Its quantity is a fact
 * about the batch, typed on the PFI form like every other type's, and every
 * landing cost and sell-through figure derives from that. The manifest is a
 * record of what carried it, which is a different question and no longer
 * allowed to answer this one.
 *
 * Capacities are still never summed — a 50,000 truck that took 47,300 carried
 * 47,300 — and the loaded total is still returned, so a caller that wants to
 * show the manifest against the batch quantity can.
 */
const setTrucks = async (pfiId, trucks, staffId = null) => {
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM pfi_trucks WHERE pfi_id = ${Number(pfiId)}`);

    let total = 0;
    for (const t of trucks || []) {
      const loaded = Number(t.loadedQty ?? t.loaded_qty ?? 0);
      if (!Number.isFinite(loaded) || loaded <= 0) continue;
      total += loaded;
      await tx.execute(sql`
        INSERT INTO pfi_trucks
          (pfi_id, truck_id, plate_number, capacity_litres, loaded_qty_litres, loaded_at, notes, recorded_by)
        VALUES (
          ${Number(pfiId)},
          ${t.truckId ?? t.truck_id ?? null},
          ${String(t.plateNumber ?? t.plate_number ?? "").trim()},
          ${t.capacity ?? null},
          ${loaded},
          ${t.loadedAt ?? t.loaded_at ?? null},
          ${String(t.notes ?? "").trim()},
          ${staffId}
        )
      `);
    }

    // Deliberately no UPDATE on pfis here — see the note above. `quantity` is
    // what the manifest adds up to, reported back for display, not written to
    // the batch.
    return { trucks: (trucks || []).length, quantity: Math.round(total) };
  });
};

/**
 * What is still outstanding on a batch, for the desk about to close it.
 *
 * Closing a PFI takes it out of the stock totals and off the active register.
 * Anything still moving on it — an order nobody ticketed, a truck that never
 * reached the gate — stops being visible at the moment it stops being
 * actionable, and the batch closes with litres unaccounted for.
 *
 * Three different kinds of unfinished, kept apart because they need different
 * people:
 *
 *   unticketed   paid orders whose tickets have not been generated. The
 *                loading desk's work, and the reason the litres show as sold
 *                but not loaded.
 *   trucksIn     trucks admitted to the yard that never gated out. Security's.
 *   trucksDue    trucks ticketed but never admitted. Also security's, at the
 *                other end.
 *
 * Deliberately a report and not a refusal. The desk closes batches knowing
 * things the system does not, and a hard block would be worked around by
 * leaving batches open forever — which is the state this is trying to end.
 */
const outstandingWork = async (pfiId) => {
  const id = Number(pfiId);

  const orderRows = rowsOf(await db.execute(sql`
    SELECT o.id, ${orderReferenceSql("o", "c")} AS "orderNumber", o.status, o.quantity,
           c.name AS "customerName",
           COALESCE((SELECT SUM(t.quantity) FROM order_trucks t WHERE t.order_id = o.id), 0)::int AS ticketed
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.pfi_id = ${id}
       AND o.payment_status IN ('Paid', 'Part Paid')
       AND o.status IN ('Paid', 'Released', 'Loading')
     ORDER BY o.id
  `));

  const unticketed = orderRows
    .map((r) => ({ ...r, shortBy: Number(r.quantity) - Number(r.ticketed) }))
    .filter((r) => r.shortBy > 0);

  const truckRows = rowsOf(await db.execute(sql`
    SELECT t.id, t.truck_number AS "truckNumber", t.status, t.quantity,
           ${orderReferenceSql("o", null)} AS "orderNumber"
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
     WHERE o.pfi_id = ${id}
       AND t.status IN ('pending', 'gated_in')
     ORDER BY t.status, t.id
  `));

  const trucksDue = truckRows.filter((t) => t.status === "pending");
  const trucksIn = truckRows.filter((t) => t.status === "gated_in");

  return {
    unticketed,
    trucksDue,
    trucksIn,
    /** Litres on orders whose tickets were never generated. */
    unticketedLitres: unticketed.reduce((sum, r) => sum + r.shortBy, 0),
    clean: unticketed.length === 0 && truckRows.length === 0,
  };
};

module.exports = {
  outstandingWork,
  allowedDepots,
  setAllowedDepots,
  depotMaySell,
  trucksFor,
  setTrucks,
  findById,
  findByNumber,
  findAll,
  findActiveByDepotAndProduct,
  create,
  activate,
  update,
  deleteById,
  reserveStock,
  releaseStock,
  markFinishedIfComplete,
};
