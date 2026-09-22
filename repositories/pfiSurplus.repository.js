const { eq, and, desc, isNull, inArray, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfis, pfiEvacuationSurpluses } = require("../db/schema");

/**
 * Evacuation surplus: product found in the tank when a PFI is run down, over
 * what the books say is left. See migration 0053.
 *
 * Every write here does three things in one transaction, under a lock on the
 * PFI row, so none of them can be seen without the others:
 *
 *   the entry           recorded, or voided
 *   the PFI's total     pfis.evacuation_surplus_litres, which every balance reads
 *   the PFI's status    a finished PFI given a surplus reopens for sale; one
 *                       whose surplus is taken back finishes again if it is
 *                       now sold out
 *
 * The lock is what makes the void check honest: reserveStock takes the same
 * row, so an order cannot sell the surplus between the check and the void.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

const listFor = (pfiId) =>
  db
    .select()
    .from(pfiEvacuationSurpluses)
    .where(eq(pfiEvacuationSurpluses.pfiId, Number(pfiId)))
    .orderBy(desc(pfiEvacuationSurpluses.recordedOn), desc(pfiEvacuationSurpluses.id));

const lockPfi = async (tx, pfiId) => {
  const [pfi] = await tx.select().from(pfis).where(eq(pfis.id, Number(pfiId))).for("update").limit(1);
  if (!pfi) throw httpError(404, "PFI not found");
  return pfi;
};

const record = async ({ pfiId, qtyLitres, recordedOn, note = "", staffId = null, staffName = "" }) =>
  db.transaction(async (tx) => {
    const pfi = await lockPfi(tx, pfiId);
    // Surplus is found on the way out. A PFI that has not traded has no
    // books to be over, and its tank figure can still simply be corrected.
    if (pfi.status === "not_started") {
      throw httpError(409, "This PFI has not started trading. Correct its tank quantity instead.");
    }

    const [entry] = await tx
      .insert(pfiEvacuationSurpluses)
      .values({
        pfiId: pfi.id,
        qtyLitres,
        recordedOn,
        note,
        recordedBy: staffId,
        recordedByName: staffName,
      })
      .returning();

    const [updated] = await tx
      .update(pfis)
      .set({
        evacuationSurplusLitres: sql`${pfis.evacuationSurplusLitres} + ${qtyLitres}`,
        // A finished PFI has litres to sell again, so it has to be orderable.
        // Same as releaseStock: the status reopens, closure details stay.
        status: pfi.status === "finished" ? "active" : pfi.status,
        updatedAt: new Date(),
      })
      .where(eq(pfis.id, pfi.id))
      .returning();

    return { entry, pfi: updated, reopened: pfi.status === "finished" };
  });

const voidEntry = async ({ pfiId, entryId, reason = "", staffId = null, staffName = "" }) =>
  db.transaction(async (tx) => {
    const pfi = await lockPfi(tx, pfiId);
    const [entry] = await tx
      .select()
      .from(pfiEvacuationSurpluses)
      .where(and(
        eq(pfiEvacuationSurpluses.id, Number(entryId)),
        eq(pfiEvacuationSurpluses.pfiId, pfi.id),
      ))
      .for("update")
      .limit(1);
    if (!entry) throw httpError(404, "Surplus entry not found");
    if (entry.voidedAt) throw httpError(409, "This surplus has already been taken back");

    /**
     * Refused once any of it has been sold: taking it back would leave the
     * PFI having sold litres it never had, and a negative balance nobody can
     * explain. The orders have to come off first.
     */
    const stock = Number(pfi.startingQtyLitres) + Number(pfi.evacuationSurplusLitres);
    const afterVoid = stock - entry.qtyLitres;
    if (Number(pfi.soldQtyLitres) > afterVoid) {
      const short = Number(pfi.soldQtyLitres) - afterVoid;
      throw httpError(
        409,
        `${short.toLocaleString()} of these litres are already on orders, so the surplus cannot be taken back.`,
      );
    }

    const [voided] = await tx
      .update(pfiEvacuationSurpluses)
      .set({ voidedAt: new Date(), voidedBy: staffId, voidedByName: staffName, voidReason: reason })
      .where(eq(pfiEvacuationSurpluses.id, entry.id))
      .returning();

    const soldOut = Number(pfi.soldQtyLitres) >= afterVoid;
    const [updated] = await tx
      .update(pfis)
      .set({
        evacuationSurplusLitres: sql`${pfis.evacuationSurplusLitres} - ${entry.qtyLitres}`,
        // The reverse of record(): sold out again means finished again, the
        // same rule markFinishedIfComplete applies after a sale.
        status: pfi.status === "active" && soldOut ? "finished" : pfi.status,
        updatedAt: new Date(),
      })
      .where(eq(pfis.id, pfi.id))
      .returning();

    return { entry: voided, pfi: updated };
  });

/**
 * Live surplus per PFI up to and including each day — for reports that run
 * day by day, so a surplus counts from the day it was found and the days
 * before it keep the balance they had.
 *
 * @returns {Promise<Array<{pfiId: number, recordedOn: string, qtyLitres: number}>>}
 */
const liveEntriesFor = (pfiIds) => {
  const ids = (pfiIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return Promise.resolve([]);
  return db
    .select({
      pfiId: pfiEvacuationSurpluses.pfiId,
      recordedOn: pfiEvacuationSurpluses.recordedOn,
      qtyLitres: pfiEvacuationSurpluses.qtyLitres,
    })
    .from(pfiEvacuationSurpluses)
    .where(and(
      isNull(pfiEvacuationSurpluses.voidedAt),
      inArray(pfiEvacuationSurpluses.pfiId, ids),
    ));
};

module.exports = { listFor, record, voidEntry, liveEntriesFor };
