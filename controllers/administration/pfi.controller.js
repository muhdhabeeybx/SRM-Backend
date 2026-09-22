const asyncHandler = require("express-async-handler");
const {
  pfiRepo,
  pfiExpenseRepo,
  depotRepo,
  lpgStationRepo,
  productRepo,
  staffRepo,
  orderRepo,
  orderPfiAllocationRepo,
} = require("../../repositories");
const { db } = require("../../config/db");
const { eq } = require("drizzle-orm");
const { pfiMovements } = require("../../db/schema");
const { computeFinancials, explainFinancials, BILLED_ON_OWN_QUANTITY } = require("../../lib/pfiFinance");
const { resolveBooking, actorFor, vendorFor } = require("./expense.controller");
const { isWithinScope } = require("../../lib/scopeFilter");
const smsService = require("../../services/sms.service");

function httpErr(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Attach the money figures to one PFI or a list of them.
 *
 * Aggregates are fetched for the whole page in three grouped queries rather
 * than a dozen per row — the difference between a list that renders instantly
 * and one that takes seconds once there are a few dozen batches.
 */
const withFinancials = async (rows) => {
  const many = Array.isArray(rows);
  const list = many ? rows : [rows];
  const aggs = await pfiExpenseRepo.aggregatesFor(list.map((p) => p.id));
  const decorated = list.map((pfi) => {
    const agg = aggs.get(Number(pfi.id)) || {};
    return {
      ...pfi,
      financials: computeFinancials(pfi, agg),
      orderCount: agg.orderCount || 0,
      expenseCount: agg.expenseCount || 0,
    };
  });
  return many ? decorated : decorated[0];
};

/** A calendar day as the `date` columns want it, from anything parseable. */
const calendarDay = (val) => {
  const d = parseDate(val);
  if (!d) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

const parseDate = (val) => {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
};

const resolveOfficerName = async (id) => {
  if (!id) return "";
  try {
    const admin = await staffRepo.findById(id);
    if (!admin) return "";
    return `${admin.firstName || ""} ${admin.surname || ""}`.trim();
  } catch {
    return "";
  }
};

const getPfis = asyncHandler(async (req, res) => {
  const { search, status, page = 1, limit = 100, location, type } = req.query;

  const result = await pfiRepo.findAll({ search, status, location, type, scopeUser: req.user, page, limit });
  result.pfis = await withFinancials(result.pfis || []);

  res.json({ success: true, data: result });
});

const getPfiById = asyncHandler(async (req, res) => {
  const found = await pfiRepo.findById(req.params.id);

  if (!found) {
    return res.status(404).json({ success: false, message: "PFI not found" });
  }

  // The drawer needs the lines behind the totals, not just the totals.
  //
  // `orders` is the sales — payment confirmed, the same rule the revenue and
  // sold figures use. `movements` is the ticketing ledger, which is a
  // different fact and stays available for anyone reading loading progress.
  const [pfi, expenses, movements, orders] = await Promise.all([
    withFinancials(found),
    pfiExpenseRepo.listExpensesForPfi(found.id),
    pfiExpenseRepo.listMovements(found.id),
    pfiExpenseRepo.listOrdersForPfi(found.id),
  ]);

  // How each figure was reached, in words, with this batch's own numbers
  // substituted in. Attached to the DETAIL response only — the list renders
  // dozens of rows and none of them shows a formula, so carrying it there
  // would be payload nobody reads.
  const explain = explainFinancials(pfi, pfi.financials);

  res.json({ success: true, data: { pfi, expenses, movements, orders, explain } });
});

/**
 * "coastal" unless the body explicitly says gantry.
 *
 * Anything unrecognised falls back to coastal rather than 400-ing: the column
 * defaults to coastal, every existing row is coastal, and a client that has not
 * been taught about types yet must keep creating the kind it always did.
 */
/**
 * Anything unrecognised becomes 'coastal', which is what it did before and
 * remains the safe default: it is the plainest kind of batch and enables no
 * behaviour the others do not have.
 */
const PFI_TYPES = new Set(["coastal", "gantry", "delivery", "trucking"]);
const normalisePfiType = (raw) => {
  const t = String(raw || "").trim().toLowerCase();
  return PFI_TYPES.has(t) ? t : "coastal";
};

const createPfi = asyncHandler(async (req, res) => {
  const pfi_number = req.body.pfi_number || req.body.pfiNumber;
  const description = req.body.description || "";
  const pfi_date = req.body.pfi_date || req.body.pfiDate;
  /**
   * When this cargo starts taking money. Defaults to the PFI's own date,
   * which is right for a new PFI — the historical ones are backfilled from
   * the money that actually arrived. See migration 0052.
   */
  const collections_open_from =
    req.body.collections_open_from || req.body.collectionsOpenFrom || pfi_date;
  const location_id = req.body.location_id || req.body.locationId;
  const product_id = req.body.product_id || req.body.productId;
  const starting_qty_litres = req.body.starting_qty_litres ?? req.body.startingQtyLitres;
  const bl_qty_litres = req.body.bl_qty_litres ?? req.body.blQtyLitres;
  const bl_qty_mt = req.body.bl_qty_mt ?? req.body.blQtyMt;
  const qty_volume_mt = req.body.qty_volume_mt ?? req.body.qtyVolumeMt;
  const unit_price = req.body.unit_price ?? req.body.unitPrice;
  const credit_balance = req.body.credit_balance ?? req.body.creditBalance;
  const audit_officer = req.body.audit_officer || req.body.auditOfficerId;
  const product_officer = req.body.product_officer || req.body.productOfficerId;
  const it_compliance_officer = req.body.it_compliance_officer || req.body.itComplianceOfficerId;
  const security_exit_officer = req.body.security_exit_officer || req.body.securityExitOfficerId;
  const commission_officer = req.body.commission_officer || req.body.commissionOfficerId;
  const sales_manager = req.body.sales_manager || req.body.salesManagerId;
  const vessel_broker = req.body.vessel_broker || req.body.vesselBroker;
  const vessel_name = req.body.vessel_name || req.body.vesselName;
  const surveyor_name = req.body.surveyor_name || req.body.surveyorName;
  const surveyor_phone = req.body.surveyor_phone || req.body.surveyorPhone;
  const pfi_type = normalisePfiType(req.body.pfi_type ?? req.body.pfiType);
  const ticket_count = req.body.ticket_count ?? req.body.ticketCount;

  // Neither a gantry batch nor a delivery batch has shipping papers or a
  // vessel — one is bought at the loading gantry, the other loaded onto trucks
  // at a depot. Dropping these here rather than trusting the client means a
  // form that once sent them cannot leave such a row carrying a BL figure it
  // will then be costed against.
  //
  // updatePfi and lib/pfiFinance both already treat the two the same way. This
  // path did not, so a delivery batch could be CREATED with a BL that every
  // later read then ignored — the row saying one thing and its own valuation
  // another.
  const isGantry = BILLED_ON_OWN_QUANTITY.has(pfi_type);

  if (!pfi_number) {
    return res.status(400).json({ success: false, message: "PFI number is required" });
  }

  const existing = await pfiRepo.findByNumber(String(pfi_number).trim());
  if (existing) {
    return res.status(409).json({ success: false, message: "A PFI with this number already exists" });
  }

  let location_name = "";
  let location_id_val = null;

  if (location_id) {
    location_id_val = parseInt(location_id, 10) || location_id;
    if (!isWithinScope(req.user, "depotIds", location_id_val)) {
      return res.status(403).json({ success: false, message: "You cannot create a PFI for this location" });
    }
    const depot = await depotRepo.findById(location_id_val);
    if (depot) location_name = depot.name;
  }

  let product_name = "";
  let product_unit = "Litres";
  if (product_id) {
    const prod = await productRepo.findById(product_id);
    if (prod) {
      product_name = prod.name;
      product_unit = prod.unit || "Litres";
    }
  }

  const officerDefs = [
    { field: "audit_officer", idKey: "auditOfficerId", nameKey: "auditOfficerName" },
    { field: "product_officer", idKey: "productOfficerId", nameKey: "productOfficerName" },
    { field: "it_compliance_officer", idKey: "itComplianceOfficerId", nameKey: "itComplianceOfficerName" },
    { field: "security_exit_officer", idKey: "securityExitOfficerId", nameKey: "securityExitOfficerName" },
    { field: "commission_officer", idKey: "commissionOfficerId", nameKey: "commissionOfficerName" },
    { field: "sales_manager", idKey: "salesManagerId", nameKey: "salesManagerName" },
  ];

  const officerNames = {};
  for (const { field, idKey, nameKey } of officerDefs) {
    const val = req.body[field] || req.body[idKey] || req.body[`${field}_id`];
    officerNames[nameKey] = await resolveOfficerName(val);
  }

  /**
   * Every PFI is raised not_started. There is no longer a choice.
   *
   * It used to default to active, so a batch could be raised and trading in
   * one save with no bank account against it and nobody answerable for it.
   * Raising now captures the cargo; assigning the bank and the officers is a
   * separate act by somebody who did not raise it, and that act is what lets
   * it trade. See activatePfi below and migration 0046.
   */
  const requestedStatus = "not_started";

  const pfi = await pfiRepo.create({
    pfiNumber: String(pfi_number).trim(),
    pfiType: pfi_type,
    status: requestedStatus,
    description: description || "",
    pfiDate: parseDate(pfi_date),
    collectionsOpenFrom: calendarDay(collections_open_from),
    locationId: location_id_val,
    lpgStationId: null,
    locationName: location_name,
    productId: product_id ? (parseInt(product_id, 10) || product_id) : null,
    productName: product_name,
    productUnit: req.body.product_unit || req.body.productUnit || product_unit || "Litres",
    startingQtyLitres: Number(starting_qty_litres) || 0,
    // Left null when not supplied — an unknown BL must not read as zero, or
    // every money figure downstream would silently compute against it.
    blQtyLitres:
      isGantry || bl_qty_litres == null || bl_qty_litres === "" ? null : Number(bl_qty_litres),
    blQtyMt: isGantry || bl_qty_mt == null || bl_qty_mt === "" ? null : Number(bl_qty_mt),
    qtyVolumeMt: isGantry ? "0" : Number(qty_volume_mt) || 0,
    // Same "blank means unknown" rule: zero tickets is a real answer nobody
    // has given yet.
    ticketCount: ticket_count == null || ticket_count === "" ? null : Number(ticket_count),
    unitPrice: String(Number(unit_price) || 0),
    creditBalance: String(Number(credit_balance) || 0),
    auditOfficerId: audit_officer ? (parseInt(audit_officer, 10) || audit_officer) : null,
    productOfficerId: product_officer ? (parseInt(product_officer, 10) || product_officer) : null,
    itComplianceOfficerId: it_compliance_officer ? (parseInt(it_compliance_officer, 10) || it_compliance_officer) : null,
    securityExitOfficerId: security_exit_officer ? (parseInt(security_exit_officer, 10) || security_exit_officer) : null,
    commissionOfficerId: commission_officer ? (parseInt(commission_officer, 10) || commission_officer) : null,
    salesManagerId: sales_manager ? (parseInt(sales_manager, 10) || sales_manager) : null,
    ...officerNames,
    vesselBroker: isGantry ? "" : vessel_broker || "",
    vesselName: isGantry ? "" : vessel_name || "",
    surveyorName: isGantry ? "" : surveyor_name || "",
    surveyorPhone: isGantry ? "" : surveyor_phone || "",
    // Who raised it, so the review desk knows whose work it is reading.
    raisedBy: req.user?.id ?? null,
    raisedAt: new Date(),
    /**
     * A trucking batch waits with its PFI.
     *
     * The trucks are named now and written as delivery_inventory rows at
     * activation. Writing them here would put the loads on the inventory and
     * into the sales ledger — owing money — against a batch nobody had signed
     * off, which is exactly what the gate exists to prevent.
     */
    pendingBatch: pfi_type === "trucking" && req.body.batch ? req.body.batch : null,
    allocationCode:
      pfi_type === "trucking" && req.body.batch?.code ? String(req.body.batch.code) : null,
  });

  /**
   * Tell the review desk. Deliberately not awaited for its result.
   *
   * The PFI is already written. An SMS gateway being down, or
   * PFI_REVIEW_PHONE simply not being configured, must not turn a saved batch
   * into a failed request — the desk would raise it again and the register
   * would carry it twice.
   */
  if (process.env.PFI_REVIEW_PHONE) {
    smsService
      .sendPfiReviewSMS(process.env.PFI_REVIEW_PHONE, {
        pfiNumber: pfi.pfiNumber,
        pfiType: pfi.pfiType,
        locationName: pfi.locationName,
        productName: pfi.productName,
        raisedBy: req.user?.name || "",
      })
      .catch((err) => console.warn("PFI review SMS failed:", err.message));
  }

  // Every PFI becomes an expense category the moment it exists. Without this
  // there is no way to book a cost against the batch at all.
  await pfiExpenseRepo.ensureCategoryForPfi(pfi.id, pfi.pfiNumber);

  res.status(201).json({
    success: true,
    message: "PFI created successfully",
    data: { pfi: await withFinancials(pfi) },
  });
});

const updatePfi = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);

  if (!pfi) {
    return res.status(404).json({ success: false, message: "PFI not found" });
  }

  const allowedFields = [
    "pfi_number", "description", "pfi_date", "collections_open_from", "status", "starting_qty_litres",
    "bl_qty_litres", "bl_qty_mt", "ticket_count",
    "qty_volume_mt", "sold_qty_litres", "total_amount", "unit_price", "credit_balance", "product_unit",
    "vessel_broker", "vessel_name", "surveyor_name", "surveyor_phone",
    "closure_date", "total_inflow", "closure_bank", "purchase_cost",
    "aggregate_expenses", "closure_handler", "closure_remarks",
  ];

  const updateData = {};
  for (const field of allowedFields) {
    const camelKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = req.body[field] !== undefined ? req.body[field] : req.body[camelKey];
    if (value !== undefined) {
      if (field === "pfi_date") {
        updateData.pfiDate = parseDate(value);
      } else if (field === "collections_open_from") {
        // A plain calendar day, and blank clears the window back to "offer
        // every credit" rather than setting an epoch nobody chose.
        updateData.collectionsOpenFrom =
          value === "" || value === null ? null : calendarDay(value);
      } else if (field === "closure_date") {
        updateData.closureDate = parseDate(value);
      } else if (field === "bl_qty_litres") {
        // Blank clears it back to unknown rather than setting zero.
        updateData.blQtyLitres = value === "" || value === null ? null : Number(value);
      } else if (field === "bl_qty_mt") {
        // Same "blank means unknown" rule as bl_qty_litres.
        updateData.blQtyMt = value === "" || value === null ? null : Number(value);
      } else if (field === "ticket_count") {
        updateData.ticketCount = value === "" || value === null ? null : Number(value);
      } else {
        updateData[camelKey] = value;
      }
    }
  }

  // Switching a batch to gantry has to clear what stops applying, not just
  // stop showing it. A leftover BL figure would still be what pfiValue is
  // computed from, so the batch would keep reporting a cost against a document
  // it no longer has.
  const rawType = req.body.pfi_type ?? req.body.pfiType;
  const pfiType = rawType !== undefined ? normalisePfiType(rawType) : pfi.pfiType;
  if (rawType !== undefined) updateData.pfiType = pfiType;

  // A delivery batch is loaded onto trucks at a depot, so it has no vessel and
  // no BL either — the same facts stop applying as for gantry.
  if (BILLED_ON_OWN_QUANTITY.has(pfiType)) {
    Object.assign(updateData, {
      blQtyLitres: null,
      blQtyMt: null,
      qtyVolumeMt: "0",
      vesselBroker: "",
      vesselName: "",
      surveyorName: "",
      surveyorPhone: "",
    });
  }

  // Only coastal has no count of its own. `ticket_count` holds the gantry
  // ticket count and the delivery truck count — the same fact in both cases,
  // how many units the allocation was split into — so clearing it for
  // everything that is not gantry wiped the truck count off a delivery batch
  // on every edit.
  if (rawType !== undefined && pfiType === "coastal") {
    updateData.ticketCount = null;
  }

  const customUnit = req.body.product_unit || req.body.productUnit;
  if (customUnit) {
    updateData.productUnit = customUnit;
  }

  if (req.body.location_id !== undefined || req.body.locationId !== undefined) {
    const locId = req.body.location_id !== undefined ? req.body.location_id : req.body.locationId;
    if (locId && locId !== "none") {
      const parsedLoc = parseInt(locId, 10) || locId;
      if (!isWithinScope(req.user, "depotIds", parsedLoc)) {
        return res.status(403).json({ success: false, message: "You cannot move this PFI to a location outside your scope" });
      }
      updateData.locationId = parsedLoc;
      updateData.lpgStationId = null;
      const depot = await depotRepo.findById(parsedLoc);
      updateData.locationName = depot ? depot.name : "";
    } else {
      updateData.locationId = null;
      updateData.locationName = "";
    }
  }

  if (req.body.product_id !== undefined || req.body.productId !== undefined) {
    const prodId = req.body.product_id !== undefined ? req.body.product_id : req.body.productId;
    if (prodId) {
      const parsedProd = parseInt(prodId, 10) || prodId;
      updateData.productId = parsedProd;
      const prod = await productRepo.findById(parsedProd);
      if (prod) {
        updateData.productName = prod.name;
        if (!customUnit) {
          updateData.productUnit = prod.unit || "Litres";
        }
      }
    }
  }

  const officerDefs = [
    { field: "audit_officer", idKey: "auditOfficerId", nameKey: "auditOfficerName" },
    { field: "product_officer", idKey: "productOfficerId", nameKey: "productOfficerName" },
    { field: "it_compliance_officer", idKey: "itComplianceOfficerId", nameKey: "itComplianceOfficerName" },
    { field: "security_exit_officer", idKey: "securityExitOfficerId", nameKey: "securityExitOfficerName" },
    { field: "commission_officer", idKey: "commissionOfficerId", nameKey: "commissionOfficerName" },
    { field: "sales_manager", idKey: "salesManagerId", nameKey: "salesManagerName" },
  ];

  for (const { field, idKey, nameKey } of officerDefs) {
    const val =
      req.body[idKey] !== undefined
        ? req.body[idKey]
        : req.body[`${field}_id`] !== undefined
        ? req.body[`${field}_id`]
        : req.body[field] !== undefined
        ? req.body[field]
        : undefined;

    if (val !== undefined) {
      const numericVal = val ? (parseInt(val, 10) || val) : null;
      updateData[idKey] = numericVal;
      updateData[nameKey] = await resolveOfficerName(val);
    }
  }

  const updated = await pfiRepo.update(pfi.id, updateData);

  // The category is named after the PFI, so a renumbered PFI renames it. It is
  // also created here if missing, which covers rows predating the table.
  if (updated.pfiNumber !== pfi.pfiNumber) {
    const renamed = await pfiExpenseRepo.renameCategoryForPfi(updated.id, updated.pfiNumber);
    if (!renamed) await pfiExpenseRepo.ensureCategoryForPfi(updated.id, updated.pfiNumber);
  }

  res.json({
    success: true,
    message: "PFI updated successfully",
    data: { pfi: await withFinancials(updated) },
  });
});

const deletePfi = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);

  if (!pfi) {
    return res.status(404).json({ success: false, message: "PFI not found" });
  }

  const orderCount = await orderRepo.countByPfi(pfi.id);
  if (orderCount > 0) {
    return res.status(400).json({
      success: false,
      message: `Cannot delete PFI: it is referenced by ${orderCount} order(s)`,
    });
  }

  await pfiRepo.deleteById(pfi.id);

  res.json({ success: true, message: "PFI deleted successfully" });
});

/**
 * Close a batch out.
 *
 * The closure figures are typed in by hand while the system already computes
 * the same quantities from the actual data. We keep both — the manual numbers
 * are what the closing statement was signed against — but the response returns
 * the computed pair alongside so a mismatch is visible at the moment of
 * closing rather than discovered later.
 */
/**
 * Put a batch into trading.
 *
 * The counterpart to /finish, and deliberately as small as that one is large:
 * closing a cargo records what it settled for, whereas starting one asserts a
 * single fact — from now on this batch's stock is stock anyone can sell, and
 * its remaining quantity belongs in the portfolio totals.
 *
 * Its own endpoint rather than a PATCH so the transition is one call with one
 * meaning, and so a batch cannot be un-finished by a field update: a closed
 * cargo has closure figures on it, and reopening it would leave them
 * describing a batch that is trading again.
 */
/**
 * Stage two: assign the bank and the officers, and release the batch to trade.
 *
 * This used to be a one-line status flip. It is the approval now, and it is
 * the only way out of not_started, because everything it asks for is
 * something a trading batch cannot sensibly be without:
 *
 *   a bank account   money arrives somewhere, and a batch whose account
 *                    nobody named is a batch whose inflow cannot be matched
 *   a finance and    somebody answerable for the money and somebody
 *   an audit officer answerable for the count, named before trading rather
 *                    than found afterwards
 *
 * Assigning an officer also grants them sight of the batch — pfi_staff is
 * what scopeCondition reads — so this act is both the approval and the
 * access grant, and they cannot drift apart.
 *
 * A trucking batch's trucks are written here, not at raise time. Until this
 * runs there is no inventory and no ledger entry, so nothing is owed against
 * a batch nobody has approved.
 */
const activatePfi = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");
  if (pfi.status === "active") throw httpErr(409, "This PFI is already active");
  if (pfi.status === "finished") throw httpErr(409, "This PFI is closed and cannot be restarted");

  const bankAccountIds = (req.body.bankAccountIds || [])
    .map(Number)
    .filter(Number.isInteger);
  const officers = req.body.officers || {};
  const auditOfficer = officers.auditOfficerId ?? pfi.auditOfficerId;
  const financeOfficer = officers.salesManagerId ?? pfi.salesManagerId;

  if (!bankAccountIds.length) {
    throw httpErr(400, "Assign at least one bank account before activating this PFI");
  }
  if (!auditOfficer) throw httpErr(400, "Assign an audit officer before activating this PFI");
  if (!financeOfficer) {
    throw httpErr(400, "Assign a finance officer before activating this PFI");
  }

  const updated = await pfiRepo.activate({
    pfiId: pfi.id,
    bankAccountIds,
    officers,
    activatedBy: req.user?.id ?? null,
    note: req.body.note || "",
  });

  res.json({
    success: true,
    message: `${pfi.pfiNumber} is now active`,
    data: { pfi: await withFinancials(updated.pfi), batch: updated.batch },
  });
});

/** The old name, kept so nothing calling it breaks. */
const startPfi = activatePfi;

/**
 * What is still moving on a batch — asked before anybody closes it.
 *
 * Closing takes the batch off the active register, so anything unfinished
 * stops being visible at the moment it stops being actionable. The desk should
 * see the list first, and it needs three separate lists because they need
 * three different people: the loading desk generates the missing tickets,
 * security gates the trucks in, security gates them out.
 */
const getPfiOutstanding = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");
  const outstanding = await pfiRepo.outstandingWork(pfi.id);
  res.json({ success: true, data: { outstanding } });
});

const finishPfi = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");
  if (pfi.status === "finished") throw httpErr(409, "This PFI is already closed");

  /**
   * Refused once, and only once, while work is still outstanding.
   *
   * A hard block would be wrong — the desk closes batches knowing things the
   * system does not, and a rule it cannot get past is a rule it works around
   * by never closing anything. So the first attempt is refused WITH the list,
   * and `acknowledgeOutstanding` lets the same person say "I have seen it,
   * close it anyway". What that buys is that nobody closes a batch without
   * having been shown what they are burying.
   */
  const outstanding = await pfiRepo.outstandingWork(pfi.id);
  const acknowledged = req.body?.acknowledgeOutstanding === true;
  if (!outstanding.clean && !acknowledged) {
    return res.status(409).json({
      success: false,
      code: "OUTSTANDING_WORK",
      message: "This batch still has work on it. Review it, then close again to confirm.",
      data: { outstanding },
    });
  }

  const updateData = { status: "finished", closureDate: parseDate(req.body.closure_date ?? req.body.closureDate) || new Date() };

  const map = {
    total_inflow: "totalInflow",
    closure_bank: "closureBank",
    purchase_cost: "purchaseCost",
    aggregate_expenses: "aggregateExpenses",
    closure_handler: "closureHandler",
    closure_remarks: "closureRemarks",
  };
  for (const [snake, camel] of Object.entries(map)) {
    const value = req.body[snake] !== undefined ? req.body[snake] : req.body[camel];
    if (value !== undefined && value !== null && value !== "") {
      updateData[camel] = ["totalInflow", "purchaseCost", "aggregateExpenses"].includes(camel)
        ? String(Number(value) || 0)
        : value;
    }
  }

  const updated = await withFinancials(await pfiRepo.update(pfi.id, updateData));

  // Nothing reconciles the manual closure figures against the computed ones,
  // so surface the gap instead of leaving two answers to the same question.
  const f = updated.financials;
  const discrepancies = [];
  const compare = (label, typed, computed) => {
    const t = Number(typed);
    if (!Number.isFinite(t) || t === 0 || computed == null) return;
    if (Math.abs(t - computed) >= 0.01) {
      discrepancies.push({ label, entered: t, computed, difference: Number((t - computed).toFixed(2)) });
    }
  };
  compare("Purchase cost", updated.purchaseCost, f.pfiValue);
  compare("Aggregate expenses", updated.aggregateExpenses, f.totalExpenses);

  // Closing with stock still on the books usually means releases were never
  // recorded, not that the product vanished.
  const warnings = [];
  if (f.remaining > 0) {
    warnings.push(
      `${f.remaining.toLocaleString()} L still shows as remaining. Either that stock is genuinely unsold, or movements were never recorded against it.`
    );
  }

  res.json({
    success: true,
    message: "PFI closed",
    data: { pfi: updated, discrepancies, warnings },
  });
});

/** Just the money, for a drawer or a card that does not need the whole record. */
const getPfiSummary = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");

  const decorated = await withFinancials(pfi);
  res.json({
    success: true,
    data: {
      pfiNumber: decorated.pfiNumber,
      status: decorated.status,
      orderCount: decorated.orderCount,
      expenseCount: decorated.expenseCount,
      ...decorated.financials,
    },
  });
});

const getPfiExpenses = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");

  const expenses = await pfiExpenseRepo.listExpensesForPfi(pfi.id);
  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

  res.json({ success: true, data: { expenses, total } });
});

/**
 * Quick-add from inside the PFI drawer.
 *
 * The PFI comes from the URL, so a line added here is indistinguishable from
 * one added on the expenses page — same row, same stamped `pfi_id`, same audit
 * entry. A GL account named in the body is used when there is one; without it
 * the line falls back to this PFI's own category, where every pre-chart row
 * already sits.
 */
const addPfiExpense = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");

  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 0) throw httpErr(400, "Amount must be a positive number");

  const requested = req.body.category_id ?? req.body.categoryId;
  const category = requested
    ? await pfiExpenseRepo.findCategoryById(requested)
    : await pfiExpenseRepo.ensureCategoryForPfi(pfi.id, pfi.pfiNumber);
  if (!category) throw httpErr(400, "Could not resolve this PFI's expense category");

  const { pfiId } = await resolveBooking(category.id, pfi.id);
  const { actorId, actorName } = await actorFor(req);
  const { vendorId, vendorName } = await vendorFor(req.body);

  const expense = await pfiExpenseRepo.createExpense({
    pfi_id: pfiId,
    category_id: category.id,
    expense_date:
      parseDate(req.body.expense_date ?? req.body.expenseDate)?.toISOString?.() ||
      new Date().toISOString(),
    vendor: vendorName,
    vendor_id: vendorId,
    description: req.body.description || "",
    amount: String(amount),
    bank_paid_from: req.body.bank_paid_from ?? req.body.bankPaidFrom ?? "",
    entered_by: actorName,
    recorded_by: actorId,
  });

  await pfiExpenseRepo.writeAudit({
    expenseId: expense.id,
    action: "create",
    changes: expense,
    actorId,
    actorName,
  });

  res.status(201).json({ success: true, message: "Expense recorded", data: { expense } });
});

/** Stock position across every PFI, for the allocation view. */
const getStockSummary = asyncHandler(async (req, res) => {
  const { status = "active" } = req.query;
  const result = await pfiRepo.findAll({ status: status === "all" ? undefined : status, limit: 200 });
  const decorated = await withFinancials(result.pfis || []);

  const rows = decorated.map((p) => ({
    id: p.id,
    pfiNumber: p.pfiNumber,
    status: p.status,
    locationName: p.locationName,
    productName: p.productName,
    tankQtyLitres: p.financials.tankQtyLitres,
    blQtyLitres: p.financials.blQtyLitres,
    surplusDeficitLitres: p.financials.surplusDeficitLitres,
    sold: p.financials.sold,
    remaining: p.financials.remaining,
    sellThrough: p.financials.sellThrough,
  }));

  res.json({
    success: true,
    data: {
      stock: rows,
      totals: {
        tank: rows.reduce((s, r) => s + r.tankQtyLitres, 0),
        sold: rows.reduce((s, r) => s + r.sold, 0),
        remaining: rows.reduce((s, r) => s + r.remaining, 0),
      },
    },
  });
});

/**
 * Bulk-assign orders to a PFI.
 *
 * Each order is checked independently and reported on independently — one bad
 * order in a batch of forty must not cost you the other thirty-nine.
 *
 * ── Why this does more than set orders.pfi_id ──────────────────────────────
 *
 * It used to do exactly that, and nothing else:
 *
 *     await orderRepo.update(orderId, { pfiId: Number(pfi.id) });
 *
 * `pfis.sold_qty_litres` is not derived — it is a counter that only
 * reserveStock raises and only releaseStock lowers. So a bulk assignment moved
 * an order's litres in the orders table while leaving the reservation behind
 * on the batch the order came from and never adding it to the batch it went
 * to. Both batches ended up wrong, in opposite directions, and nothing said
 * so.
 *
 * That is the whole of the drift found on 38 of 47 batches: the Create Order
 * page reads `starting_qty_litres - sold_qty_litres`, so a batch that had
 * orders assigned INTO it offered litres it had already sold (PFI 42 was
 * offering 2.79M litres that were gone), while one assigned OUT of held litres
 * nobody could buy (PFI 45, 270,000). See
 * scripts/reconcile-pfi-stock-counters.js, which repairs the arithmetic this
 * function was getting wrong.
 *
 * So an assignment now does what the other two paths that move an order
 * between batches already did — updateOrder's PFI branch in
 * services/order.service.js, and scripts/move-orders-to-pfi.js:
 *
 *   release the old batch's reservation   so it stops holding sold litres
 *   reserve on the new batch              so it stops offering them
 *   rewrite order_pfi_allocations         the per-order record of both
 *   repoint pfi_movements                 tickets follow the order
 *   markFinishedIfComplete                a batch that is now sold out says so
 *
 * All of it inside one transaction per order, so an order cannot end up
 * pointing at a batch that never reserved for it — which is the exact state
 * this function used to create on purpose.
 *
 * ── When the destination has not got the litres ────────────────────────────
 *
 * reserveStock refuses rather than overselling, and that refusal is reported
 * against the order instead of being swallowed. This is a real behaviour
 * change: assignments that used to "succeed" while quietly overselling a batch
 * now fail and say why. scripts/move-orders-to-pfi.js remains the deliberate
 * override for a correction that has to land regardless.
 */
const assignOrdersToPfi = asyncHandler(async (req, res) => {
  const pfiId = req.body.pfi_id ?? req.body.pfiId;
  const orderIds = Array.isArray(req.body.order_ids ?? req.body.orderIds)
    ? req.body.order_ids ?? req.body.orderIds
    : [];

  if (!pfiId) throw httpErr(400, "A PFI is required");
  if (orderIds.length === 0) throw httpErr(400, "Select at least one order");

  const pfi = await pfiRepo.findById(pfiId);
  if (!pfi) throw httpErr(404, "PFI not found");
  // A finished batch has been closed out; assigning to it would move figures
  // that have already been reported.
  if (pfi.status !== "active") throw httpErr(400, "This PFI is not active");

  const allowed = new Set(
    [pfi.locationId, ...(Array.isArray(pfi.allowedLocations) ? pfi.allowedLocations : [])]
      .filter((v) => v != null)
      .map(Number)
  );

  const assigned = [];
  const errors = [];

  for (const rawId of orderIds) {
    const orderId = Number(rawId);
    try {
      const order = await orderRepo.findById(orderId);
      if (!order) {
        errors.push({ orderId: rawId, error: "Order not found" });
        continue;
      }
      // The depot must be one the batch can serve.
      if (allowed.size > 0 && !allowed.has(Number(order.depotId))) {
        errors.push({
          orderId: rawId,
          orderNumber: order.orderNumber,
          error: `Order is at a location this PFI does not cover`,
        });
        continue;
      }
      // A PFI is one product. An order carrying anything else cannot belong
      // to it, and a multi-product order can never belong to one at all.
      if (pfi.productId && Number(order.productId) !== Number(pfi.productId)) {
        errors.push({
          orderId: rawId,
          orderNumber: order.orderNumber,
          error: `Order product does not match this PFI's product (${pfi.productName})`,
        });
        continue;
      }
      if (order.pfiId && Number(order.pfiId) === Number(pfi.id)) {
        assigned.push({ orderId, orderNumber: order.orderNumber, alreadyAssigned: true });
        continue;
      }

      const fromPfiId = order.pfiId == null ? null : Number(order.pfiId);

      await db.transaction(async (tx) => {
        // Give back whatever the order currently holds, wherever it holds it.
        // Allocation rows are the per-PFI record; an order predating them (or
        // one a previous bulk assign left without any) falls back to its own
        // quantity against the PFI it points at.
        if (fromPfiId != null) {
          const allocations = await orderPfiAllocationRepo.findByOrderId(orderId, tx);
          if (allocations.length > 0) {
            for (const alloc of allocations) {
              await pfiRepo.releaseStock(alloc.pfiId, alloc.quantity, tx);
            }
            await orderPfiAllocationRepo.deleteByOrderId(orderId, tx);
          } else {
            await pfiRepo.releaseStock(fromPfiId, order.quantity, tx);
          }
        }

        const reserved = await pfiRepo.reserveStock(pfi.id, order.quantity, tx);
        if (!reserved) {
          // Rolls back the releases above — the order keeps the batch it had
          // rather than being left holding nothing anywhere.
          throw httpErr(
            400,
            `${pfi.pfiNumber} has not got ${Number(order.quantity).toLocaleString("en-NG")} litres left to give this order`
          );
        }
        await orderPfiAllocationRepo.create([{ pfiId: pfi.id, quantity: order.quantity }], orderId, tx);

        // A ticket already cut for this order recorded its litres against
        // whichever batch was current then. The tickets move with the order,
        // or the two disagree about where the product came from.
        await tx.update(pfiMovements).set({ pfiId: pfi.id }).where(eq(pfiMovements.orderId, orderId));

        await orderRepo.update(orderId, { pfiId: Number(pfi.id) }, tx);
        await pfiRepo.markFinishedIfComplete(pfi.id, tx);
      });

      assigned.push({ orderId, orderNumber: order.orderNumber, movedFrom: fromPfiId });
    } catch (err) {
      errors.push({ orderId: rawId, error: err.message || "Could not assign this order" });
    }
  }

  res.json({
    success: errors.length === 0,
    message:
      errors.length === 0
        ? `${assigned.length} order(s) assigned to ${pfi.pfiNumber}`
        : `${assigned.length} assigned, ${errors.length} could not be`,
    data: { assigned, errors, pfi: await withFinancials(await pfiRepo.findById(pfi.id)) },
  });
});

/**
 * The depots that may sell from a batch.
 *
 * Empty is a real and common answer — a coastal cargo is sold out of the
 * depot it landed at and has no list at all — so this returns [] rather than
 * 404ing on a batch that simply is not a delivery allocation.
 */
const getPfiLocations = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");
  res.json({ success: true, data: { locations: await pfiRepo.allowedDepots(pfi.id) } });
});

const setPfiLocations = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");

  const ids = req.body.depotIds ?? req.body.depot_ids ?? req.body.allowedDepotIds ?? [];
  await pfiRepo.setAllowedDepots(pfi.id, ids, req.user?.id ?? null);
  const locations = await pfiRepo.allowedDepots(pfi.id);

  res.json({
    success: true,
    message: locations.length
      ? `${locations.length} location${locations.length === 1 ? "" : "s"} may sell from ${pfi.pfi_number}`
      : `${pfi.pfi_number} is no longer restricted to particular locations`,
    data: { locations },
  });
});

const getPfiTrucks = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");

  const trucks = await pfiRepo.trucksFor(pfi.id);
  res.json({
    success: true,
    data: {
      trucks,
      // Returned rather than left to the client to add up, so the figure on
      // screen and the figure the batch carries cannot drift apart.
      loadedTotal: trucks.reduce((sum, t) => sum + Number(t.loadedQty || 0), 0),
      capacityTotal: trucks.reduce((sum, t) => sum + Number(t.capacity || 0), 0),
    },
  });
});

/**
 * Replace the manifest. The batch's quantity follows from it.
 *
 * See pfiRepo.setTrucks: the recompute happens in the same transaction, so a
 * saved manifest and the batch quantity can never disagree.
 */
const setPfiTrucks = asyncHandler(async (req, res) => {
  const pfi = await pfiRepo.findById(req.params.id);
  if (!pfi) throw httpErr(404, "PFI not found");

  const result = await pfiRepo.setTrucks(pfi.id, req.body.trucks || [], req.user?.id ?? null);
  const trucks = await pfiRepo.trucksFor(pfi.id);

  res.json({
    success: true,
    message: `${result.trucks} truck${result.trucks === 1 ? "" : "s"} on ${pfi.pfi_number} — ${result.quantity.toLocaleString()} loaded`,
    data: { trucks, quantity: result.quantity },
  });
});

module.exports = {
  getPfiLocations,
  setPfiLocations,
  getPfiTrucks,
  setPfiTrucks,
  getPfis,
  getPfiById,
  createPfi,
  updatePfi,
  deletePfi,
  startPfi,
  activatePfi,
  finishPfi,
  getPfiOutstanding,
  getPfiSummary,
  getPfiExpenses,
  addPfiExpense,
  getStockSummary,
  assignOrdersToPfi,
};
