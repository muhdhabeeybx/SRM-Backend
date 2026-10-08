const { eq, and, asc, desc, isNull, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { pfis, pfiPriceReviews } = require("../db/schema");

/**
 * Price reviews: a PFI's price per unit changed after it was raised. See
 * migration 0074.
 *
 * The reviewed price becomes the PFI's price — pfis.unit_price — in the same
 * transaction as the entry, under a lock on the PFI row. Every money figure is
 * computed live from that column (lib/pfiFinance.js), so the cargo value, the
 * landing cost and the profit move with the review and nothing that reads the
 * price needs to know reviews exist.
 *
 * The entries are the record. Each holds the price it replaced, so the price
 * the PFI was raised at, and every price since, stay on its file and report.
 * Only the latest live review can be taken back, which keeps the chain a
 * straight line: taking it back puts the price it replaced back on the PFI.
 *
 * Every kind of PFI may be reviewed. On a trucking or delivery batch priced
 * truck by truck in Delivery Costing, a reviewed price is what the batch is
 * costed at from then on — see batchEconomics in the frontend's
 * lib/delivery-batches.ts, which reads `priceReview` off the PFI.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/**
 * Before migration 0074 has run there is no pfi_price_reviews table. The code
 * can reach a server before the migration reaches its database, and the PFI
 * file, the register and the edit path all read reviews — so a read answers
 * "none" and only a write, which has nowhere to go, says why it cannot.
 * Drizzle wraps the driver's error, so the code may be on its cause.
 */
const noTable = (err) => err?.code === "42P01" || err?.cause?.code === "42P01";
const reviewsUnavailable = () =>
  httpError(503, "Price reviews are not available yet — the database has not been updated for them (migration 0074).");

const cents = (v) => Math.round((Number(v) || 0) * 100);
const naira = (v) =>
  `₦${Number(v).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shape = (r) => r && { ...r, price: Number(r.price), previousPrice: Number(r.previousPrice) };

/** Every review on a PFI, live and taken back — the latest first. */
const listFor = async (pfiId) => {
  try {
    const rows = await db
      .select()
      .from(pfiPriceReviews)
      .where(eq(pfiPriceReviews.pfiId, Number(pfiId)))
      .orderBy(desc(pfiPriceReviews.id));
    return rows.map(shape);
  } catch (err) {
    if (noTable(err)) return [];
    throw err;
  }
};

const lockPfi = async (tx, pfiId) => {
  const [pfi] = await tx.select().from(pfis).where(eq(pfis.id, Number(pfiId))).for("update").limit(1);
  if (!pfi) throw httpError(404, "PFI not found");
  return pfi;
};

const latestLive = async (tx, pfiId) => {
  const [row] = await tx
    .select()
    .from(pfiPriceReviews)
    .where(and(eq(pfiPriceReviews.pfiId, pfiId), isNull(pfiPriceReviews.voidedAt)))
    .orderBy(desc(pfiPriceReviews.id))
    .limit(1);
  return row || null;
};

const record = async ({ pfiId, price, effectiveOn, note = "", staffId = null, staffName = "" }) => {
  try {
    return await db.transaction(async (tx) => {
      const pfi = await lockPfi(tx, pfiId);

      // A price nobody entered is entered, not reviewed — the edit form is
      // where a PFI gets its first price.
      const current = Number(pfi.unitPrice) || 0;
      if (current <= 0) {
        throw httpError(409, "This PFI has no price yet. Enter its price on Edit details first.");
      }
      if (cents(price) === cents(current)) {
        throw httpError(409, `The price is already ${naira(current)}.`);
      }

      // The chain runs forward: a review cannot take effect before the one it
      // replaces, or the file would list a price as current that was dated
      // before the one it superseded.
      const latest = await latestLive(tx, pfi.id);
      if (latest && effectiveOn < latest.effectiveOn) {
        throw httpError(
          409,
          `The last review took effect on ${latest.effectiveOn}. A new one cannot take effect before it.`,
        );
      }

      const next = (cents(price) / 100).toFixed(2);
      const [entry] = await tx
        .insert(pfiPriceReviews)
        .values({
          pfiId: pfi.id,
          price: next,
          previousPrice: current.toFixed(2),
          effectiveOn,
          note,
          recordedBy: staffId,
          recordedByName: staffName,
        })
        .returning();

      const [updated] = await tx
        .update(pfis)
        .set({ unitPrice: next, updatedAt: new Date() })
        .where(eq(pfis.id, pfi.id))
        .returning();

      return { entry: shape(entry), pfi: updated };
    });
  } catch (err) {
    if (noTable(err)) throw reviewsUnavailable();
    throw err;
  }
};

const voidEntry = async ({ pfiId, entryId, reason = "", staffId = null, staffName = "" }) => {
  try {
    return await db.transaction(async (tx) => {
      const pfi = await lockPfi(tx, pfiId);
      const [entry] = await tx
        .select()
        .from(pfiPriceReviews)
        .where(and(eq(pfiPriceReviews.id, Number(entryId)), eq(pfiPriceReviews.pfiId, pfi.id)))
        .for("update")
        .limit(1);
      if (!entry) throw httpError(404, "Price review not found");
      if (entry.voidedAt) throw httpError(409, "This price review has already been taken back");

      const latest = await latestLive(tx, pfi.id);
      if (!latest || Number(latest.id) !== Number(entry.id)) {
        throw httpError(409, "Only the latest price review can be taken back. Take back the later one first.");
      }

      const [voided] = await tx
        .update(pfiPriceReviews)
        .set({ voidedAt: new Date(), voidedBy: staffId, voidedByName: staffName, voidReason: reason })
        .where(eq(pfiPriceReviews.id, entry.id))
        .returning();

      const [updated] = await tx
        .update(pfis)
        .set({ unitPrice: entry.previousPrice, updatedAt: new Date() })
        .where(eq(pfis.id, pfi.id))
        .returning();

      return { entry: shape(voided), pfi: updated, restoredPrice: Number(entry.previousPrice) };
    });
  } catch (err) {
    if (noTable(err)) throw reviewsUnavailable();
    throw err;
  }
};

/**
 * Per PFI with a live review: how many, the price it was raised at, and the
 * day the latest took effect — for the register, and on every PFI the API
 * returns (pfi.controller withFinancials).
 *
 * @returns {Promise<Map<number, {reviews: number, initialPrice: number, lastReviewedOn: string}>>}
 */
const summaryFor = async (pfiIds) => {
  const out = new Map();
  const ids = (pfiIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return out;
  let rows;
  try {
    rows = await db
      .select({
        pfiId: pfiPriceReviews.pfiId,
        previousPrice: pfiPriceReviews.previousPrice,
        effectiveOn: pfiPriceReviews.effectiveOn,
      })
      .from(pfiPriceReviews)
      .where(and(isNull(pfiPriceReviews.voidedAt), inArray(pfiPriceReviews.pfiId, ids)))
      .orderBy(asc(pfiPriceReviews.pfiId), asc(pfiPriceReviews.id));
  } catch (err) {
    if (noTable(err)) return out;
    throw err;
  }
  for (const r of rows) {
    const id = Number(r.pfiId);
    const s = out.get(id) || { reviews: 0, initialPrice: Number(r.previousPrice), lastReviewedOn: null };
    s.reviews += 1;
    s.lastReviewedOn = r.effectiveOn;
    out.set(id, s);
  }
  return out;
};

module.exports = { listFor, record, voidEntry, summaryFor };
