const { client } = require("../../db");
const gl = require("../glAccounts");

/**
 * The chart of accounts, as the Accounts pages and the general ledger read it.
 *
 * The accounts live in expense_categories (0007, 0081): the cost accounts the
 * expense form books to, and around them the banks, receivables, payables,
 * equity and sales the ledger posts to. The desks call the first kind
 * "categories"; Finance sees all of it here as the chart.
 */

/**
 * Every account, in chart order: by group, then by code. Retired pre-chart
 * categories are left out — they carry old expenses, never new postings.
 */
async function listChart(tx = client) {
  const rows = await tx`
    SELECT c.id, c.gl_code, c.name, c.gl_group, c.gl_subgroup, c.system_key, c.bank_account_id,
           c.cash_flow_class, c.is_refund, c.into_stock, b.status AS bank_status,
           (SELECT COUNT(*)::int FROM pfi_expenses e WHERE e.category_id = c.id AND e.deleted_at IS NULL) AS expense_count
      FROM expense_categories c
      LEFT JOIN bank_accounts b ON b.id = c.bank_account_id
     WHERE c.is_active IS NOT FALSE AND c.gl_group IS NOT NULL
  `;
  const order = new Map(gl.CHART_GROUPS.map((g, i) => [g.code, i]));
  return rows
    .map((r) => {
      const type = gl.accountTypeOf(r.gl_group);
      return {
        id: Number(r.id),
        code: r.gl_code || "",
        name: r.name,
        group: r.gl_group,
        groupLabel: gl.chartGroupFor(r.gl_group)?.label || r.gl_group,
        heading: r.gl_subgroup || "",
        type,
        normalSide: gl.normalSideOf(type),
        systemKey: r.system_key || null,
        bankAccountId: r.bank_account_id == null ? null : Number(r.bank_account_id),
        bankStatus: r.bank_status || null,
        /** operating | investing | financing — where this account sits on the cash flow. */
        cashFlowClass: r.cash_flow_class || "operating",
        /** A cargo cost that goes into the PFI's stock value (0081). */
        intoStock: !!r.into_stock,
        /** Expense lines booked to it — why a cost account cannot be deleted. */
        expenseCount: Number(r.expense_count || 0),
        /** The ledger posts to it by key: it can be renamed, never deleted or moved. */
        isSystem: !!r.system_key,
      };
    })
    .sort((a, b) =>
      (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99) ||
      Number(!a.code) - Number(!b.code) ||
      a.code.localeCompare(b.code, "en", { numeric: true }) ||
      a.name.localeCompare(b.name));
}

/**
 * Give every bank account its own chart account (11xx), where it has none.
 *
 * Migration 0081 did this for the accounts that existed; this does it for
 * every one added since, and is run when a bank account is created and before
 * every posting run, so a payment into a new account always has somewhere to
 * land. The same rule as the migration: numbered on from the highest 11xx
 * code, up to 1199; named bank · account name · last four digits.
 */
async function ensureBankAccounts(tx = client) {
  return tx`
    INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, system_key, bank_account_id, is_system_category)
    SELECT
      left(concat_ws(' · ', NULLIF(btrim(b.bank_name), ''), NULLIF(btrim(b.account_name), ''),
                     '••' || right(regexp_replace(COALESCE(b.account_number, ''), '\\D', '', 'g'), 4))
           || CASE WHEN EXISTS (
                SELECT 1 FROM expense_categories n
                 WHERE n.name = concat_ws(' · ', NULLIF(btrim(b.bank_name), ''), NULLIF(btrim(b.account_name), ''),
                                          '••' || right(regexp_replace(COALESCE(b.account_number, ''), '\\D', '', 'g'), 4))
              ) THEN ' #' || b.id ELSE '' END, 255),
      CASE WHEN base.top + ROW_NUMBER() OVER (ORDER BY b.id) <= 1199
           THEN (base.top + ROW_NUMBER() OVER (ORDER BY b.id))::text END,
      'assets', 'Bank accounts', 'bank:' || b.id, b.id, false
      FROM bank_accounts b
      CROSS JOIN (
        SELECT GREATEST(1100, COALESCE(MAX(gl_code::int), 1100)) AS top
          FROM expense_categories WHERE gl_code ~ '^11[0-9]{2}$'
      ) base
     WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.bank_account_id = b.id)
    RETURNING id, name, gl_code
  `;
}

/**
 * The ids of accounts by key: { stock: 812, 'bank:54': 790, … }. Throws on a
 * missing key, because posting to "wherever" is how books stop balancing.
 */
async function accountIds(keys, tx = client) {
  const rows = await tx`
    SELECT id, system_key FROM expense_categories WHERE system_key = ANY(${keys})
  `;
  const out = Object.fromEntries(rows.map((r) => [r.system_key, Number(r.id)]));
  const missing = keys.filter((k) => !(k in out));
  if (missing.length) {
    throw new Error(`Chart of accounts is missing ${missing.join(", ")} — has migration 0081 run?`);
  }
  return out;
}

module.exports = { listChart, ensureBankAccounts, accountIds };
