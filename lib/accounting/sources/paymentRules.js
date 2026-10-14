const { sql } = require("drizzle-orm");
const { RESURRECTED_PAYMENT_IDS_SQL } = require("../../../services/orderRefund.service");
const { duplicateCtesText } = require("../../duplicatePayments");

/**
 * Which order_payments rows are not money — one rule, read by the customer
 * statement and the general ledger alike, so the two cannot disagree.
 *
 *   duplicate  the finance report's rule (findCustomerDifferentials): a
 *              `legacy` row beside another payment of the same amount on the
 *              same order — a transfer_in, or the bank line that replaced it
 *              at cutover — counted only where dropping every such row lands
 *              an overpaid order exactly on its value, which proves they were
 *              the same money. On order 9437 it is a ₦53,145,000 legacy row
 *              beside the ₦53,145,000 statement line; the narrower
 *              DUPLICATE_LEGACY_IDS_SQL keeps both and reads it ₦53.1m over.
 *   recreated  a payment somebody removed that migration 0021 wrote back
 *              (orderRefund.service RESURRECTED_PAYMENT_IDS_SQL).
 *
 * The rows stay where they are: the finance report is audited against them.
 */

/**
 * `cand` and `dup` CTEs over a relation of orders with columns (id, total) —
 * a customer's own (`mine`) or every order. The rule itself lives in
 * lib/duplicatePayments, which the refund desk reads too.
 */
const duplicateCtes = (ordersRel) => sql.raw(duplicateCtesText(ordersRel));

/** 'duplicate' | 'recreated' | null for payment alias `p`, given the CTEs above. */
const leftOutSql = (alias = "p") => sql`
  CASE WHEN ${sql.raw(alias)}.id IN (SELECT id FROM dup) THEN 'duplicate'
       WHEN ${sql.raw(alias)}.id IN (${sql.raw(RESURRECTED_PAYMENT_IDS_SQL)}) THEN 'recreated' END`;

module.exports = { duplicateCtes, leftOutSql };
