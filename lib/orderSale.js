const { PREFIX } = require("./allocationOrders");

/**
 * A SALE: an order money has landed on — paid in full, or part paid.
 *
 * Once the first naira arrives the litres are the customer's: out of the
 * stock, never "awaiting payment", and in sales value at the order's full
 * value (what is still owed is the PFI's amount owed). The finance report's
 * own default view — money received — is exactly this set, so every PFI
 * figure built on it (PFI tracking, My PFIs, the CFO report, the daily
 * reports) agrees with the finance report's Total Quantity and Sales Value by
 * construction. One rule, everywhere (2026-10-13). Until then a sale was paid
 * in full only, and part-paid litres read as stock awaiting payment.
 *
 * Plain SQL text over a table alias, like lib/allocationOrders' transferSql,
 * so postgres.js (`client.unsafe(...)`) and drizzle (`sql.raw(...)`) build
 * from the same words.
 */
const saleSql = (alias = "o") =>
  `(${alias}.payment_status = 'Paid' OR (${alias}.payment_status = 'Part Paid'` +
  ` AND COALESCE(${alias}.status::text, '') NOT IN ('Cancelled', 'Expired')))`;

/**
 * A DEPOT SALE: a sale (above) that is not a truck allocation's order.
 *
 * An allocation's order is trucking on its cargo whether or not money has
 * landed on it (lib/allocationOrders), so every PFI stock and sales figure —
 * PFI tracking, My PFIs, the CFO report, the daily reports — reads depot sales
 * from this and trucking from transferSql, and the two never share an order.
 * Without the second half, paying an allocation's order would count its
 * litres twice: once as a depot sale and once as trucking.
 *
 * saleSql itself is unchanged, for the readers that are about the order
 * rather than the cargo's stock (the books, a customer's statement).
 */
const depotSaleSql = (alias = "o") =>
  `(${saleSql(alias)} AND COALESCE(${alias}.idempotency_key, '') NOT LIKE '${PREFIX}%')`;

module.exports = { saleSql, depotSaleSql };
