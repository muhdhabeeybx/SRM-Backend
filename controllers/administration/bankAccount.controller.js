const asyncHandler = require("express-async-handler");
const { sql } = require("drizzle-orm");
const { db, client } = require("../../config/db");
const auditLogRepo = require("../../repositories/auditLog.repository");
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

/**
 * How every account is actually doing, in one query per concern.
 *
 * The account list says which PFIs an account is assigned to. It does not say
 * whether any money ever arrived through it, when it last did, or how much of
 * its statement is still unmatched — so an account assigned to twenty-six
 * PFIs and one that has never taken a naira read identically.
 *
 * ── Assigned, and actually used, are different facts ─────────────────────
 *
 * `pfiIds` is the current assignment and it is overwritten when somebody
 * changes it, so there is no record of what an account used to collect for.
 * The payments are that record: a PFI whose orders have been paid into this
 * account has used it, whatever the assignment says today. That answers both
 * "which PFIs is this on" and "which was it on before" without inventing an
 * assignment log, and it cannot drift from the money.
 *
 * Scoped like the list it accompanies: somebody confined to a PFI sees their
 * own accounts' figures and no others.
 */
const getBankAccountActivity = asyncHandler(async (req, res) => {
  const allowed = await pfiBankScope.allowedBankAccountIds(req.user);

  const rollup = await client`
    SELECT b.id,
           (SELECT count(*)::int FROM bank_statements s WHERE s.bank_account_id = b.id) AS uploads,
           (SELECT max(l.txn_date) FROM bank_statement_lines l WHERE l.bank_account_id = b.id) AS last_credit,
           (SELECT count(*)::int FROM bank_statement_lines l
             WHERE l.bank_account_id = b.id AND l.status = 'UNMATCHED') AS unmatched,
           (SELECT coalesce(sum(l.amount), 0)::numeric FROM bank_statement_lines l
             WHERE l.bank_account_id = b.id AND l.status = 'UNMATCHED') AS unmatched_value,
           (SELECT coalesce(sum(op.amount), 0)::numeric FROM order_payments op
             WHERE op.bank_account_id = b.id) AS orders_taken,
           (SELECT count(*)::int FROM order_payments op WHERE op.bank_account_id = b.id) AS order_payments,
           (SELECT coalesce(sum(ds.payment_amount), 0)::numeric FROM delivery_sales ds
             WHERE ds.bank_account_id = b.id) AS truck_taken
      FROM bank_accounts b`;

  // Every PFI that has ever been paid into each account, newest first. One
  // query for all of them rather than one per account.
  const history = await client`
    SELECT op.bank_account_id AS account_id,
           p.id AS pfi_id, p.pfi_number, p.location_name, p.status,
           count(*)::int AS payments,
           coalesce(sum(op.amount), 0)::numeric AS total,
           max(op.created_at) AS last_paid_at
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
      JOIN pfis p ON p.id = o.pfi_id
     WHERE op.bank_account_id IS NOT NULL
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY max(op.created_at) DESC`;

  const byAccount = new Map();
  for (const h of history) {
    const key = Number(h.account_id);
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push({
      pfiId: Number(h.pfi_id),
      pfiNumber: h.pfi_number,
      locationName: h.location_name || "",
      pfiStatus: h.status,
      payments: Number(h.payments),
      total: Number(h.total),
      lastPaidAt: h.last_paid_at,
    });
  }

  const rows = rollup
    .filter((r) => allowed === null || allowed.includes(Number(r.id)))
    .map((r) => ({
      id: Number(r.id),
      uploads: Number(r.uploads),
      lastCredit: r.last_credit ? String(r.last_credit).slice(0, 10) : null,
      unmatched: Number(r.unmatched),
      unmatchedValue: Number(r.unmatched_value),
      ordersTaken: Number(r.orders_taken),
      orderPayments: Number(r.order_payments),
      truckTaken: Number(r.truck_taken),
      /** Every PFI whose orders have been paid into it, whatever it is assigned to now. */
      pfisPaidIn: byAccount.get(Number(r.id)) || [],
    }));

  res.json({ success: true, data: { activity: rows, count: rows.length } });
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

/**
 * PUT /api/bank-accounts/for-pfi/:pfiId   { bankAccountIds: number[] }
 *
 * Set exactly which accounts a PFI collects into — asked the way the question
 * is actually asked.
 *
 * The account form answers the reverse ("which PFIs does this account
 * serve?"), and it hid every PFI already on another account on the rule "one
 * PFI, one account" — a rule the data does not follow: three live PFIs
 * collect into five accounts each, and approving a PFI adds accounts without
 * any limit. So the only screen for the job concealed the true picture.
 *
 * The list sent is the whole answer: accounts named gain the PFI, accounts
 * not named lose it. One transaction, so a failure halfway cannot leave the
 * PFI collecting into some of the old accounts and some of the new. Each
 * account's locations are re-derived from its PFIs exactly as an ordinary
 * edit does, so the two ways of assigning cannot drift apart.
 *
 * Deciding where a PFI's money lands is not something done from inside a
 * PFI's scope, so a person confined to PFIs is refused.
 */
const setAccountsForPfi = asyncHandler(async (req, res) => {
  const pfiId = Number(req.params.pfiId);
  const wanted = [...new Set((req.body.bankAccountIds || []).map(Number).filter(Number.isInteger))];

  if ((await pfiBankScope.allowedBankAccountIds(req.user)) !== null) {
    return res.status(403).json({
      success: false,
      message: "Assigning a PFI's collection accounts is done by finance, not from within a PFI.",
    });
  }

  const [pfi] = await client`SELECT id, pfi_number FROM pfis WHERE id = ${pfiId}`;
  if (!pfi) return res.status(404).json({ success: false, message: "PFI not found" });

  const accounts = await client`
    SELECT id, status, bank_name, account_number,
           CASE WHEN jsonb_typeof(pfi_ids) = 'array' THEN pfi_ids ELSE '[]'::jsonb END AS pfi_ids
      FROM bank_accounts`;
  const byId = new Map(accounts.map((a) => [Number(a.id), a]));

  for (const id of wanted) {
    const a = byId.get(id);
    if (!a) return res.status(400).json({ success: false, message: `Bank account #${id} does not exist.` });
    if (a.status !== "Active") {
      return res.status(400).json({
        success: false,
        message: `${a.bank_name} ${a.account_number} is ${a.status.toLowerCase()} — a PFI cannot collect into it.`,
      });
    }
  }

  // Work out every change before writing any of them.
  const changes = [];
  for (const a of accounts) {
    const id = Number(a.id);
    const current = (a.pfi_ids || []).map(Number).filter((n) => Number.isFinite(n));
    const has = current.includes(pfiId);
    const want = wanted.includes(id);
    if (has === want) continue;
    const next = want ? [...current, pfiId] : current.filter((x) => x !== pfiId);
    const derived = await depotsForPfis(next);
    changes.push({ id, added: want, label: `${a.bank_name} ${a.account_number}`, ...derived });
  }

  await client.begin(async (tx) => {
    for (const c of changes) {
      await tx`
        UPDATE bank_accounts
           SET pfi_ids = ${JSON.stringify(c.pfiIds)}::jsonb,
               depot_ids = ${JSON.stringify(c.depotIds)}::jsonb,
               updated_at = now()
         WHERE id = ${c.id}`;
    }
  });

  const added = changes.filter((c) => c.added).map((c) => c.label);
  const removed = changes.filter((c) => !c.added).map((c) => c.label);
  if (changes.length) {
    await auditLogRepo.record({
      entityType: "pfi",
      entityId: pfiId,
      action: "pfi.bank_accounts_set",
      actor: req.user?.id ? { type: "staff", staffId: req.user.id } : { type: "system" },
      metadata: { added, removed, bankAccountIds: wanted },
    });
  }

  const now = await pfiBankScope.accountsForPfi(pfiId);
  res.json({
    success: true,
    message: changes.length
      ? now.length
        ? `${pfi.pfi_number} now collects into ${now.map((a) => `${a.bankName} ${a.accountNumber}`).join(", ")}.`
        : `${pfi.pfi_number} no longer collects into any account.`
      : "Nothing changed.",
    data: { accounts: now, added, removed },
  });
});

module.exports = {
  getBankAccountActivity,
  setAccountsForPfi,
  getBankAccounts,
  getBankAccountById,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
};
