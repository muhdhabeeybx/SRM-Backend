const { eq, and, or, ilike, desc, count, sql, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { deliverySales, deliveryCustomers, bankStatementLines } = require("../db/schema");

const findById = async (id) => {
  const [row] = await db
    .select()
    .from(deliverySales)
    .where(eq(deliverySales.id, id))
    .limit(1);
  return row || null;
};

const findByPaystackReference = async (reference) => {
  const [row] = await db
    .select()
    .from(deliverySales)
    .where(eq(deliverySales.paystackReference, reference))
    .limit(1);
  return row || null;
};

const findPendingByCustomer = async (customerId) => {
  const [row] = await db
    .select()
    .from(deliverySales)
    .where(
      and(
        eq(deliverySales.customerId, customerId),
        sql`(${deliverySales.salesValue} - ${deliverySales.paymentAmount}) > 0`
      )
    )
    .orderBy(desc(deliverySales.createdAt))
    .limit(1);
  return row || null;
};

const findAll = async ({
  search,
  customer,
  truck_number,
  date_from,
  date_to,
  page = 1,
  limit = 500,
  /**
   * The allocation codes this person may see, or null for everyone. Staff
   * assigned to a PFI see only its batches' sales — lib/pfiScope.js.
   */
  allowedCodes = null,
  /**
   * The filling stations this person may see, or null for everyone. Staff
   * assigned stations see only sales to them — lib/stationScope.js.
   */
  allowedStationIds = null,
} = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (Array.isArray(allowedCodes)) {
    // A sale with no code cannot be tied to a PFI, so it is outside every one.
    conditions.push(
      allowedCodes.length
        ? inArray(sql`upper(trim(${deliverySales.allocationCode}))`, allowedCodes)
        : sql`false`,
    );
  }

  if (Array.isArray(allowedStationIds)) {
    conditions.push(
      allowedStationIds.length ? inArray(deliverySales.customerId, allowedStationIds) : sql`false`,
    );
  }

  if (customer) {
    conditions.push(eq(deliverySales.customerId, customer));
  }

  if (truck_number) {
    conditions.push(ilike(deliverySales.truckNumber, `%${truck_number}%`));
  }

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(deliverySales.truckNumber, pattern),
        ilike(deliverySales.customerName, pattern),
        ilike(deliverySales.location, pattern),
        ilike(deliverySales.depotLoaded, pattern),
        ilike(deliverySales.payerName, pattern),
        ilike(deliverySales.remarks, pattern),
        // The allocation code is how this table is actually talked about —
        // "the 19B loadings", "everything under 25C" — and it was the one
        // identifier the search could not reach, while the sibling
        // deliveryInventory.findAll had searched it all along. Its absence did
        // not return the wrong rows, it returned none: with 1,363 rows against
        // a 500-row page, a whole PFI's history sat past the end of the first
        // page and searching for it by name was the only way back to it.
        ilike(deliverySales.allocationCode, pattern)
      )
    );
  }

  /**
   * Both bounds were accepted by the schema, destructured here, and then
   * silently dropped — so a date-ranged request returned the same unfiltered
   * newest-500 as an unranged one, and narrowing to the month you wanted
   * appeared to do nothing.
   *
   * `date_loaded` is a varchar of ISO dates, so a lexicographic comparison is
   * the correct one. LEFT(...,10) mirrors cycleStanding, which already
   * normalises this column rather than trusting it to be exactly ten
   * characters. A blank date sorts below every bound and so drops out of a
   * ranged query, which is right: a payment with no load date is in no period.
   */
  if (date_from) {
    conditions.push(
      sql`LEFT(COALESCE(${deliverySales.dateLoaded}, ''), 10) >= ${String(date_from).slice(0, 10)}`
    );
  }

  if (date_to) {
    conditions.push(
      sql`LEFT(COALESCE(${deliverySales.dateLoaded}, ''), 10) <= ${String(date_to).slice(0, 10)}`
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(deliverySales)
      .where(whereClause)
      // `id` breaks the tie. Ordering by a timestamp alone is not a total
      // order — 17 rows here share a created_at with another — and OFFSET
      // paging over a non-deterministic order can hand the same row to two
      // pages and skip a third entirely. A caller walking the pages to
      // assemble the whole table would silently lose rows.
      .orderBy(desc(deliverySales.createdAt), desc(deliverySales.id))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(deliverySales)
      .where(whereClause),
  ]);

  return {
    sales: rows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data) => {
  const [row] = await db.insert(deliverySales).values(data).returning();
  return row;
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Insert many rows, all or none.
 *
 * One transaction because the callers are a day sheet and a spreadsheet
 * import, and both are one act to the person doing them: half a day recorded
 * is a day that reconciles wrongly, and half a spreadsheet is worse — the
 * re-upload that follows would duplicate the half that did land.
 *
 * The customers are checked up front rather than left to the foreign key. The
 * key would roll the transaction back just as surely, but with a driver error
 * naming a constraint; this names the row, which is what someone fixing a
 * spreadsheet needs.
 */
const createMany = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.customerId).filter((id) => id != null).map(Number))];

  return db.transaction(async (tx) => {
    if (ids.length) {
      const found = await tx
        .select({ id: deliveryCustomers.id })
        .from(deliveryCustomers)
        .where(inArray(deliveryCustomers.id, ids));
      const known = new Set(found.map((c) => c.id));
      const missing = rows.findIndex((r) => r.customerId != null && !known.has(Number(r.customerId)));
      if (missing >= 0) {
        throw httpError(400, `Row ${missing + 1}: customer ${rows[missing].customerId} does not exist`);
      }
    }
    return tx.insert(deliverySales).values(rows).returning();
  });
};

/**
 * Record truck-sale payments from the bank statement lines that paid them.
 *
 * The same shape as an order's confirmation (orderPayment.service
 * recordFromStatementLines) and for the same reasons, because it is the same
 * act: the desk names bank rows, not an amount.
 *
 * ── One row per line, not one row for the total ───────────────────────────
 *
 * A customer who paid in three tranches produces three payments, each keeping
 * its own amount, payer, date and reference. Folding them into one summed row
 * would make the ledger disagree with the statement it came from, and the
 * whole point of matching is that the two can be laid side by side.
 *
 * ── The claim is the guard ────────────────────────────────────────────────
 *
 * Lines are claimed with `status = 'UNMATCHED'` in the WHERE, so two desks
 * confirming the same credit cannot both win — the loser updates zero rows and
 * the count check below throws. Throwing rather than returning a failure is
 * deliberate: a plain return would still commit, leaving whichever lines DID
 * get claimed stuck in MATCHED with no payment behind them.
 */
const createFromStatementLines = async ({ lineIds, bankAccountId, staffId = null, base }) => {
  const ids = (lineIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw httpError(400, "No statement lines were selected");
  if (!bankAccountId) {
    throw httpError(400, "A bank account is required to claim statement lines");
  }

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(bankStatementLines)
      .set({
        status: "MATCHED",
        matchedBy: staffId,
        matchedAt: new Date(),
      })
      .where(
        and(
          inArray(bankStatementLines.id, ids),
          eq(bankStatementLines.bankAccountId, Number(bankAccountId)),
          eq(bankStatementLines.status, "UNMATCHED"),
        ),
      )
      .returning();

    if (claimed.length !== ids.length) {
      throw httpError(
        409,
        "One or more of those credits were already matched — refresh and try again.",
      );
    }

    const sales = [];
    for (const line of claimed) {
      const [sale] = await tx
        .insert(deliverySales)
        .values({
          ...base,
          statementLineId: line.id,
          bankAccountId: Number(bankAccountId),
          // The statement, verbatim. What the desk used to type is now copied
          // from the bank's own row, which is the entire point.
          paymentAmount: String(line.amount),
          payerName: line.depositor || base.payerName || "",
          bankRef: line.bankRef || "",
          // txn_date is a plain calendar day (migration 0039) and
          // date_of_payment is a varchar day, so this is a straight copy with
          // no instant in between to shift it.
          dateOfPayment: String(line.txnDate).slice(0, 10),
          paymentMethod: "manual",
        })
        .returning();

      // The other direction, so the statement screen can say what claimed
      // this credit instead of showing it matched to nothing.
      await tx
        .update(bankStatementLines)
        .set({ matchedDeliverySaleId: sale.id })
        .where(eq(bankStatementLines.id, line.id));

      sales.push(sale);
    }

    return sales;
  });
};

const update = async (id, data) => {
  const [row] = await db
    .update(deliverySales)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(deliverySales.id, id))
    .returning();
  return row || null;
};

/**
 * What one truck-cycle for one customer was worth, and what it has taken.
 *
 * Expected is read ONCE per cycle with MAX, not summed: delivery_sales holds
 * one row per payment and repeats the cycle's sales_value on every one of
 * them, so summing it multiplies what was owed by however many times the
 * customer has paid. This is the same rule useLedgerGroups applies on the
 * client and outstandingPayments applies on the dashboard — all three have to
 * agree or a surplus computed here would not be the one shown on screen.
 *
 * The plate is normalised the way getCycleKey normalises it, so a loading
 * written "BWR 809 XB" and a payment written "BWR809XB" stay one cycle.
 */
const cycleStanding = async ({ truckNumber, dateLoaded, customerId }) => {
  const [row] = await db.execute(sql`
    SELECT
      COALESCE(MAX(${deliverySales.salesValue}::numeric), 0) AS sales_value,
      COALESCE(MAX(${deliverySales.rate}::numeric), 0)       AS rate,
      COALESCE(MAX(${deliverySales.quantity}::numeric), 0)   AS quantity,
      COALESCE(SUM(${deliverySales.paymentAmount}::numeric), 0) AS paid
    FROM ${deliverySales}
    WHERE regexp_replace(UPPER(COALESCE(${deliverySales.truckNumber}, '')), '\\s', '', 'g')
        = regexp_replace(UPPER(${truckNumber || ""}), '\\s', '', 'g')
      AND COALESCE(LEFT(${deliverySales.dateLoaded}, 10), '') = ${String(dateLoaded || "").slice(0, 10)}
      AND ${customerId == null
        ? sql`${deliverySales.customerId} IS NULL`
        : sql`${deliverySales.customerId} = ${Number(customerId)}`}
  `);

  const salesValue = Number(row?.sales_value ?? 0);
  const rate = Number(row?.rate ?? 0);
  const quantity = Number(row?.quantity ?? 0);
  const paid = Number(row?.paid ?? 0);
  const expected = salesValue > 0 ? salesValue : rate * quantity;

  return { expected, paid, surplus: Math.round((paid - expected) * 100) / 100 };
};

/**
 * Move a truck's overpayment onto one or more other trucks.
 *
 * Written as two rows per destination — a negative payment on the source and
 * a positive one on the destination — rather than as an edit to the original
 * payment. delivery_sales IS the payment history, and the two questions asked
 * of it are "what did this truck receive" and "where did that come from"; one
 * row can only answer one of them.
 *
 * The surplus is recomputed here from the table, never taken from the
 * request. A client that believes a truck is ₦2m over when it is ₦200k over
 * would otherwise invent ₦1.8m, and the ledger has no way to tell afterwards
 * that it was invented.
 *
 * All legs go in one transaction: a credit that lands without its matching
 * debit is money created out of nothing.
 */
const transferOverpayment = async ({ from, to, actor = "" }) => {
  const destinations = (to || []).filter((d) => Number(d.amount) > 0);
  if (destinations.length === 0) {
    throw Object.assign(new Error("Nothing to transfer"), { status: 400 });
  }

  const standing = await cycleStanding(from);
  if (standing.surplus <= 0) {
    throw Object.assign(
      new Error("This truck has no overpayment to move"),
      { status: 400 },
    );
  }

  const total = destinations.reduce((s, d) => s + Number(d.amount), 0);
  // Half a kobo of slack: the client works in naira with two decimals and
  // "transfer all of it" must not fail on a rounding tail.
  if (total > standing.surplus + 0.005) {
    throw Object.assign(
      new Error(
        `Only ${standing.surplus.toFixed(2)} is available to move; ${total.toFixed(2)} was requested`,
      ),
      { status: 400 },
    );
  }

  const groupId = `TRF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const label = (t) => [t.truckNumber, t.customerName].filter(Boolean).join(" · ");
  const fromLabel = label(from);

  // A leg is an ordinary delivery_sale in every respect except its amount and
  // its transfer columns. sales_value, quantity and rate are left at zero on
  // purpose: the group reads those with MAX, so a leg carrying them would
  // either restate or overwrite what the truck was actually worth.
  const leg = (cycle, amount, counterparty, payer) => ({
    truckNumber: cycle.truckNumber || "",
    dateLoaded: cycle.dateLoaded || "",
    depotLoaded: cycle.depotLoaded || "",
    customerId: cycle.customerId ? Number(cycle.customerId) : null,
    customerName: cycle.customerName || "",
    location: cycle.location || "",
    allocationCode: cycle.allocationCode || null,
    quantity: 0,
    rate: "0",
    salesValue: "0",
    paymentAmount: String(amount),
    payerName: payer,
    bank: "",
    dateOfPayment: today,
    // Not a bank deposit, so there is nothing to confirm against a statement.
    depositStatus: "paid",
    transferGroupId: groupId,
    transferCounterparty: counterparty,
    enteredBy: actor,
    remarks: payer,
  });

  const rows = [];
  for (const dest of destinations) {
    const amount = Math.round(Number(dest.amount) * 100) / 100;
    const destLabel = label(dest);
    rows.push(leg(from, -amount, destLabel, `Transferred to ${destLabel}`));
    rows.push(leg(dest, amount, fromLabel, `Transfer from ${fromLabel}`));
  }

  const inserted = await db.transaction(async (tx) => tx.insert(deliverySales).values(rows).returning());

  return {
    transferGroupId: groupId,
    moved: Math.round(total * 100) / 100,
    remaining: Math.round((standing.surplus - total) * 100) / 100,
    sales: inserted,
  };
};

/**
 * Delete a sale, and give back the bank credit it claimed.
 *
 * A payment matched off a statement marks that line MATCHED and points it at
 * the sale. Deleting the sale left the line MATCHED and pointing at a row
 * that no longer exists, so the credit could never be claimed again: the only
 * way to fix a payment matched to the wrong truck — delete it and re-match —
 * quietly destroyed the credit instead.
 *
 * Releasing it is the whole reason this is a transaction. A line freed
 * without its sale being deleted would be claimable twice.
 */
const deleteById = async (id) => {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(deliverySales)
      .where(eq(deliverySales.id, id))
      .returning();
    if (!row) return null;

    if (row.statementLineId != null) {
      await tx
        .update(bankStatementLines)
        .set({
          status: "UNMATCHED",
          matchedDeliverySaleId: null,
          matchedBy: null,
          matchedAt: null,
        })
        .where(eq(bankStatementLines.id, row.statementLineId));
    }
    return row;
  });
};

module.exports = {
  findById,
  findByPaystackReference,
  findPendingByCustomer,
  findAll,
  create,
  createMany,
  createFromStatementLines,
  update,
  deleteById,
  cycleStanding,
  transferOverpayment,
};
