const { eq } = require("drizzle-orm");
const { db } = require("../config/db");
const { orderTrucks } = require("../db/schema");
const commissionRepo = require("../repositories/commission.repository");
const { orderRepo, customerRepo } = require("../repositories");
const auditLogRepo = require("../repositories/auditLog.repository");

/**
 * Create — or re-snapshot — the commission record for a paid order.
 *
 * Called after an order takes money. Looks up the commission rate for the
 * order's depot+product and records a snapshot of the quantity commission is
 * due on.
 *
 * ── The basis, and why a part payment changes it ──────────────────────────
 *
 * Commission is per litre, so the question is only ever "how many litres".
 *
 *   Fully paid   the loaded quantity if the trucks are out, else the order's
 *                own quantity. Unchanged from before part payments existed,
 *                which is what keeps every historical order computing the
 *                same figure it always did.
 *
 *   Part paid    the quantity actually paid for, and nothing more. Taking
 *                order.quantity here — as this did before instalments were
 *                possible — would credit the whole order's commission off a
 *                half-landed payment. The truck sum is not used: it cannot
 *                exceed the paid quantity anyway (generate-tickets caps loads
 *                at exactly that), so preferring it would only ever
 *                under-credit an order whose trucks have not all rolled yet.
 *
 * Each instalment therefore enlarges the basis, and the total lands on the
 * same figure a single full payment would have produced.
 *
 * ── Re-snapshotting ───────────────────────────────────────────────────────
 *
 * This used to return early whenever a commission already existed, which is
 * what made it safe to call from the post-payment effects on every retry. It
 * still is: a row whose basis has not moved is returned untouched. But an
 * instalment HAS moved it, so the pending row is rewritten rather than left
 * describing the first payment forever.
 *
 * A commission already marked paid is never rewritten — that money has left,
 * and a snapshot is a record of what was paid on, not a live calculation.
 *
 * If no rate is configured, commission is created with rate=0 so it
 * still appears on the page — admin can set the rate later.
 */
/**
 * What this order's commission is priced at, and where that price came from.
 *
 * Two questions in order, and they are genuinely different:
 *
 *   1. Does this order earn anything at all?  The depot + product rate
 *      answers it. Where no rate is configured — Dangote Refinery, AIPEC
 *      Lagos, Dangote Direct — nothing is earned, by anybody.
 *   2. If it earns, how much?  The customer's own agreed rate answers that
 *      where they have one, otherwise the depot's figure stands.
 *
 * ── Why the depot rate gates, rather than being just another candidate ────
 *
 * The first version resolved the customer FIRST, so a customer on ₦2.00 would
 * have started earning ₦2.00 at the refinery too — 200 paid orders and 26.4m
 * litres in sixty days where nobody earns anything today. "We give them ₦2
 * instead of the usual ₦1" is an instruction about the rate, not about which
 * depots pay commission, and it should not quietly open up the ones that pay
 * none.
 *
 * ── `!= null`, not truthiness ─────────────────────────────────────────────
 *
 * A customer on an agreed 0.00 earns nothing, and that is a decision somebody
 * made. Falling through to the depot's ₦1.00 because the agreed figure
 * happened to be zero would pay them a commission they were explicitly not
 * given. NULL on the column is the "no agreement" case, and only that.
 *
 * @param {object} order     needs customerId, depotId, productId
 * @param {object} [customer] pre-loaded, so a sweep over many rows does not
 *                            re-read the same customer once per row
 */
async function resolveRate(order, customer = undefined) {
  const rateEntry = await commissionRepo.getRate(order.depotId, order.productId);
  const depotRate = rateEntry ? parseFloat(rateEntry.commissionRate) : null;

  // Nothing is earned here, whoever is buying. The caller raises a
  // not-payable row — see createForOrder.
  if (depotRate == null || !(depotRate > 0)) {
    return { rate: depotRate, source: "depot_product" };
  }

  const buyer = customer === undefined ? await customerRepo.findById(order.customerId) : customer;
  if (buyer && buyer.commissionRate != null) {
    return { rate: parseFloat(buyer.commissionRate), source: "customer" };
  }
  return { rate: depotRate, source: "depot_product" };
}

async function createForOrder(orderId) {
  const order = await orderRepo.findById(orderId);
  if (!order) return null;

  const existing = await commissionRepo.findByOrderId(orderId);
  // Already settled: leave it exactly as it was paid out.
  if (existing && existing.status === "paid") return existing;

  /**
   * Nothing is due on an order nobody has priced.
   *
   * Commission is earned on litres that were PAID for, and an unpriced order
   * cannot take a payment. It could still reach here through the finance
   * reconcile endpoint, and commissionQuantity would have read its zero total
   * as "fully paid" (0 >= 0) and paid out on every truck. The next payment
   * after it is priced creates the row, the normal way.
   */
  if (order.pricingStatus === "pending") return existing || null;

  const quantity = await commissionQuantity(order);
  // The table requires a positive quantity, and a first instalment too small to
  // buy a whole litre has nothing to compute on yet. The next payment creates it.
  if (quantity <= 0) return existing || null;

  /**
   * No rate for this depot and product raises a NOT-PAYABLE row, not a real one.
   *
   * Three attempts at this, and the middle one was wrong in both directions.
   *
   * It first fell back to a rate of 0 and created an ordinary pending row, so
   * every order at a location that pays nothing raised a ₦0 entry that sat in
   * the desk's queue forever and showed the customer a commission they were
   * never going to get.
   *
   * Then it created nothing at all. That fixed the false promise and
   * introduced a silence: the customer bought the fuel, the order simply never
   * appeared on their commission page, and "why is my Dangote order missing"
   * has no answer visible to anybody.
   *
   * So the row exists and says what it is. It carries the same `skipped`
   * status the desk uses for a commission it has decided against, with a
   * reason naming the cause — both mean "this order earns nothing", and giving
   * them one state means the clients have one thing to render and the totals
   * have one thing to exclude. It is outside every money figure, on the
   * dashboard and on the customer's page alike.
   *
   * SETTING A RATE LATER DOES NOT REVIVE IT. recomputeForRate touches pending
   * rows only, deliberately: a commission the customer was told they would not
   * be paid should not quietly start owing months afterwards because somebody
   * configured a depot. If it should be paid, the desk undoes the skip, which
   * is a decision with a person's name on it.
   *
   * An existing row is left alone rather than rewritten: it may already be
   * paid, and unpaying somebody because a rate was later removed would be far
   * worse than the untidiness.
   */
  const { rate: configuredRate, source: rateSource } = await resolveRate(order);
  if (configuredRate == null || !(configuredRate > 0)) {
    if (existing) return existing;
    return commissionRepo.create({
      orderId: order.id,
      customerId: order.customerId,
      depotId: order.depotId,
      productId: order.productId,
      quantity,
      commissionRate: "0",
      commissionAmount: "0",
      status: "skipped",
      /*
       * Two ways to earn nothing, and they are not the same conversation. The
       * desk configures its way out of the first; the second is an agreement
       * somebody made and there is nothing to fix.
       */
      rateSource: rateSource === "customer" ? "customer" : "none",
      skipReason:
        rateSource === "customer"
          ? "This customer's own commission rate is \u20a60.00"
          : "No commission rate set for this location and product",
    });
  }

  const commissionRate = configuredRate;
  const commissionAmount = quantity * commissionRate;

  if (existing) {
    // Nothing moved — the ordinary retry case, still a no-op.
    if (
      Number(existing.quantity) === quantity &&
      parseFloat(existing.commissionRate) === commissionRate &&
      existing.rateSource === rateSource
    ) {
      return existing;
    }
    return commissionRepo.update(existing.id, {
      quantity,
      rateSource,
      commissionRate: String(commissionRate),
      commissionAmount: String(commissionAmount.toFixed(2)),
    });
  }

  const commission = await commissionRepo.create({
    orderId: order.id,
    customerId: order.customerId,
    depotId: order.depotId,
    productId: order.productId,
    quantity,
    commissionRate: String(commissionRate),
    rateSource,
    commissionAmount: String(commissionAmount.toFixed(2)),
    status: "pending",
  });

  return commission;
}

/**
 * The litres an order's commission is due on. See createForOrder for the rule.
 * Floored to a whole litre because commissions.quantity is an integer column.
 */
async function commissionQuantity(order) {
  const total = Number(order.totalAmount);
  const paid = Number(order.amountPaid ?? 0);
  // A zero total is not a settled one — see createForOrder's unpriced guard.
  const fullyPaid = total > 0 && Math.round(paid * 100) >= Math.round(total * 100);

  if (!fullyPaid) {
    const price = Number(order.price);
    if (!(price > 0)) return 0;
    return Math.floor(paid / price);
  }

  const trucks = await db
    .select()
    .from(orderTrucks)
    .where(eq(orderTrucks.orderId, order.id));

  if (trucks.length > 0) {
    const truckSum = trucks.reduce((s, t) => s + Number(t.quantity), 0);
    if (truckSum > 0) return Math.floor(truckSum);
  }
  return Math.floor(Number(order.quantity));
}

/**
 * Mark a commission paid. Nothing moves in this system.
 *
 * The money goes out of the bank, by transfer, to the account the facilitator
 * gave — offline, before or after somebody presses this. All this records is
 * that it happened, so the row leaves the queue and the desk knows not to pay
 * it twice.
 *
 * ── What this used to do ───────────────────────────────────────────────────
 *
 * It credited the customer's wallet with the commission and wrote a deposit
 * against it. That was the wallet era: a customer's balance was money the
 * system held for them, so paying a commission INTO it was a real transfer.
 * The wallet payment path is gone — payments live against orders now — and a
 * credit into a balance nothing spends is not a payment, it is a number
 * inflating a customer's standing for no reason anyone can trace.
 *
 * Commissions already confirmed under the old behaviour keep their credits
 * and their deposits. Those were real entries at the time and unwinding them
 * here would be a second wrong; they are history, not a bug to reverse.
 */
async function confirmPayment(commissionId, staffId) {
  const commission = await commissionRepo.findById(commissionId);
  if (!commission) {
    throw Object.assign(new Error("Commission not found"), { status: 404 });
  }
  if (commission.status === "paid") {
    throw Object.assign(new Error("Commission already paid"), { status: 400 });
  }

  /**
   * Still refused at zero. Nothing was sent to anybody, so there is nothing to
   * record as paid — and an order that genuinely carries no commission has its
   * own exit now. Skip it.
   */
  const amount = parseFloat(commission.commissionAmount);
  if (amount <= 0) {
    throw Object.assign(
      new Error("Commission amount is zero — set a rate first, or skip this order"),
      { status: 400 },
    );
  }

  const paid = await commissionRepo.markAsPaid(commissionId, staffId);

  return { commission: paid };
}

/**
 * Settle a commission without paying it.
 *
 * No wallet credit and no deposit — that is the whole difference from
 * confirmPayment, and it is why this one does not care whether the amount is
 * zero. An order with no rate set is one of the cases somebody skips.
 *
 * A reason is required. The row outlives everyone's memory of the order, and
 * "why was this not paid" is the only question it will ever be asked.
 */
async function skipCommission(commissionId, staffId, reason = "") {
  const commission = await commissionRepo.findById(commissionId);
  if (!commission) {
    throw Object.assign(new Error("Commission not found"), { status: 404 });
  }
  if (commission.status === "paid") {
    throw Object.assign(
      new Error("Commission already paid — it cannot be skipped after the customer has been credited"),
      { status: 400 },
    );
  }
  if (commission.status === "skipped") {
    throw Object.assign(new Error("Commission already skipped"), { status: 400 });
  }

  const trimmed = String(reason || "").trim();
  if (trimmed.length < 3) {
    throw Object.assign(new Error("Say why this order is being skipped"), { status: 400 });
  }

  const skipped = await commissionRepo.markAsSkipped(commissionId, staffId, trimmed.slice(0, 2000));
  return { commission: skipped };
}

/**
 * The same two acts over a selection.
 *
 * One at a time inside the loop rather than in one statement: confirming
 * credits a wallet, and a batch that half-succeeded needs to say how far it
 * got rather than roll back money that has already moved. Each failure is
 * collected with its reason so the desk can see which rows did not go and
 * why, instead of a single "3 failed".
 */
async function resolveMany({ ids, action, reason = "", staffId }) {
  const results = { done: [], failed: [] };

  for (const id of ids) {
    try {
      if (action === "skip") await skipCommission(id, staffId, reason);
      else await confirmPayment(id, staffId);
      results.done.push(id);
    } catch (err) {
      results.failed.push({ id, message: err.message || "Failed" });
    }
  }

  return results;
}

/**
 * Undo a settlement — paid or skipped — and put the row back in the queue.
 *
 * Mistakes are made: the wrong row ticked, a skip decided on the wrong order,
 * a payment recorded that never went out. Without this the only exits were
 * permanent, which quietly encourages the opposite error — leaving a wrong row
 * settled because correcting it is impossible.
 *
 * A reason is required for the same purpose it is on a skip: the row will be
 * looked at again months from now, and "why does this say pending when the
 * ledger says we paid it" needs an answer written at the time.
 *
 * ── The one case that is not a clean undo ──────────────────────────────────
 *
 * 56 of the 194 paid commissions were confirmed while doing so credited the
 * customer's wallet, and that deposit is still on their balance. Reverting one
 * does NOT reverse it — this service will not silently claw money back from a
 * customer — so the credit stays and the commission goes back to pending,
 * which means the two now disagree.
 *
 * That is worth stopping on rather than discovering later, so the attempt is
 * refused once and carries the deposit it found. `acknowledgeWalletCredit`
 * says "I have seen it and I will deal with the credit separately".
 */
async function revertToPending(commissionId, staffId, { reason = "", acknowledgeWalletCredit = false } = {}) {
  const commission = await commissionRepo.findById(commissionId);
  if (!commission) {
    throw Object.assign(new Error("Commission not found"), { status: 404 });
  }
  if (commission.status === "pending") {
    throw Object.assign(new Error("This commission is already pending"), { status: 400 });
  }

  const trimmed = String(reason || "").trim();
  if (trimmed.length < 3) {
    throw Object.assign(new Error("Say why this is being undone"), { status: 400 });
  }

  const walletCredit =
    commission.status === "paid" ? await commissionRepo.findWalletCreditFor(commissionId) : null;
  if (walletCredit && !acknowledgeWalletCredit) {
    throw Object.assign(
      new Error(
        `This commission credited the customer's wallet ${walletCredit.reference} with ` +
        `N${Number(walletCredit.amount).toLocaleString()}. Undoing it here does not reverse that credit. ` +
        `Confirm to undo anyway.`,
      ),
      { status: 409, code: "WALLET_CREDIT_EXISTS", walletCredit },
    );
  }

  const was = commission.status;
  const reverted = await commissionRepo.revertToPending(commissionId);

  await auditLogRepo.record({
    entityType: "commission",
    entityId: commissionId,
    action: "commission.reverted",
    actor: staffId ? { type: "staff", staffId } : { type: "system" },
    prevState: was,
    newState: "pending",
    metadata: {
      reason: trimmed.slice(0, 2000),
      amount: commission.commissionAmount,
      orderId: commission.orderId,
      walletCreditLeftInPlace: walletCredit ? walletCredit.reference : null,
    },
  });

  return { commission: reverted, was, walletCredit };
}

/**
 * Bring pending commissions into line after a rate is set or changed.
 *
 * Rates are configured per depot and product, and until now nothing looked
 * back at the commissions already raised under the old figure. 116 pending
 * rows sit at ₦0 on depots that DO have a rate — created before somebody set
 * it, and never revisited. The desk sees ₦0 owing; the customer sees a
 * commission worth nothing.
 *
 * Only pending rows. A paid commission settled at the rate in force when it
 * was paid, and repricing history is not a recalculation, it is a rewrite.
 */
async function recomputeForRate(depotId, productId) {
  const pending = await commissionRepo.findPendingFor(depotId, productId);
  const rateEntry = await commissionRepo.getRate(depotId, productId);
  const rate = rateEntry ? parseFloat(rateEntry.commissionRate) : 0;

  /**
   * A customer on their own agreed rate is not repriced by a depot edit.
   *
   * findPendingFor selects every pending row at this depot and product, and
   * it has no idea who bought. Without this, the first time anybody adjusted
   * the Warri/PMS rate, every ₦2.00 customer's pending commission would be
   * quietly rewritten to the depot's ₦1.00 — no error, no audit trail, and
   * nothing on the page to say it had happened. It is the single way this
   * feature breaks silently, so the guard is here rather than in the query:
   * the exclusion is a rule about money and belongs where it can be read.
   *
   * Their rows move when THEIR rate changes — see recomputeForCustomer.
   */
  const overridden = await commissionRepo.customersWithOwnRate(
    pending.map((c) => c.customerId),
  );

  const updated = [];
  let skipped = 0;
  for (const c of pending) {
    if (overridden.has(Number(c.customerId))) {
      skipped++;
      continue;
    }
    const amount = Number(c.quantity) * rate;
    if (parseFloat(c.commissionRate) === rate && c.rateSource === "depot_product") continue;
    updated.push(
      await commissionRepo.update(c.id, {
        commissionRate: String(rate),
        rateSource: "depot_product",
        commissionAmount: String(amount.toFixed(2)),
      }),
    );
  }
  return { considered: pending.length, updated: updated.length, skipped, rate };
}

/**
 * Bring a customer's pending commissions onto their own rate — or off it.
 *
 * The counterpart to recomputeForRate, and needed for the same reason: a rate
 * that only applies to orders placed after it was set leaves the desk looking
 * at a queue priced under an agreement that no longer holds, with no way to
 * tell which rows are stale.
 *
 * Clearing the rate sends each row back to its depot's figure rather than to
 * zero, because "no agreement" means the usual rate applies, not that the
 * customer earns nothing.
 *
 * Pending only, exactly as above: a paid commission settled at the rate in
 * force when it was paid, and repricing history is a rewrite, not a
 * recalculation.
 */
async function recomputeForCustomer(customerId) {
  const customer = await customerRepo.findById(customerId);
  if (!customer) return { considered: 0, updated: 0 };

  const pending = await commissionRepo.findPendingForCustomer(customerId);

  const updated = [];
  for (const c of pending) {
    /*
     * Through resolveRate, and with the customer handed in so this does not
     * re-read them once per row. Sharing the resolver is what stops the sweep
     * and the create path ever disagreeing about a price — including about
     * the depots that pay nobody, where an agreed rate must NOT apply.
     */
    const { rate, source } = await resolveRate(
      { customerId, depotId: c.depotId, productId: c.productId },
      customer,
    );
    const effective = rate == null ? 0 : rate;
    if (parseFloat(c.commissionRate) === effective && c.rateSource === source) continue;
    updated.push(
      await commissionRepo.update(c.id, {
        commissionRate: String(effective),
        rateSource: source,
        commissionAmount: String((Number(c.quantity) * effective).toFixed(2)),
      }),
    );
  }
  return {
    considered: pending.length,
    updated: updated.length,
    rate: customer.commissionRate == null ? null : parseFloat(customer.commissionRate),
  };
}

module.exports = {
  createForOrder,
  confirmPayment,
  skipCommission,
  resolveMany,
  revertToPending,
  recomputeForRate,
  recomputeForCustomer,
  resolveRate,
};
