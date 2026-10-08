const { eq, and, desc, isNull, inArray, sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfis, pfiOperationalLosses } = require("../db/schema");
const { sellableQty } = require("../lib/pfiStock");

/**
 * Operational loss: product that left a PFI's tank without being sold. The
 * mirror of the evacuation surplus (repositories/pfiSurplus.repository.js) —
 * see migration 0073.
 *
 * Every write does three things in one transaction, under a lock on the PFI
 * row, so none of them can be seen without the others:
 *
 *   the entry           recorded, or voided
 *   the PFI's total     pfis.operational_loss_litres, which every balance reads
 *   the PFI's status    a loss that takes the last of the stock finishes the
 *                       PFI, as selling the last litre would; voiding a loss
 *                       on a finished PFI puts the litres back and reopens it
 *
 * The lock is what makes the record check honest: reserveStock takes the same
 * row, so an order cannot sell the litres between the check and the loss.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

const listFor = (pfiId) =>
  db
    .select()
    .from(pfiOperationalLosses)
    .where(eq(pfiOperationalLosses.pfiId, Number(pfiId)))
    .orderBy(desc(pfiOperationalLosses.recordedOn), desc(pfiOperationalLosses.id));

const lockPfi = async (tx, pfiId) => {
  const [pfi] = await tx.select().from(pfis).where(eq(pfis.id, Number(pfiId))).for("update").limit(1);
  if (!pfi) throw httpError(404, "PFI not found");
  return pfi;
};

const record = async ({ pfiId, qtyLitres, recordedOn, note = "", staffId = null, staffName = "" }) =>
  db.transaction(async (tx) => {
    const pfi = await lockPfi(tx, pfiId);
    // A PFI that has not traded can simply have its tank figure corrected.
    if (pfi.status === "not_started") {
      throw httpError(409, "This PFI has not started trading. Correct its tank quantity instead.");
    }

    /**
     * Only what is still unsold can be lost. Litres already on orders belong
     * to the customers who bought them; taking a loss out of those would leave
     * the PFI having sold more than it held.
     */
    const left = sellableQty(pfi);
    if (qtyLitres > left) {
      throw httpError(
        409,
        `Only ${left.toLocaleString()} is left unsold on this PFI, so a loss of ${qtyLitres.toLocaleString()} cannot be taken from it.`,
      );
    }

    const [entry] = await tx
      .insert(pfiOperationalLosses)
      .values({
        pfiId: pfi.id,
        qtyLitres,
        recordedOn,
        note,
        recordedBy: staffId,
        recordedByName: staffName,
      })
      .returning();

    // Nothing left means finished — the rule markFinishedIfComplete applies
    // after a sale.
    const emptied = left - qtyLitres <= 0;
    const [updated] = await tx
      .update(pfis)
      .set({
        operationalLossLitres: sql`${pfis.operationalLossLitres} + ${qtyLitres}`,
        status: pfi.status === "active" && emptied ? "finished" : pfi.status,
        updatedAt: new Date(),
      })
      .where(eq(pfis.id, pfi.id))
      .returning();

    return { entry, pfi: updated, finished: pfi.status === "active" && emptied };
  });

const voidEntry = async ({ pfiId, entryId, reason = "", staffId = null, staffName = "" }) =>
  db.transaction(async (tx) => {
    const pfi = await lockPfi(tx, pfiId);
    const [entry] = await tx
      .select()
      .from(pfiOperationalLosses)
      .where(and(
        eq(pfiOperationalLosses.id, Number(entryId)),
        eq(pfiOperationalLosses.pfiId, pfi.id),
      ))
      .for("update")
      .limit(1);
    if (!entry) throw httpError(404, "Loss entry not found");
    if (entry.voidedAt) throw httpError(409, "This loss has already been taken back");

    const [voided] = await tx
      .update(pfiOperationalLosses)
      .set({ voidedAt: new Date(), voidedBy: staffId, voidedByName: staffName, voidReason: reason })
      .where(eq(pfiOperationalLosses.id, entry.id))
      .returning();

    // The litres are back in the tank, so a finished PFI can sell them again.
    // Same as releaseStock: the status reopens, closure details stay.
    const [updated] = await tx
      .update(pfis)
      .set({
        operationalLossLitres: sql`${pfis.operationalLossLitres} - ${entry.qtyLitres}`,
        status: pfi.status === "finished" ? "active" : pfi.status,
        updatedAt: new Date(),
      })
      .where(eq(pfis.id, pfi.id))
      .returning();

    return { entry: voided, pfi: updated, reopened: pfi.status === "finished" };
  });

/**
 * Live losses per PFI with the day each was found — for reports that run day
 * by day, so a loss counts from that day and the days before keep their
 * balance.
 *
 * @returns {Promise<Array<{pfiId: number, recordedOn: string, qtyLitres: number}>>}
 */
const liveEntriesFor = (pfiIds) => {
  const ids = (pfiIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return Promise.resolve([]);
  return db
    .select({
      pfiId: pfiOperationalLosses.pfiId,
      recordedOn: pfiOperationalLosses.recordedOn,
      qtyLitres: pfiOperationalLosses.qtyLitres,
    })
    .from(pfiOperationalLosses)
    .where(and(
      isNull(pfiOperationalLosses.voidedAt),
      inArray(pfiOperationalLosses.pfiId, ids),
    ));
};

module.exports = { listFor, record, voidEntry, liveEntriesFor };
