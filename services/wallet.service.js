const { eq, and, sql, asc, gt, inArray } = require("drizzle-orm");
const { db } = require("../config/db");
const { assertNotBankEntries } = require("../lib/bankEntries");
const {
  customers, deposits, walletHolds, orderDepositAllocations, bankStatementLines, orders,
} = require("../db/schema");
const customerRepo = require("../repositories/customer.repository");
const bankAccountRepo = require("../repositories/bankAccount.repository");

// Every operation here runs inside a single database transaction, and every
// balance change goes through customerRepo.creditBalance/debitBalance — an
// atomically guarded UPDATE (`WHERE balance >= amount` on the debit side), not
// a separate read-then-write. Two concurrent debits racing the same balance
// cannot both pass: the database itself serializes the two UPDATEs, and the
// second one's guard simply fails to match. Nothing outside this file should
// write customers.balance or insert deposits rows for wallet money movements
// — every business debit/credit must land its ledger row in the same
// transaction as the balance change, and this is the one place that does both.
//
// The invariant these operations maintain:
//
//   customers.balance = sum(credit deposits) - sum(debit deposits)
//                       - sum(active holds)
//
// getLedgerBalance() recomputes the right-hand side for reconciliation.

const UNIQUE_VIOLATION = "23505";

// Drizzle wraps driver errors; the Postgres error code is on the cause.
const isUniqueViolation = (err) =>
  err?.code === UNIQUE_VIOLATION || err?.cause?.code === UNIQUE_VIOLATION;

const money = (value) => Number(value || 0);
const asDecimal = (value) => money(value).toFixed(2);

/**
 * Credit the wallet. Idempotent when a `reference` is supplied: a second call
 * with the same reference returns the original deposit row untouched.
 *
 * `trackDeposit` also bumps the customers.deposit / previousDeposit counters —
 * true for genuine money-in (bank transfer, manual deposit), false for
 * refunds, which are returned money rather than new deposits.
 *
 * An optional `tx` lets a caller (e.g. a bulk statement-line deposit) commit
 * the credit atomically with other writes in its own transaction — same
 * pattern as placeHold. Without one, the credit gets its own transaction.
 */
const credit = async (
  {
    customerId,
    amount,
    description = "",
    reference = "",
    paystackDetails = null,
    recordedBy = null,
    trackDeposit = true,
    /**
     * The value date from the bank statement, where one backs this credit.
     *
     * Left null for money that never came off a statement — an internal
     * wallet transfer, an overpayment carried across — because those have no
     * banking date, and defaulting it to "now" is precisely the confusion
     * migration 0017 exists to end.
     */
    depositDate = null,
  },
  tx,
) => {
  const value = money(amount);
  if (value <= 0) {
    return { success: false, message: "Credit amount must be positive" };
  }

  const run = async (trx) => {
    if (reference) {
      const [existing] = await trx
        .select()
        .from(deposits)
        .where(eq(deposits.reference, reference))
        .limit(1);
      if (existing) {
        return {
          success: true,
          alreadyProcessed: true,
          deposit: existing,
          message: `Transaction reference ${reference} has already been recorded.`,
        };
      }
    }

    // Credits can never overdraw, so the guarded UPDATE only needs to
    // match on id; it returns null solely when the customer doesn't exist.
    let updated = await customerRepo.creditBalance(customerId, value, trx);
    if (!updated) {
      return { success: false, message: "Customer not found" };
    }

    if (trackDeposit) {
      // previousDeposit is the counter as of right after the balance-only
      // update above — deposit/previousDeposit are untouched by
      // creditBalance, so this is exactly "before this credit's deposit
      // counter changed", computed inside the same transaction rather than
      // from a separate earlier read.
      const [withDeposit] = await trx
        .update(customers)
        .set({
          previousDeposit: updated.deposit,
          deposit: sql`${customers.deposit} + ${value}`,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customerId))
        .returning();
      updated = withDeposit;
    }

    const [deposit] = await trx
      .insert(deposits)
      .values({
        customerId,
        amount: asDecimal(value),
        type: "credit",
        description,
        reference,
        recordedBy,
        balanceAfter: asDecimal(updated.balance),
        paystackDetails,
        depositDate: depositDate || null,
        // Starts fully unclaimed. Nothing draws it down any more — order
        // payments no longer come out of the wallet — so on a new credit this
        // stays equal to `amount` and reads as "never spent on an order".
        remainingAmount: asDecimal(value),
      })
      .returning();

    return { success: true, deposit, customer: updated };
  };

  // Inside a caller's transaction a duplicate-reference violation must
  // propagate — the caller's atomic unit can't be soft-recovered here
  // (Postgres aborts it). The soft-recovery path below only applies to the
  // standalone transaction case.
  if (tx) return run(tx);
  try {
    return await db.transaction(run);
  } catch (err) {
    // Two requests raced past the pre-check with the same reference; the
    // partial unique index on deposits.reference stopped the second one.
    if (isUniqueViolation(err) && reference) {
      const [existing] = await db
        .select()
        .from(deposits)
        .where(eq(deposits.reference, reference))
        .limit(1);
      return {
        success: true,
        alreadyProcessed: true,
        deposit: existing || null,
        message: `Transaction reference ${reference} has already been recorded.`,
      };
    }
    throw err;
  }
};

/**
 * A manual deposit sourced from one or more bank-statement lines: claim the
 * lines and credit the wallet once per line — each keeps its own amount,
 * depositor, date and reference rather than being folded into a single
 * summed row, so the ledger mirrors the bank statement one row at a time.
 * All of it commits in one transaction.
 *
 * The claim is a guarded UPDATE (`WHERE status = 'UNMATCHED'`), so two staff
 * racing to use an overlapping set of lines can't both win — whoever loses
 * gets back fewer claimed rows than they asked for and the whole transaction
 * is rolled back rather than under-crediting silently.
 *
 * Amounts are never trusted from the client — each deposit's amount comes
 * from the claimed line itself.
 */
const creditFromStatementLines = async ({ customerId, bankAccountId, lineIds, staffId, description, orderId = null }) => {
  if (!Array.isArray(lineIds) || !lineIds.length) {
    return { success: false, message: "No statement lines were selected" };
  }

  // Only bankAccountId (the FK) was ever stored on the deposit before —
  // never the account's own name/number, which is why "paid into" read
  // blank everywhere downstream (the finance report, this deposit's own
  // detail view) despite the account being right there in the claim query.
  // Looked up once, outside the per-line loop below.
  const bankAccount = await bankAccountRepo.findById(bankAccountId);

  return db.transaction(async (tx) => {
    // Interest, a charge, a reversal: the bank's own entry is never a payment.
    await assertNotBankEntries(tx, lineIds);
    const claimed = await tx
      .update(bankStatementLines)
      .set({
        status: "MATCHED",
        matchedBy: staffId ?? null,
        matchedAt: new Date(),
        // Stamped here rather than left to FIFO to work out later — this
        // line is being claimed FOR this order, right now, not just added
        // to the wallet in general.
        ...(orderId ? { matchedOrderId: orderId } : {}),
      })
      .where(
        and(
          inArray(bankStatementLines.id, lineIds),
          eq(bankStatementLines.bankAccountId, bankAccountId),
          eq(bankStatementLines.status, "UNMATCHED"),
        ),
      )
      .returning();

    // Returning a failure object here (instead of throwing) would still let
    // Drizzle commit the transaction — silently leaving whichever lines DID
    // get claimed stuck in MATCHED with no deposit behind them. Throwing is
    // what actually rolls the partial claim back.
    if (claimed.length !== lineIds.length) {
      throw Object.assign(
        new Error("One or more of those lines were already used in another deposit — refresh and try again."),
        { status: 409 },
      );
    }

    const createdDeposits = [];
    for (const line of claimed) {
      const creditResult = await credit(
        {
          customerId,
          amount: money(line.amount),
          description:
            description ||
            `Manual deposit — bank statement line${line.narration ? `: ${line.narration}` : ` #${line.id}`}`,
          // The line's own bank reference, if it has one — falling back to a
          // synthetic key that's stable per line (so retrying a failed
          // request is idempotent) rather than per request.
          reference: line.bankRef || `STMT-${line.id}`,
          // The banking date, stored ON the deposit rather than rediscovered
          // at read time by joining back to the statement line. That join took
          // the lowest-id line of however many funded the deposit, and fell
          // back to created_at when it found none — so a column headed
          // "Deposit Date" could quietly show the day the row was keyed in.
          // See migration 0017.
          depositDate: line.txnDate,
          paystackDetails: {
            paymentMethod: "manual_bank_transfer",
            channel: "manual_bank_transfer",
            bankAccountId,
            bankName: bankAccount?.bankName || null,
            accountName: bankAccount?.accountName || null,
            accountNumber: bankAccount?.accountNumber || null,
            senderName: line.depositor || null,
            paidAt: line.txnDate,
            statementLineIds: [line.id],
            statementLineCount: 1,
            ...(orderId ? { orderId } : {}),
          },
          recordedBy: staffId ?? null,
        },
        tx,
      );

      // Same reasoning as the claim check above: a credit failure, or a
      // reference that unexpectedly already belonged to some other deposit,
      // must abort the whole transaction rather than leave this line
      // claimed with no (or the wrong) deposit behind it.
      if (!creditResult.success || creditResult.alreadyProcessed) {
        throw Object.assign(
          new Error(
            creditResult.alreadyProcessed
              ? `Statement line ${line.id}'s reference was already used by another deposit — refresh and try again.`
              : creditResult.message || "Credit failed",
          ),
          { status: creditResult.alreadyProcessed ? 409 : 400 },
        );
      }

      await tx
        .update(bankStatementLines)
        .set({ matchedDepositId: creditResult.deposit.id })
        .where(eq(bankStatementLines.id, line.id));

      createdDeposits.push(creditResult.deposit);
    }

    const total = claimed.reduce((sum, l) => sum + money(l.amount), 0);
    return { success: true, deposits: createdDeposits, claimedLines: claimed, totalAmount: total };
  });
};

/**
 * Debit the wallet directly (no hold involved). Fails rather than allowing
 * the balance to go negative — debitBalance's guard is in the WHERE clause
 * of the UPDATE itself, not in a preceding read, so it cannot be raced.
 *
 * An optional `tx` lets a caller (e.g. transfer(), below) commit the debit
 * atomically with other writes in its own transaction — same pattern as
 * credit()/placeHold(). Without one, the debit gets its own transaction.
 */
const debit = async (
  { customerId, amount, description = "", reference = "", recordedBy = null },
  tx,
) => {
  const value = money(amount);
  if (value <= 0) {
    return { success: false, message: "Debit amount must be positive" };
  }

  const run = async (trx) => {
    const updated = await customerRepo.debitBalance(customerId, value, trx);
    if (!updated) {
      // Same guarded result whether the customer doesn't exist or simply
      // doesn't have enough — either way, this debit does not happen.
      return { success: false, insufficient: true, message: "Insufficient wallet balance" };
    }

    const [deposit] = await trx
      .insert(deposits)
      .values({
        customerId,
        amount: asDecimal(value),
        type: "debit",
        description,
        reference,
        recordedBy,
        balanceAfter: asDecimal(updated.balance),
      })
      .returning();

    return { success: true, deposit, customer: updated };
  };

  if (tx) return run(tx);
  return db.transaction(run);
};

/**
 * Move balance from one customer's wallet to another — e.g. a deposit was
 * recorded against the wrong customer, or a genuine account-to-account
 * transfer. One atomic debit + credit, same transaction. The credit leg
 * isn't `trackDeposit`: it's money moving inside the wallet system, not new
 * money coming into the business, the same distinction refunds already draw.
 */
const transfer = async ({ fromCustomerId, toCustomerId, amount, description = "", recordedBy = null }) => {
  const value = money(amount);
  if (value <= 0) {
    return { success: false, message: "Transfer amount must be positive" };
  }
  if (String(fromCustomerId) === String(toCustomerId)) {
    return { success: false, message: "Cannot transfer a balance to the same customer" };
  }

  return db.transaction(async (tx) => {
    const debitResult = await debit(
      {
        customerId: fromCustomerId,
        amount: value,
        description: description || `Wallet transfer to customer #${toCustomerId}`,
        recordedBy,
      },
      tx,
    );
    if (!debitResult.success) return debitResult;

    const creditResult = await credit(
      {
        customerId: toCustomerId,
        amount: value,
        description: description || `Wallet transfer from customer #${fromCustomerId}`,
        trackDeposit: false,
        recordedBy,
      },
      tx,
    );
    // credit() only returns success:false when the target customer doesn't
    // exist — that has to abort the whole transaction (including the debit
    // above), not just report a failure the caller might not roll back on.
    if (!creditResult.success) {
      throw Object.assign(new Error(creditResult.message || "Transfer failed"), { status: 400 });
    }

    return {
      success: true,
      debit: debitResult.deposit,
      credit: creditResult.deposit,
      fromCustomer: debitResult.customer,
      toCustomer: creditResult.customer,
    };
  });
};

/**
 * Reverse a credit deposit — e.g. a manual deposit recorded against the
 * wrong customer. Debits the same amount back out under the same guard every
 * debit uses, so a deposit already partly spent (its `remainingAmount` drawn
 * down by orders) can still fail to reverse if the customer's *current*
 * balance can't cover it — that's surfaced, not hidden, and it means the
 * reversal would otherwise be clawed back from unrelated funds rather than
 * "undoing" money that has already left as a completed order.
 *
 * There is no dedicated schema column linking a reversal back to the
 * original deposit — the reversal's own `reference`/`description` carry that
 * trail instead, the same convention statement-line deposits already use.
 */
const reverseDeposit = async ({ depositId, recordedBy = null, description = "" }, tx) => {
  const run = async (trx) => {
    const [original] = await trx
      .select()
      .from(deposits)
      .where(eq(deposits.id, depositId))
      .for("update")
      .limit(1);

    if (!original) return { success: false, message: "Deposit not found" };
    if (original.type !== "credit") {
      return { success: false, message: "Only a credit deposit can be reversed" };
    }
    if (String(original.reference || "").startsWith("REV-")) {
      return { success: false, message: "This is itself a reversal — nothing to reverse" };
    }

    const value = money(original.amount);
    const updated = await customerRepo.debitBalance(original.customerId, value, trx);
    if (!updated) {
      return {
        success: false,
        insufficient: true,
        message: "The customer's current balance can't cover reversing this deposit — some of it may already be spent on orders.",
      };
    }

    const [reversal] = await trx
      .insert(deposits)
      .values({
        customerId: original.customerId,
        amount: asDecimal(value),
        type: "debit",
        description: description || `Reversal of deposit #${original.id}${original.reference ? ` (${original.reference})` : ""}`,
        reference: `REV-${original.id}`,
        recordedBy,
        balanceAfter: asDecimal(updated.balance),
      })
      .returning();

    // Cuts the original off as a funding source for any *future* order —
    // past allocations (order_deposit_allocations rows already written) stay
    // exactly as they were, since those orders genuinely were funded from it
    // at the time.
    await trx
      .update(deposits)
      .set({ remainingAmount: "0.00" })
      .where(eq(deposits.id, original.id));

    return { success: true, deposit: reversal, original, customer: updated };
  };
  return tx ? run(tx) : db.transaction(run);
};

/**
 * Move an order's payment hold to a different customer — the order was
 * placed against the wrong one and is already paid.
 *
 * This is NOT release-then-placeHold: wallet_holds carries one row per
 * order id, ever (unique on order_id, never re-used even once released), so
 * a fresh placeHold() for the same order collides with the old row. Instead
 * the existing row is repointed in place, under the same debit-the-new/
 * credit-the-old shape transfer() uses.
 *
 * The funding trail (order_deposit_allocations, which of the OLD customer's
 * deposits paid for it) is left exactly as it was — reassigning the order
 * going forward does not rewrite which cash historically funded it, the same
 * choice reverseDeposit() makes about remainingAmount.
 */
const reassignHold = async ({ orderId, toCustomerId }, tx) => {
  const run = async (trx) => {
    const [hold] = await trx
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.orderId, orderId))
      .for("update")
      .limit(1);

    if (!hold) return { success: true, hold: null };
    if (hold.status !== "active") {
      return {
        success: false,
        message: "This order's payment has already been settled and its hold can no longer be reassigned",
      };
    }
    if (String(hold.customerId) === String(toCustomerId)) {
      return { success: true, hold };
    }

    const value = money(hold.amount);
    const updatedTo = await customerRepo.debitBalance(toCustomerId, value, trx);
    if (!updatedTo) {
      return {
        success: false,
        insufficient: true,
        message: "The destination customer doesn't have enough wallet balance to take over this order's hold",
      };
    }
    const updatedFrom = await customerRepo.creditBalance(hold.customerId, value, trx);

    const [movedHold] = await trx
      .update(walletHolds)
      .set({ customerId: toCustomerId })
      .where(eq(walletHolds.id, hold.id))
      .returning();

    return { success: true, hold: movedHold, fromCustomer: updatedFrom, toCustomer: updatedTo };
  };
  return tx ? run(tx) : db.transaction(run);
};

/**
 * Order funding, allocation and holds — REMOVED (order-first payments).
 *
 * What stood here: ALLOCATION_SOURCE, findDepositsMatchedToOrder(),
 * allocateOrderFunding() and deallocateOrderFunding(). Together they were the
 * bookkeeping that tried, after the fact, to say which wallet credit had paid
 * for which order.
 *
 * allocateOrderFunding ran in two passes. The first read the statement lines
 * actually matched to the order. The SECOND — the one the finance desk was
 * complaining about — took whatever the order still needed out of the rest of
 * the wallet, oldest credit first, and recorded that walk as though it were a
 * payment. An order short by ₦50,000 quietly consumed a slice of an unrelated
 * person's transfer from three weeks earlier, and the report printed it under
 * a bank reference that had nothing to do with the order.
 *
 * There is nothing left to allocate. A payment is recorded against the order
 * it paid for, at the moment it is confirmed, in order_payments — see
 * services/orderPayment.service.js and db/migrations/0021. No balance is ever
 * drawn on to cover a shortfall; an order that is short stays short, visibly,
 * which is the only state a finance desk can act on.
 *
 * order_deposit_allocations still exists and still holds the history this was
 * all backfilled from. It is read-only now: nothing writes it.
 */


/**
 * Undo a statement match outright: take the deposit back out of the wallet,
 * drop whatever order it was attributed to, and return its line to the
 * unmatched pool so it can be matched where it belongs.
 *
 * Unlike rematchOrderFunding this removes money rather than swapping it, so
 * it only works while that money is still free. If the deposit is what paid
 * a live order, reversing it would take the balance below what that order's
 * hold has committed — the guard in reverseDeposit refuses, and the caller
 * is told to re-match instead, which brings a replacement with it.
 *
 * The deposit row is not deleted. It is reversed, leaving both it and its
 * mirror debit on the ledger — a wallet's history is a record of what
 * happened, including the corrections.
 */
const unmatchStatementDeposit = async ({ depositId, staffId = null, description = "" }, tx) => {
  const run = async (trx) => {
    const [deposit] = await trx
      .select()
      .from(deposits)
      .where(eq(deposits.id, depositId))
      .for("update")
      .limit(1);
    if (!deposit) return { success: false, message: "Deposit not found" };
    if (deposit.type !== "credit") {
      return { success: false, message: "Only a credit deposit can be unmatched" };
    }

    // Which orders were pointing at it, so the caller can be told what was
    // detached rather than discovering it on the report afterwards.
    const attached = await trx
      .select({ orderId: orderDepositAllocations.orderId, amount: orderDepositAllocations.amount })
      .from(orderDepositAllocations)
      .where(eq(orderDepositAllocations.depositId, depositId));

    await trx.delete(orderDepositAllocations).where(eq(orderDepositAllocations.depositId, depositId));

    const res = await reverseDeposit(
      {
        depositId,
        recordedBy: staffId,
        description: description || `Unmatched — this payment was not for ${attached.length ? `order #${attached[0].orderId}` : "this customer"}`,
      },
      trx,
    );
    if (!res.success) {
      return {
        success: false,
        insufficient: res.insufficient,
        message: res.insufficient
          ? "This payment is what funded a live order, so it cannot simply be removed — the money is already committed. Use Re-match on that order to swap in the correct statement line instead."
          : res.message || "Could not unmatch this payment",
      };
    }

    const freed = await trx
      .update(bankStatementLines)
      .set({ status: "UNMATCHED", matchedDepositId: null, matchedOrderId: null, matchedBy: null, matchedAt: null })
      .where(eq(bankStatementLines.matchedDepositId, depositId))
      .returning();

    return {
      success: true,
      reversal: res.deposit,
      detachedFrom: attached.map((a) => a.orderId),
      freedLineIds: freed.map((l) => l.id),
    };
  };
  return tx ? run(tx) : db.transaction(run);
};

/**
 * rematchOrderFunding() — REMOVED (order-first payments).
 *
 * It swapped which wallet deposit was recorded as having paid for an order:
 * credit the replacement, reverse the mistake, free the old statement line.
 * The ordering was delicate — the replacement had to be credited BEFORE the
 * reversal, so the balance guard had money to work against — and the whole
 * thing existed only because a MATCHED line could never otherwise be released.
 *
 * The replacement is two plain operations, neither of which touches a balance:
 * remove the wrong payment from the order (its statement line goes back to the
 * unmatched pool) and record the right one. See
 * services/orderPayment.service.js — removePayment() and
 * recordFromStatementLines().
 */



/**
 * placeHold() / addToHold() — REMOVED (order-first payments).
 *
 * A hold committed money out of `customers.balance` for an order, and holds
 * were how every order was paid: the desk credited the wallet from the bank
 * statement, then the wallet paid the order. That indirection is precisely
 * what stopped anything from recording which bank row paid for which order.
 *
 * Nothing places a hold any more. releaseHold() and convertHold() below stay,
 * because holds placed under the old flow are still active in the live data
 * and have to resolve correctly when their orders cancel or complete.
 */



/**
 * Return held funds to the balance (order cancelled before fulfilment).
 * No ledger rows: the money never actually moved.
 */
const releaseHold = async (orderId, tx) => {
  const run = async (trx) => {
    const [hold] = await trx
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.orderId, orderId))
      .for("update")
      .limit(1);

    if (!hold || hold.status !== "active") {
      return { success: false, noActiveHold: true, hold: hold || null };
    }

    const [updatedHold] = await trx
      .update(walletHolds)
      .set({ status: "released", resolvedAt: new Date() })
      .where(eq(walletHolds.id, hold.id))
      .returning();

    // A release can never overdraw — it is only ever returning money this
    // same hold already took.
    await customerRepo.creditBalance(hold.customerId, money(hold.amount), trx);

    // Nothing to deallocate: the order_deposit_allocations bookkeeping this
    // used to unwind is no longer written, and the surviving rows are history.
    // An order's own payments are NOT detached when it is cancelled — see
    // order.service.releaseOrderResources for why that is deliberate.

    return { success: true, hold: updatedHold };
  };
  return tx ? run(tx) : db.transaction(run);
};

/**
 * Finalise a hold as a spend (order fulfilled). Writes the debit ledger row;
 * the balance was already reduced when the hold was placed, so it does not
 * change here.
 */
const convertHold = async (orderId, description = "", tx) => {
  const run = async (trx) => {
    const [hold] = await trx
      .select()
      .from(walletHolds)
      .where(eq(walletHolds.orderId, orderId))
      .for("update")
      .limit(1);

    if (!hold || hold.status !== "active") {
      return { success: false, noActiveHold: true, hold: hold || null };
    }

    const [customer] = await trx
      .select()
      .from(customers)
      .where(eq(customers.id, hold.customerId))
      .for("update")
      .limit(1);

    const [deposit] = await trx
      .insert(deposits)
      .values({
        customerId: hold.customerId,
        amount: asDecimal(hold.amount),
        type: "debit",
        description: description || hold.description || "",
        balanceAfter: asDecimal(customer.balance),
      })
      .returning();

    const [updatedHold] = await trx
      .update(walletHolds)
      .set({ status: "converted", depositId: deposit.id, resolvedAt: new Date() })
      .where(eq(walletHolds.id, hold.id))
      .returning();

    return { success: true, hold: updatedHold, deposit };
  };
  return tx ? run(tx) : db.transaction(run);
};

const findHoldByOrder = async (orderId, tx = db) => {
  const [hold] = await tx
    .select()
    .from(walletHolds)
    .where(eq(walletHolds.orderId, orderId))
    .limit(1);
  return hold || null;
};

/**
 * Recompute the balance from the ledger. Equal to customers.balance unless
 * something has written balances outside this service.
 */
const getLedgerBalance = async (customerId) => {
  const [{ credits, debits }] = await db
    .select({
      credits: sql`COALESCE(SUM(CASE WHEN ${deposits.type} = 'credit' THEN ${deposits.amount} ELSE 0 END), 0)`,
      debits: sql`COALESCE(SUM(CASE WHEN ${deposits.type} = 'debit' THEN ${deposits.amount} ELSE 0 END), 0)`,
    })
    .from(deposits)
    .where(eq(deposits.customerId, customerId));

  const [{ held }] = await db
    .select({ held: sql`COALESCE(SUM(${walletHolds.amount}), 0)` })
    .from(walletHolds)
    .where(and(eq(walletHolds.customerId, customerId), eq(walletHolds.status, "active")));

  return money(credits) - money(debits) - money(held);
};

/**
 * What survives here, and why.
 *
 * This module no longer pays for anything. Order payments live in
 * services/orderPayment.service.js (see db/migrations/0021). These remain for
 * the legacy wallet — 4,700-odd historical deposits and the customer credit
 * still to be reconciled onto orders:
 *
 *   credit / debit / transfer / reverseDeposit   moving and correcting legacy
 *                                                wallet balances
 *   unmatchStatementDeposit                      freeing a statement line that
 *                                                a legacy deposit is holding
 *   releaseHold / convertHold / findHoldByOrder  resolving holds placed before
 *                                                the cutover, as their orders
 *                                                cancel or complete
 *   reassignHold                                 moving one of those holds when
 *                                                an order changes customer
 *   getLedgerBalance                             reconciliation
 */
module.exports = {
  credit,
  creditFromStatementLines,
  debit,
  transfer,
  reverseDeposit,
  reassignHold,
  unmatchStatementDeposit,
  releaseHold,
  convertHold,
  findHoldByOrder,
  getLedgerBalance,
};
