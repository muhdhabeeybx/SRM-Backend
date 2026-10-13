/**
 * A delivery order's delivery charge — the owner's rule of 13 Oct 2026
 * (migration 0078).
 *
 * The desk enters a rate per litre; the charge is the rate times the litres,
 * and the order's total is the product (quantity x price) plus the charge. The
 * charge is money the customer owes, so it is inside total_amount, but it is
 * not product sales: every revenue and sales-value figure takes it back out.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The charge for this rate on this many litres. */
const deliveryFeeFor = (rate, quantity) => round2(Number(rate || 0) * Number(quantity || 0));

/**
 * The fee an order carries at this rate and quantity: the rate's share, plus
 * any delivery recorded later out of its surplus (migration 0080), which no
 * rate describes and which must survive a recompute.
 */
const chargedFee = (order, rate, quantity) =>
  round2(deliveryFeeFor(rate, quantity) + Number(order?.deliveryFromSurplus ?? order?.delivery_from_surplus ?? 0));

/** The order's total: the product plus its delivery. */
const orderTotal = ({ price, quantity, deliveryRate = 0 }) =>
  round2(Number(price || 0) * Number(quantity || 0) + deliveryFeeFor(deliveryRate, quantity));

/** The product alone — what the PFI sold. */
const productValue = (order) => round2(Number(order.totalAmount ?? order.total_amount ?? 0) - Number(order.deliveryFee ?? order.delivery_fee ?? 0));

/** A rate as typed: a number of naira, 0 or more, kopecks at most. Null when it is not one. */
const parseRate = (v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

/** For SQL: the product value of an order, aliased or not. */
const PRODUCT_VALUE_SQL = (alias = "") => `(${alias ? `${alias}.` : ""}total_amount - ${alias ? `${alias}.` : ""}delivery_fee)`;

module.exports = { deliveryFeeFor, chargedFee, orderTotal, productValue, parseRate, PRODUCT_VALUE_SQL, round2 };
