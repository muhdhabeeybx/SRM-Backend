const asyncHandler = require("express-async-handler");
const { deliverySaleRepo, deliveryCustomerRepo } = require("../../repositories");
const { client } = require("../../config/db");
const { allocationCodesFor } = require("../../lib/pfiScope");
const pfiBankScope = require("../../lib/pfiBankScope");

/*
  ── Staff assigned to a PFI see its truck sales and no others ─────────────

  A truck sale reaches its PFI through its allocation code (lib/pfiScope.js,
  allocationCodesFor). Every list below is filtered by the codes the person
  may see; every single sale is checked before it is read or changed, and one
  outside their PFI reads as not found.
*/
const code = (v) => String(v || "").trim().toUpperCase();
const notFound = (res) => res.status(404).json({ success: false, message: "Sale record not found" });
const forbidden = (res, message) => res.status(403).json({ success: false, message });

const saleVisible = (codes, sale) => codes === null || (!!sale && codes.includes(code(sale.allocationCode)));

/**
 * A truck cycle — truck, load date, customer — is visible when every sale in
 * it carries a code this person may see. Matched the way cycleStanding
 * matches: plates without spaces, the date's first ten characters.
 */
const cycleVisible = async (codes, cycle) => {
  if (codes === null) return true;
  const customerId = cycle?.customerId ?? null;
  const rows = await client`
    SELECT DISTINCT upper(trim(allocation_code)) AS code
      FROM delivery_sales
     WHERE regexp_replace(upper(coalesce(truck_number, '')), '\s', '', 'g')
         = regexp_replace(upper(${String(cycle?.truckNumber || "")}), '\s', '', 'g')
       AND coalesce(left(date_loaded, 10), '') = ${String(cycle?.dateLoaded || "").slice(0, 10)}
       AND ${customerId == null ? client`customer_id IS NULL` : client`customer_id = ${Number(customerId)}`}`;
  return rows.length > 0 && rows.every((r) => codes.includes(r.code));
};
// Paystack DVA auto-generation is disabled — see createDeliverySale below.
// Re-add this import if reinstating:
// const { generateDeliveryCustomerDva } = require("../../services/deliveryCustomerDva.service");

const getDeliverySales = asyncHandler(async (req, res) => {
  const { search, customer, truck_number, date_from, date_to, page = 1, limit = 500 } = req.query;

  const result = await deliverySaleRepo.findAll({
    search,
    customer,
    truck_number,
    date_from,
    date_to,
    page,
    limit,
    allowedCodes: await allocationCodesFor(req.user),
  });

  res.json({ success: true, data: result });
});

const getDeliverySaleById = asyncHandler(async (req, res) => {
  const sale = await deliverySaleRepo.findById(req.params.id);
  if (!sale || !saleVisible(await allocationCodesFor(req.user), sale)) return notFound(res);
  res.json({ success: true, data: { sale } });
});

const createDeliverySale = asyncHandler(async (req, res) => {
  // Paystack DVA auto-generation (disabled — manual deposit only): delivery
  // customers used to get a personal DVA on first truck assignment so a bank
  // transfer could auto-credit their wallet. Wallet funding is
  // manual-deposit-only now (staff record deposits from the admin
  // dashboard), so there's nothing to auto-generate. Kept for
  // reinstatement — restore this block and the import above.
  //
  // if (req.body.customer) {
  //   try {
  //     const customer = await deliveryCustomerRepo.findById(req.body.customer);
  //     if (customer && !customer.virtualAccountNumber) {
  //       const dvaResult = await generateDeliveryCustomerDva(customer);
  //       if (dvaResult.success) {
  //         console.log(`DVA generated for customer ${customer.name}: ${dvaResult.data.accountNumber}`);
  //       } else {
  //         console.warn(`DVA generation failed for customer ${customer.name}: ${dvaResult.message}`);
  //       }
  //     }
  //   } catch (dvaErr) {
  //     console.warn("DVA auto-generation error (non-blocking):", dvaErr.message);
  //   }
  // }

  /**
   * Two ways in, and only one of them is new.
   *
   * With lineIds the payment is claimed off the bank statement: the amount,
   * payer, date and reference come from the bank's own row and the credit is
   * marked spent so nothing else can claim it. Without them this is the path
   * every row before migration 0044 took — a customer assignment with no
   * payment yet, a transfer between trucks, an expense — and it is left
   * exactly as it was.
   */
  const { lineIds, bankAccountId, ...base } = req.body;

  // Only onto a batch of this person's PFI, and only from its accounts.
  const codes = await allocationCodesFor(req.user);
  if (codes !== null && !codes.includes(code(base.allocationCode ?? base.allocation_code))) {
    return forbidden(res, "That batch is not on your PFI.");
  }
  if (bankAccountId) await pfiBankScope.assertAccountAllowed(req.user, bankAccountId);

  if (Array.isArray(lineIds) && lineIds.length) {
    const sales = await deliverySaleRepo.createFromStatementLines({
      lineIds,
      bankAccountId,
      staffId: req.user?.id ?? null,
      base,
    });
    const total = sales.reduce((sum, s) => sum + Number(s.paymentAmount || 0), 0);
    return res.status(201).json({
      success: true,
      message: `${sales.length} payment${sales.length === 1 ? "" : "s"} matched — ₦${total.toLocaleString()}`,
      data: { sale: sales[0], sales },
    });
  }

  const sale = await deliverySaleRepo.create(
    bankAccountId ? { ...base, bankAccountId } : base,
  );
  res.status(201).json({
    success: true,
    message: "Delivery sale record created",
    data: { sale },
  });
});

/**
 * Several rows in one transaction: a filling station's day, or an import.
 *
 * `enteredBy` is stamped here from the session rather than trusted per row —
 * an uploaded file could otherwise name anybody as its author.
 */
const createDeliverySalesBulk = asyncHandler(async (req, res) => {
  const actor = req.user
    ? [req.user.firstName, req.user.surname].filter(Boolean).join(" ") || req.user.email || ""
    : "";
  const rows = req.body.sales.map((row) => ({ ...row, enteredBy: actor || row.enteredBy || "" }));

  const codes = await allocationCodesFor(req.user);
  if (codes !== null && rows.some((r) => !codes.includes(code(r.allocationCode ?? r.allocation_code)))) {
    return forbidden(res, "One or more of those rows is on a batch that is not on your PFI.");
  }
  // A station's hand-keyed deposit names an account, and the single-row route
  // already refuses one outside this person's PFI. The same rule here.
  for (const accountId of new Set(rows.map((r) => r.bankAccountId).filter(Boolean))) {
    await pfiBankScope.assertAccountAllowed(req.user, accountId);
  }

  const sales = await deliverySaleRepo.createMany(rows);
  res.status(201).json({
    success: true,
    message: `${sales.length} entr${sales.length === 1 ? "y" : "ies"} recorded`,
    data: { sales, count: sales.length },
  });
});

/**
 * Move a truck's overpayment onto other trucks.
 *
 * Its own route rather than two calls to the create endpoint: the debit and
 * the credit have to land together, and a client that managed the second
 * without the first would have created money. The repository also recomputes
 * the available surplus from the table, so the amount is never taken on the
 * caller's word.
 */
const transferDeliveryOverpayment = asyncHandler(async (req, res) => {
  // Money may only move between trucks this person can see, both ends.
  const codes = await allocationCodesFor(req.user);
  if (codes !== null) {
    const ends = [req.body.from, ...(Array.isArray(req.body.to) ? req.body.to : [])];
    for (const end of ends) {
      if (!(await cycleVisible(codes, end))) {
        return forbidden(res, "Both ends of a transfer must be on your PFI.");
      }
    }
  }
  const actor = req.user?.name || req.user?.email || "";
  const result = await deliverySaleRepo.transferOverpayment({
    from: req.body.from,
    to: req.body.to,
    actor,
  });

  res.status(201).json({
    success: true,
    message:
      result.remaining > 0
        ? `Transferred — ${result.remaining.toFixed(2)} of the overpayment is still unallocated`
        : "Overpayment transferred",
    data: result,
  });
});

/** What one truck-cycle is owed and has taken, so the dialog can offer a cap. */
const getDeliveryCycleStanding = asyncHandler(async (req, res) => {
  const cycle = {
    truckNumber: req.query.truckNumber,
    dateLoaded: req.query.dateLoaded,
    customerId: req.query.customerId || null,
  };
  if (!(await cycleVisible(await allocationCodesFor(req.user), cycle))) return notFound(res);
  const standing = await deliverySaleRepo.cycleStanding({
    truckNumber: req.query.truckNumber,
    dateLoaded: req.query.dateLoaded,
    customerId: req.query.customerId || null,
  });
  res.json({ success: true, data: standing });
});

const updateDeliverySale = asyncHandler(async (req, res) => {
  const sale = await deliverySaleRepo.findById(req.params.id);
  const codes = await allocationCodesFor(req.user);
  if (sale && !saleVisible(codes, sale)) return notFound(res);
  // Nor may it be moved onto a batch outside their PFI.
  const nextCode = req.body.allocationCode ?? req.body.allocation_code;
  if (codes !== null && nextCode !== undefined && !codes.includes(code(nextCode))) {
    return forbidden(res, "That batch is not on your PFI.");
  }
  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale record not found" });
  }

  const updated = await deliverySaleRepo.update(sale.id, req.body);

  res.json({
    success: true,
    message: "Delivery sale record updated",
    data: { sale: updated },
  });
});

/**
 * Confirm (or un-confirm) a hand-recorded deposit.
 *
 * Its own route because depositStatus is deliberately absent from the update
 * schema — see the audit note in schemas/deliverySale.schema.js. The UI's
 * toggle previously sent it on the update route, where zod stripped it, so
 * the status never moved while the toast said it had.
 */
const setDeliverySaleDepositStatus = asyncHandler(async (req, res) => {
  const sale = await deliverySaleRepo.findById(req.params.id);
  if (sale && !saleVisible(await allocationCodesFor(req.user), sale)) return notFound(res);
  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale record not found" });
  }

  const updated = await deliverySaleRepo.update(sale.id, {
    depositStatus: req.body.depositStatus,
  });

  res.json({
    success: true,
    message: `Deposit marked ${req.body.depositStatus}`,
    data: { sale: updated },
  });
});

const deleteDeliverySale = asyncHandler(async (req, res) => {
  const codes = await allocationCodesFor(req.user);
  if (codes !== null) {
    const existing = await deliverySaleRepo.findById(req.params.id);
    if (!existing || !saleVisible(codes, existing)) return notFound(res);
  }
  const sale = await deliverySaleRepo.deleteById(req.params.id);
  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale record not found" });
  }
  res.json({ success: true, message: "Delivery sale deleted" });
});

module.exports = {
  createDeliverySalesBulk,
  getDeliverySales,
  getDeliverySaleById,
  createDeliverySale,
  updateDeliverySale,
  setDeliverySaleDepositStatus,
  deleteDeliverySale,
  transferDeliveryOverpayment,
  getDeliveryCycleStanding,
};
