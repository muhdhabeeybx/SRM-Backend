const asyncHandler = require("express-async-handler");
const { sql } = require("drizzle-orm");
const { db } = require("../../config/db");
const { bankAccountRepo } = require("../../repositories");
const pfiBankScope = require("../../lib/pfiBankScope");

const getBankAccounts = asyncHandler(async (req, res) => {
  const { search, status, depotId, lpgStationId, usage } = req.query;
  const all = await bankAccountRepo.findAll({ search, status, depotId, lpgStationId, usage });

  /*
    Somebody confined to a PFI sees that PFI's accounts and nothing else — not
    in this list, and so not in any dropdown that reads it. See
    lib/pfiBankScope.js.
  */
  const allowed = await pfiBankScope.allowedBankAccountIds(req.user);
  const accounts = allowed === null ? all : all.filter((a) => allowed.includes(Number(a.id)));

  res.json({
    success: true,
    data: { bankAccounts: accounts, count: accounts.length },
  });
});

const getBankAccountById = asyncHandler(async (req, res) => {
  const account = await bankAccountRepo.findById(req.params.id);

  // Outside this person's PFI reads as not found, not as forbidden: saying
  // "you may not see it" confirms the account exists.
  const allowed = await pfiBankScope.allowedBankAccountIds(req.user);
  if (!account || (allowed !== null && !allowed.includes(Number(account.id)))) {
    return res.status(404).json({ success: false, message: "Bank account not found" });
  }

  res.json({
    success: true,
    data: { bankAccount: account },
  });
});


/**
 * Every location the chosen PFIs can be sold from.
 *
 * depot_ids is no longer picked by hand — a location is what the assigned
 * PFIs imply. Deriving it on every save keeps everything still reading it (the
 * subaccount lookup, staff scope, the accounts list) working, and makes it
 * impossible for the two to disagree.
 *
 * ── Where a batch is sold, not where it sits ──────────────────────────────
 *
 * This read `location_id` alone, which is the whole answer for a coastal or
 * gantry batch: it is sold out of the depot it sits in. A delivery batch is
 * loaded at one depot precisely so it can be sold at others, and the account
 * the customer pays into is resolved by depot (order.service's
 * findAll({ depotId })) — so an account assigned to a delivery batch covered
 * only the depot it loaded at, and an order placed at any location on that
 * batch's allowlist found no payment account and was refused.
 *
 * UNION, not two lists appended: a batch may be lent to the depot it was
 * loaded at, and depot_ids is a set.
 */
async function depotsForPfis(pfiIds) {
  const ids = (Array.isArray(pfiIds) ? pfiIds : []).map(Number).filter((n) => !Number.isNaN(n));
  if (!ids.length) return { pfiIds: [], depotIds: [] };
  // An IN list built with sql.join, not ANY($1): drizzle binds a JS array as
  // one parameter per element, so `ANY(${ids})` compiles to ANY(($1)) with a
  // scalar and the query fails outright.
  const idList = sql`(${sql.join(ids.map((n) => sql`${n}`), sql`, `)})`;
  const result = await db.execute(sql`
    SELECT DISTINCT reach.depot_id AS "depotId"
      FROM (
             SELECT location_id AS depot_id FROM pfis
              WHERE id IN ${idList} AND location_id IS NOT NULL
             UNION
             SELECT depot_id FROM pfi_allowed_locations
              WHERE pfi_id IN ${idList}
           ) reach
  `);
  const rows = result.rows ?? result;
  const depotIds = [...new Set(rows.map((r) => Number(r.depotId)).filter((v) => !Number.isNaN(v)))];
  return { pfiIds: ids, depotIds };
}

const createBankAccount = asyncHandler(async (req, res) => {
  const { bankName, accountName, accountNumber, bankCode, branchName, currency, status, isDefault, pfiIds, lpgStationIds, usage, notes } = req.body;

  if (!bankName || !accountName || !accountNumber) {
    return res.status(400).json({
      success: false,
      message: "Bank name, account name, and account number are required",
    });
  }

  const scoped = await depotsForPfis(pfiIds);

  const account = await bankAccountRepo.create({
    bankName: bankName.trim(),
    accountName: accountName.trim(),
    accountNumber: accountNumber.trim(),
    bankCode: bankCode ? bankCode.trim() : "",
    branchName: branchName ? branchName.trim() : "",
    currency: currency || "NGN",
    status: status || "Active",
    isDefault: Boolean(isDefault),
    pfiIds: scoped.pfiIds,
    depotIds: scoped.depotIds,
    lpgStationIds: Array.isArray(lpgStationIds) ? lpgStationIds : [],
    usage: Array.isArray(usage) ? usage : [],
    notes: notes || "",
  });

  res.status(201).json({
    success: true,
    message: "Bank account created successfully",
    data: { bankAccount: account },
  });
});

const updateBankAccount = asyncHandler(async (req, res) => {
  const account = await bankAccountRepo.findById(req.params.id);

  // An account outside this person's PFI does not exist, as far as they know.
  const allowed = await pfiBankScope.allowedBankAccountIds(req.user);
  if (!account || (allowed !== null && !allowed.includes(Number(account.id)))) {
    return res.status(404).json({ success: false, message: "Bank account not found" });
  }

  // Same rule as create: the locations follow the PFIs. Only recomputed when
  // pfiIds is actually part of the update, so a patch changing only the bank
  // name does not silently clear the assignment.
  const patch = { ...req.body };
  if (patch.pfiIds !== undefined) {
    const scoped = await depotsForPfis(patch.pfiIds);
    patch.pfiIds = scoped.pfiIds;
    patch.depotIds = scoped.depotIds;
  }

  const updatedAccount = await bankAccountRepo.update(req.params.id, patch);

  res.json({
    success: true,
    message: "Bank account updated successfully",
    data: { bankAccount: updatedAccount },
  });
});

const deleteBankAccount = asyncHandler(async (req, res) => {
  const account = await bankAccountRepo.findById(req.params.id);

  // An account outside this person's PFI does not exist, as far as they know.
  const allowed = await pfiBankScope.allowedBankAccountIds(req.user);
  if (!account || (allowed !== null && !allowed.includes(Number(account.id)))) {
    return res.status(404).json({ success: false, message: "Bank account not found" });
  }

  await bankAccountRepo.delete(req.params.id);

  res.json({
    success: true,
    message: "Bank account deleted successfully",
  });
});

module.exports = {
  getBankAccounts,
  getBankAccountById,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
};
