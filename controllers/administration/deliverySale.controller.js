const asyncHandler = require("express-async-handler");
const stepNotices = require("../../services/stepNotices.service");
const { deliverySaleRepo, deliveryCustomerRepo } = require("../../repositories");
const { client } = require("../../config/db");
const { reachFor, rowInReach, writeInReach } = require("../../lib/saleReach");
const pfiBankScope = require("../../lib/pfiBankScope");
const stationEntry = require("../../lib/stationEntry");
const pfiDesks = require("../../lib/pfiDesks");
const { bookForWrite } = require("../../lib/deliveryBook");

/**
 * Each row with the record it is written into (migration 0070): the sales
 * ledger's or a station page's own. The screens say which; a row that does
 * not is placed by lib/deliveryBook's rule, which needs its customer's type.
 */
const placeRows = async (rows) => {
  const ids = [...new Set(rows.map((r) => Number(r.customerId ?? r.customer_id)).filter(Number.isFinite))];
  const found = ids.length
    ? await client`SELECT id, customer_type::text AS type FROM delivery_customers WHERE id = ANY(${ids}::int[])`
    : [];
  const types = new Map(found.map((c) => [Number(c.id), c.type]));
  return rows.map((r) => ({ ...r, book: bookForWrite(r, types.get(Number(r.customerId ?? r.customer_id))) }));
};

/** The signed-in person's name, as the ledger writes it: "First Surname", else their email. */
const actorName = (user) =>
  user ? user.name || [user.firstName, user.surname].filter(Boolean).join(" ") || user.email || "" : "";

/*
  ── What each person sees ──────────────────────────────────────────────────

  A truck sale reaches its PFI through its allocation code; a station's or
  plant's rows reach whoever is given that station or plant, on any PFI
  (lib/saleReach.js). Every list below is filtered that way; every single
  sale is checked before it is read or changed, and one outside reach reads
  as not found.
*/
const code = (v) => String(v || "").trim().toUpperCase();
const notFound = (res) => res.status(404).json({ success: false, message: "Sale record not found" });
const forbidden = (res, message) => res.status(403).json({ success: false, message });

/*
  ── Who sells a truck, and who records its money ──────────────────────────

  Selling a truck and taking its money are two jobs (the owner, 24 Oct 2026),
  and since 30 Oct each batch's own PFI says who does which (lib/pfiDesks.js):
  its Sales Manager or Truck Sales Officer sells it and corrects the sale, and
  its Finance / Audit Officer matches the payments off the bank statement —
  from Pending Orders or the ledger. A job nobody is named for stays as it
  was: anyone sells, finance takes the money. Admins may always do either.

  Only the sales ledger's rows: a station's own pump sales and deposits are
  its entry staff's (lib/stationEntry).
*/
const SALE_FIELDS = ["customerId", "customerName", "location", "quantity", "rate", "salesValue"];

/** A truck share sold to someone — a customer on it with litres or a value. */
const isSaleRow = (row) =>
  row?.customerId != null && (Number(row.quantity || 0) > 0 || Number(row.salesValue || 0) > 0);

const differs = (next, now) => {
  if (next === undefined) return false;
  const a = Number(next);
  const b = Number(now);
  if (next !== "" && now !== "" && next != null && now != null && Number.isFinite(a) && Number.isFinite(b)) return a !== b;
  return String(next ?? "").trim() !== String(now ?? "").trim();
};

/*
  ── Who enters a station's rows ────────────────────────────────────────────

  Seeing a station is not the same as entering for it. Its sales and
  expenses, and its deposits, may each be given to named people
  (lib/stationEntry.js, migration 0067); a row of that kind is then written,
  changed and deleted by them alone — and by admins, to correct. Every write
  below asks, after the visibility checks, so somebody who cannot see the
  station is still told "not yours" rather than who enters it.
*/

/**
 * The batch codes and customer of every row in a truck cycle — truck, load
 * date, customer. Matched the way cycleStanding matches: plates without
 * spaces, the date's first ten characters.
 */
const cycleRows = (cycle) => {
  const customerId = cycle?.customerId ?? null;
  return client`
    SELECT DISTINCT upper(trim(allocation_code)) AS "allocationCode", customer_id AS "customerId"
      FROM delivery_sales
     WHERE regexp_replace(upper(coalesce(truck_number, '')), '[[:space:]]', '', 'g')
         = regexp_replace(upper(${String(cycle?.truckNumber || "")}), '[[:space:]]', '', 'g')
       AND coalesce(left(date_loaded, 10), '') = ${String(cycle?.dateLoaded || "").slice(0, 10)}
       AND ${customerId == null ? client`customer_id IS NULL` : client`customer_id = ${Number(customerId)}`}`;
};

/** A cycle is visible when every sale in it is within this person's reach. */
const cycleVisible = async (reach, cycle) => {
  if (reach.open) return true;
  const rows = await cycleRows(cycle);
  return rows.length > 0 && rows.every((r) => rowInReach(reach, r));
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
    reach: await reachFor(req.user),
  });

  res.json({ success: true, data: result });
});

/**
 * Who sells and who takes the money on every batch, by code — so the ledger
 * and Pending Orders show each button only to whoever the server will let use
 * it, and name the person otherwise. Officers' names only; nothing else of
 * any PFI.
 */
const getDeliveryDesks = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { desks: await pfiDesks.listDesks() } });
});

const getDeliverySaleById = asyncHandler(async (req, res) => {
  const sale = await deliverySaleRepo.findById(req.params.id);
  if (!sale || !rowInReach(await reachFor(req.user), sale)) return notFound(res);
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
  const { lineIds, bankAccountId, ...rest } = req.body;
  /**
   * Who recorded it comes from the session, never from the page. The page
   * sent a name it read from browser storage and fell back to "Unknown" when
   * that was empty — which it was for everybody after the login rework — so
   * 600 rows since 24 August say "Unknown" instead of who keyed them.
   */
  const typed = { ...rest, enteredBy: actorName(req.user) || rest.enteredBy || "" };
  // A claimed credit is a deposit before it has an amount: the amount comes
  // off the statement line, after this.
  const claiming = Array.isArray(lineIds) && lineIds.length > 0;
  // Placed as money when it is a claim, so a station's claimed credit with no
  // record named is its own deposit.
  const [placed] = await placeRows([claiming ? { ...typed, paymentAmount: typed.paymentAmount || 1 } : typed]);
  const base = { ...typed, book: placed.book };
  const money = claiming || Number(base.paymentAmount || 0) !== 0;
  const batch = [base.allocationCode ?? base.allocation_code];
  if (base.book === "trucking") {
    const desk = money
      ? await pfiDesks.moneyRefusal(req.user, batch)
      : isSaleRow(base) ? await pfiDesks.sellRefusal(req.user, batch) : null;
    if (desk) return forbidden(res, desk);
  }

  // Only onto a batch of this person's PFI or a station of theirs, and only
  // from accounts they may use.
  if (!writeInReach(await reachFor(req.user), base)) {
    return forbidden(res, "That batch is not on your PFI, and that customer is not one of your stations.");
  }
  if (bankAccountId) await pfiBankScope.assertAccountAllowed(req.user, bankAccountId);
  const refusal = await stationEntry.refusalFor(req.user, [base], claiming ? { kinds: ["deposits"] } : {});
  if (refusal) return forbidden(res, refusal);

  if (claiming) {
    const sales = await deliverySaleRepo.createFromStatementLines({
      lineIds,
      bankAccountId,
      staffId: req.user?.id ?? null,
      base,
    });
    const total = sales.reduce((sum, s) => sum + Number(s.paymentAmount || 0), 0);
    stepNotices.salesRecorded(sales);
    return res.status(201).json({
      success: true,
      message: `${sales.length} payment${sales.length === 1 ? "" : "s"} matched — ₦${total.toLocaleString()}`,
      data: { sale: sales[0], sales },
    });
  }

  const sale = await deliverySaleRepo.create(
    bankAccountId ? { ...base, bankAccountId } : base,
  );
  // A customer put on a truck, or money on it: the driver, the customer, a
  // separate payer and finance hear. Never throws.
  stepNotices.salesRecorded([sale]);
  res.status(201).json({
    success: true,
    message: "Delivery sale record created",
    data: { sale },
  });
});

/**
 * Sell a loaded truck to one or more customers — the Sell truck dialog.
 *
 * One call for the whole sale, so the lines land together and the texts go
 * out once: each customer hears what they bought and where to pay, the driver
 * who to deliver to, and finance on the PFI what money to expect
 * (stepNotices.truckSold). What is left on the truck is checked server-side,
 * under a lock (deliverySaleRepo.sellTruck); more can be sold off it later
 * while litres remain.
 */
const sellTruck = asyncHandler(async (req, res) => {
  const { loadingId, lines } = req.body;
  const [load] = await client`
    SELECT id, allocation_code AS "allocationCode" FROM delivery_inventory WHERE id = ${Number(loadingId)}`;
  const reach = await reachFor(req.user);
  // The truck is theirs to sell when its batch is on their PFI, or when every
  // line goes to a station of theirs.
  const onBatch = !!load && (reach.open || (reach.codes !== null && reach.codes.includes(code(load.allocationCode))));
  if (!load || (!onBatch && !lines.every((l) => rowInReach(reach, l)))) {
    return res.status(404).json({ success: false, message: "That truck is not on the inventory." });
  }
  const desk = await pfiDesks.sellRefusal(req.user, [load.allocationCode]);
  if (desk) return forbidden(res, desk);

  const { load: sold, sales } = await deliverySaleRepo.sellTruck({
    loadingId,
    lines,
    enteredBy: actorName(req.user),
  });
  stepNotices.truckSold(sold.id, sales);

  const litres = sales.reduce((sum, s) => sum + Number(s.quantity || 0), 0);
  const value = sales.reduce((sum, s) => sum + Number(s.salesValue || 0), 0);
  res.status(201).json({
    success: true,
    message:
      `${sold.truckNumber} sold to ${sales.length} customer${sales.length === 1 ? "" : "s"} — ` +
      `${litres.toLocaleString("en-NG")} Litres${value > 0 ? `, ₦${value.toLocaleString("en-NG")}` : ""}`,
    data: { sales, load: sold },
  });
});

/**
 * Several rows in one transaction: a filling station's day, or an import.
 *
 * `enteredBy` is stamped here from the session rather than trusted per row —
 * an uploaded file could otherwise name anybody as its author.
 */
const createDeliverySalesBulk = asyncHandler(async (req, res) => {
  const actor = actorName(req.user);
  const rows = await placeRows(req.body.sales.map((row) => ({ ...row, enteredBy: actor || row.enteredBy || "" })));

  /**
   * A row with no truck is an LPG plant's, or nobody's.
   *
   * The plants' daily sheets are imported before their deliveries are on the
   * register, so those entries name no load yet — they sit on the plant's
   * account, unattached, until the loads are entered. Every other kind of
   * entry is placed on a truck's load the moment it is written, and still has
   * to say which.
   */
  const truckless = rows.filter((r) => !String(r.truckNumber || "").trim());
  if (truckless.length) {
    const ids = [...new Set(truckless.map((r) => Number(r.customerId)).filter(Boolean))];
    const plants = ids.length
      ? await client`SELECT id FROM delivery_customers WHERE id = ANY(${ids}::int[]) AND customer_type = 'lpg_plant'`
      : [];
    const plantIds = new Set(plants.map((p) => Number(p.id)));
    const i = rows.findIndex((r) => !String(r.truckNumber || "").trim() && !plantIds.has(Number(r.customerId)));
    if (i >= 0) {
      return res.status(400).json({
        success: false,
        message: `Row ${i + 1}: truck number is required`,
        errors: [{ path: `sales.${i}.truckNumber`, message: "Truck number is required" }],
      });
    }
  }

  const reach = await reachFor(req.user);
  if (rows.some((r) => !writeInReach(reach, r))) {
    return forbidden(res, "One or more of those rows is on a batch that is not on your PFI, for a customer that is not one of your stations.");
  }
  // The sales ledger's rows among them: sold by the batch's sellers, paid by its finance.
  const ledger = rows.filter((r) => r.book === "trucking");
  const batchesOf = (list) => list.map((r) => r.allocationCode ?? r.allocation_code);
  const money = ledger.filter((r) => Number(r.paymentAmount || 0) !== 0);
  const sold = ledger.filter((r) => Number(r.paymentAmount || 0) === 0 && isSaleRow(r));
  const desk = (money.length && (await pfiDesks.moneyRefusal(req.user, batchesOf(money))))
    || (sold.length && (await pfiDesks.sellRefusal(req.user, batchesOf(sold))));
  if (desk) return forbidden(res, desk);
  // A station's hand-keyed deposit names an account, and the single-row route
  // already refuses one outside this person's PFI. The same rule here.
  for (const accountId of new Set(rows.map((r) => r.bankAccountId).filter(Boolean))) {
    await pfiBankScope.assertAccountAllowed(req.user, accountId);
  }
  // All or nothing, like the insert: one row of somebody else's kind refuses the lot.
  const refusal = await stationEntry.refusalFor(req.user, rows);
  if (refusal) return forbidden(res, refusal);

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
  const ends = [req.body.from, ...(Array.isArray(req.body.to) ? req.body.to : [])];
  // Money may only move between trucks this person can see, both ends.
  const reach = await reachFor(req.user);
  for (const end of ends) {
    if (!(await cycleVisible(reach, end))) {
      return forbidden(res, "Both ends of a transfer must be on your PFI or at your stations.");
    }
  }
  // And it is the finance officer's of every batch it touches.
  const batches = (await Promise.all(ends.map(cycleRows))).flat().map((r) => r.allocationCode);
  const desk = await pfiDesks.moneyRefusal(req.user, batches);
  if (desk) return forbidden(res, desk);
  // Moving banked money between loads is deposits work, at both ends.
  const refusal = await stationEntry.refusalFor(req.user, ends, { kinds: ["deposits"] });
  if (refusal) return forbidden(res, refusal);
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
  if (!(await cycleVisible(await reachFor(req.user), cycle))) return notFound(res);
  const standing = await deliverySaleRepo.cycleStanding({
    truckNumber: req.query.truckNumber,
    dateLoaded: req.query.dateLoaded,
    customerId: req.query.customerId || null,
  });
  res.json({ success: true, data: standing });
});

const updateDeliverySale = asyncHandler(async (req, res) => {
  const sale = await deliverySaleRepo.findById(req.params.id);
  const reach = await reachFor(req.user);
  if (sale && !rowInReach(reach, sale)) return notFound(res);
  // Nor moved onto a batch or a station outside their reach.
  if (sale && !writeInReach(reach, { ...sale, ...req.body })) {
    return forbidden(res, "That batch is not on your PFI, and that customer is not one of your stations.");
  }
  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale record not found" });
  }
  /*
   * An edit never moves a row between the sales ledger and the station page.
   * A row with no book is placed by how it reads (lib/deliveryBook.js), and
   * that reading turns on whether it carries money — so pricing a station's
   * share on the ledger would otherwise make it read as one of the station's
   * own entries. Its present side is written onto it instead. A row from
   * before PFI-47B is left unmarked, to keep reading as it always has.
   */
  let keepBook = {};
  if (sale.book == null && req.body.book === undefined) {
    const reading = await deliverySaleRepo.readBookById(sale.id);
    if (reading === "trucking" || reading === "station") keepBook = { book: reading };
  }
  const current = { ...sale, ...keepBook };

  // Theirs as it stands AND as it would stand: a sales row cannot be edited
  // into a deposit by somebody who does not enter deposits, nor the reverse.
  const refusal = await stationEntry.refusalFor(req.user, [current, { ...current, ...req.body }]);
  if (refusal) return forbidden(res, refusal);
  if (current.book === "trucking") {
    // The batch it is on now and the one it would be on.
    const batches = [current.allocationCode, req.body.allocationCode ?? req.body.allocation_code];
    const movesMoney = differs(req.body.paymentAmount, sale.paymentAmount ?? 0);
    const changesSale = SALE_FIELDS.some((f) => differs(req.body[f], sale[f]));
    const desk = (movesMoney && (await pfiDesks.moneyRefusal(req.user, batches)))
      || (changesSale && isSaleRow({ ...current, ...req.body }) && (await pfiDesks.sellRefusal(req.user, batches)));
    if (desk) return forbidden(res, desk);
  }

  // An edit is not a new author: whoever recorded the row stays on it. The
  // page resends the whole row, "Unknown" and all, so it is dropped here.
  const { enteredBy: _ignored, entered_by: _ignoredSnake, ...changes } = req.body;
  const updated = await deliverySaleRepo.update(sale.id, { ...keepBook, ...changes });

  // An edit that puts a new customer on the truck, or first puts money on it,
  // is the same news as a new row saying so. Anything else is a correction.
  const movedCustomer = updated?.customerId && Number(updated.customerId) !== Number(sale.customerId);
  const firstMoney = Number(updated?.paymentAmount || 0) > 0 && !(Number(sale.paymentAmount || 0) > 0);
  if (firstMoney) stepNotices.salesRecorded([updated]);
  else if (movedCustomer) stepNotices.salesRecorded([{ ...updated, paymentAmount: 0 }]);

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
  if (sale && !rowInReach(await reachFor(req.user), sale)) {
    return notFound(res);
  }
  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale record not found" });
  }

  const updated = await deliverySaleRepo.update(sale.id, {
    depositStatus: req.body.depositStatus,
  });
  // Paid in full, and it was not before: the customer is told it is confirmed.
  if (req.body.depositStatus === "paid" && sale.depositStatus !== "paid") stepNotices.depositConfirmed(updated);

  res.json({
    success: true,
    message: `Deposit marked ${req.body.depositStatus}`,
    data: { sale: updated },
  });
});

const deleteDeliverySale = asyncHandler(async (req, res) => {
  const existing = await deliverySaleRepo.findById(req.params.id);
  const reach = await reachFor(req.user);
  if (!reach.open || !stationEntry.mayAlwaysEnter(req.user)) {
    if (existing && !rowInReach(reach, existing)) return notFound(res);
    if (!reach.open && !existing) return notFound(res);
    const refusal = await stationEntry.refusalFor(req.user, existing ? [existing] : []);
    if (refusal) return forbidden(res, refusal);
  }
  // A ledger row is its batch's: a payment, once recorded, is its finance
  // officer's to take off again, and a sold share its sellers'.
  if (existing) {
    const side = existing.book || (await deliverySaleRepo.readBookById(existing.id));
    if (side === "trucking") {
      const batches = [existing.allocationCode];
      const desk = Number(existing.paymentAmount || 0) !== 0
        ? await pfiDesks.moneyRefusal(req.user, batches)
        : isSaleRow(existing) ? await pfiDesks.sellRefusal(req.user, batches) : null;
      if (desk) return forbidden(res, desk);
    }
  }
  const sale = await deliverySaleRepo.deleteById(req.params.id);
  if (!sale) {
    return res.status(404).json({ success: false, message: "Sale record not found" });
  }
  res.json({ success: true, message: "Delivery sale deleted" });
});

module.exports = {
  createDeliverySalesBulk,
  getDeliveryDesks,
  getDeliverySales,
  getDeliverySaleById,
  createDeliverySale,
  sellTruck,
  updateDeliverySale,
  setDeliverySaleDepositStatus,
  deleteDeliverySale,
  transferDeliveryOverpayment,
  getDeliveryCycleStanding,
};
