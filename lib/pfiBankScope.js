const { client } = require("../config/db");

/**
 * Which bank accounts a person may touch, and which accounts a PFI collects
 * into — decided here, once, and asked by every path that reads a statement or
 * turns a statement line into a payment.
 *
 * ── The two rules ──────────────────────────────────────────────────────────
 *
 *   1. A PFI collects into its own accounts. Where a PFI has bank accounts
 *      assigned, a statement line from any OTHER account cannot be recorded
 *      against an order on that PFI — by anybody. Money that landed in the
 *      Calabar account is not evidence that a Warri cargo was paid for.
 *
 *   2. A person scoped to a PFI sees that PFI's world and nothing else. Their
 *      bank accounts are the ones assigned to their PFIs; they cannot list,
 *      open, upload to or match against any other account, and they cannot
 *      confirm payment on an order outside their PFIs.
 *
 * Both are enforced on the server. The screens narrow what they offer so
 * nobody is shown a choice that will be refused, but the screens are a
 * convenience; this file is the rule.
 *
 * ── Who counts as PFI-scoped ───────────────────────────────────────────────
 *
 * Exactly who lib/scopeFilter.js narrows by PFI: somebody without
 * can_view_all_locations who holds at least one PFI assignment. A super admin
 * always has can_view_all_locations (staffScope.repository), so is never
 * narrowed. The definition is kept identical on purpose — a person must not be
 * scoped to their PFI's orders but free to roam every bank account, or the
 * other way round.
 *
 * ── Failing closed, deliberately ───────────────────────────────────────────
 *
 * scopeFilter.js returns "no narrowing" for somebody assigned nothing, and
 * that stays true here: no PFI assignment, no restriction. But a PFI-scoped
 * person whose PFIs have no bank account at all gets an empty list, not every
 * account. For a bank account that is the only safe answer — "you may see
 * every account" is exactly the leak this exists to close. It should not
 * arise in practice: a PFI cannot be activated without a bank account
 * (activatePfi), and activation is what assigns its officers.
 */

/** pfi_ids is jsonb and has held both numbers and strings; compare as text. */
const PFI_IDS_ARRAY = `CASE WHEN jsonb_typeof(ba.pfi_ids) = 'array' THEN ba.pfi_ids ELSE '[]'::jsonb END`;

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** The PFIs this person is confined to, or null when they are not confined. */
const scopedPfiIds = (user) => {
  if (!user || user.canViewAllLocations) return null;
  const ids = (user.scope?.pfiIds || []).map(Number).filter(Number.isFinite);
  return ids.length ? ids : null;
};

/**
 * Every bank account this person may see.
 *
 * @returns {Promise<number[] | null>} null means unrestricted.
 */
const allowedBankAccountIds = async (user) => {
  const pfiIds = scopedPfiIds(user);
  if (!pfiIds) return null;
  const rows = await client`
    SELECT ba.id
      FROM bank_accounts ba
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(${client.unsafe(PFI_IDS_ARRAY)}) AS x(pfi_id)
        WHERE x.pfi_id = ANY(${pfiIds.map(String)})
     )`;
  return rows.map((r) => Number(r.id));
};

/**
 * The ACTIVE accounts a PFI collects into. Empty when none is assigned, which
 * means the PFI imposes no restriction — there is nothing to restrict to.
 */
const accountsForPfi = async (pfiId) => {
  if (pfiId == null) return [];
  const rows = await client`
    SELECT ba.id, ba.bank_name, ba.account_number
      FROM bank_accounts ba
     WHERE ba.status = 'Active'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(${client.unsafe(PFI_IDS_ARRAY)}) AS x(pfi_id)
          WHERE x.pfi_id = ${String(pfiId)}
       )
     ORDER BY ba.id`;
  return rows.map((r) => ({ id: Number(r.id), bankName: r.bank_name, accountNumber: r.account_number }));
};

/** Refuse when this person may not touch this account. */
const assertAccountAllowed = async (user, bankAccountId) => {
  const allowed = await allowedBankAccountIds(user);
  if (allowed === null) return;
  if (!allowed.includes(Number(bankAccountId))) {
    throw httpError(403, "That bank account does not belong to your PFI.");
  }
};

/** Refuse when this person is confined to PFIs and this order is not on one. */
const assertOrderInScope = (user, order) => {
  const pfiIds = scopedPfiIds(user);
  if (!pfiIds) return;
  if (order?.pfiId == null || !pfiIds.includes(Number(order.pfiId))) {
    throw httpError(403, "That order is not on your PFI.");
  }
};

/**
 * Rule 1: a statement line may only pay for an order on a PFI through one of
 * that PFI's own accounts.
 *
 * An order with no PFI at all is not restricted — there is no cargo to hold it
 * to, and that is a different thing from a cargo nobody has finished setting
 * up.
 *
 * ── A PFI with no account refuses, rather than allowing everything ─────────
 *
 * This used to return here too, on the reasoning that there was nothing
 * configured to check against. But "no account is assigned" is exactly when
 * the control is most needed: it reads as a rule in force while enforcing
 * nothing, and it fails open — quietly, on the PFIs somebody has not finished
 * setting up. PFI/49 sat in that state with three orders still owing, and any
 * account in the company would have been accepted against them.
 *
 * So it refuses, and the message says what to fix rather than blaming the
 * account the desk picked: the PFI needs an account before its orders can take
 * money. Activation already assigns one (activatePfi), so this is reachable
 * only by a PFI whose accounts were later removed, or one created around that
 * path.
 */
const assertAccountServesOrder = async (order, bankAccountId) => {
  if (order?.pfiId == null) return;
  const accounts = await accountsForPfi(order.pfiId);
  if (!accounts.length) {
    throw httpError(
      409,
      "No bank account is assigned to this order's PFI, so there is nothing it may be paid into. " +
        "Set the PFI's account on the Bank Accounts page, then record the payment.",
    );
  }
  if (accounts.some((a) => a.id === Number(bankAccountId))) return;
  const list = accounts.map((a) => `${a.bankName} ${a.accountNumber}`).join(", ");
  throw httpError(
    409,
    accounts.length === 1
      ? `This order's PFI collects into ${list} only. A payment from another account cannot be recorded against it.`
      : `This order's PFI collects into ${list}. A payment from another account cannot be recorded against it.`,
  );
};

module.exports = {
  scopedPfiIds,
  allowedBankAccountIds,
  accountsForPfi,
  assertAccountAllowed,
  assertOrderInScope,
  assertAccountServesOrder,
};
