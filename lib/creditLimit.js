const { client } = require("../config/db");

/**
 * No more product before payment while the last lot is still unsettled.
 *
 * Releasing an order before it is paid for — on credit, or by raising it with
 * no price — is open to any member of staff (the owner's decision). What stops
 * that becoming a running tab is this: a customer holding an earlier credit
 * order that is still unpriced or unpaid after CREDIT_OVERDUE_DAYS cannot be
 * given another until it is settled. A super admin may override, with a
 * reason, and the override is written down.
 *
 * "Earlier credit order" is any order carrying a credit allowance — that is
 * the authorisation, whichever way it was given — that has not been cancelled
 * or expired and is either still awaiting a price or not yet Paid. Its age
 * runs from the authorisation, the moment the risk was taken.
 *
 * An order that never had credit is not counted, however much it owes. Those
 * debts are on the receivables list; this rule is about the trust this
 * feature extends, not about every balance in the book.
 */
const CREDIT_OVERDUE_DAYS = Number(process.env.CREDIT_OVERDUE_DAYS) > 0
  ? Number(process.env.CREDIT_OVERDUE_DAYS)
  : 7;

/** The customer's credit orders past the limit, oldest first. */
async function overdueCreditOrders(customerId, { excludeOrderId = null } = {}) {
  if (!customerId) return [];
  return client`
    SELECT o.id,
           o.order_number            AS "orderNumber",
           o.pricing_status::text    AS "pricingStatus",
           o.payment_status::text    AS "paymentStatus",
           o.credit_authorised_at    AS "creditAuthorisedAt",
           GREATEST(0, EXTRACT(DAY FROM (NOW() - o.credit_authorised_at)))::int AS "daysOutstanding"
      FROM orders o
     WHERE o.customer_id = ${Number(customerId)}
       AND o.credit_qty > 0
       AND o.id <> ${Number(excludeOrderId) || 0}
       AND o.status::text NOT IN ('Cancelled', 'Expired')
       AND (o.pricing_status = 'pending' OR o.payment_status::text <> 'Paid')
       AND o.credit_authorised_at < NOW() - make_interval(days => ${CREDIT_OVERDUE_DAYS})
     ORDER BY o.credit_authorised_at`;
}

const isSuperAdmin = (user) => Array.isArray(user?.roles) && user.roles.includes("super_admin");

/**
 * Whether this customer may be given more before payment.
 *
 * Returns `{ ok: true }`, `{ ok: true, overridden: [...] }` when a super admin
 * overrode it with a reason, or `{ ok: false, status, body }` — the 409 to
 * send, naming the orders in the way and saying who can override.
 */
async function checkCreditLimit({ customerId, excludeOrderId, user, override }) {
  const overdue = await overdueCreditOrders(customerId, { excludeOrderId });
  if (overdue.length === 0) return { ok: true };

  const reason = String(override?.reason || "").trim();
  if (reason && isSuperAdmin(user)) return { ok: true, overridden: overdue, reason };

  const list = overdue
    .map((o) => `${o.orderNumber} (${o.pricingStatus === "pending" ? "no price yet" : o.paymentStatus.toLowerCase()}, ${o.daysOutstanding} days)`)
    .join(", ");
  return {
    ok: false,
    status: 409,
    body: {
      success: false,
      message:
        `This customer already has product out before payment for more than ${CREDIT_OVERDUE_DAYS} days: ${list}. `
        + (reason
          ? "Only a super admin can override this."
          : "Settle that first, or a super admin can override with a reason."),
      details: {
        code: "CREDIT_LIMIT",
        days: CREDIT_OVERDUE_DAYS,
        orders: overdue,
        canOverride: isSuperAdmin(user),
      },
    },
  };
}

module.exports = { CREDIT_OVERDUE_DAYS, overdueCreditOrders, checkCreditLimit, isSuperAdmin };
