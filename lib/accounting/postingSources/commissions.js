const { sql } = require("drizzle-orm");
const { orderReferenceSql } = require("../../orderReferenceSql");

/**
 * Customer commission in the general ledger, as it is really paid (0084).
 *
 * Money for commissions is requested on an expense (5410) and handed to a
 * member of staff, who pays each customer out of it until it runs out — so
 * the expense is money moved, and the commission is what each order earned
 * (the commissions table, which the commissions desk works).
 *
 *   commission_earned  an order's commission, on the day the order was sold,
 *                      unless the desk skipped it:
 *                        Dr Customer Commission (5410)
 *                        Cr Commissions payable (the customer)
 *   commission_paid    the desk marks it paid, on that day:
 *                        Dr Commissions payable (the customer)
 *                        Cr Commission money with staff (under the order's PFI)
 *                      one credited to the customer's wallet instead, as
 *                      paying did before 1 Sep 2026, came out of no staff
 *                      member's hands: Cr Suspense, as wallet money is.
 *
 * The money handed to staff is booked by expenses.js: a 5410 expense goes to
 * Commission money with staff, not to cost. What is left there, PFI by PFI,
 * is what staff still hold.
 */

const rowsOf = (r) => r.rows ?? r;
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);

const BASE = sql`
  SELECT c.id, c.customer_id, c.commission_amount::numeric AS amount, c.status::text AS status,
         o.pfi_id, o.depot_id, ${orderReferenceSql("o", "cu")} AS ref,
         ${DAY("o.created_at")} AS sold_day, ${DAY("c.paid_at")} AS paid_day,
         EXISTS (SELECT 1 FROM deposits d WHERE d.reference ILIKE 'COM-%-' || c.id) AS to_wallet
    FROM commissions c
    JOIN orders o ON o.id = c.order_id
    LEFT JOIN customers cu ON cu.id = o.customer_id
   WHERE c.status::text <> 'skipped' AND c.commission_amount > 0
`;

const about = (c) => ({
  unit: "depot",
  pfiId: c.pfi_id == null ? null : Number(c.pfi_id),
  location: c.depot_id == null ? null : ["depot", Number(c.depot_id)],
});

async function commissionRows(db, ctx) {
  if (!ctx.commissions) ctx.commissions = rowsOf(await db.execute(BASE));
  return ctx.commissions;
}

async function earned(db, ctx = {}) {
  return (await commissionRows(db, ctx)).map((c) => ({
    id: String(c.id),
    date: c.sold_day,
    ...about(c),
    memo: `Commission earned on ${c.ref}`,
    lines: [
      { key: "customer_commission", debit: num(c.amount) },
      { key: "commissions_payable", credit: num(c.amount), party: ["customer", Number(c.customer_id)] },
    ],
  }));
}

async function paid(db, ctx = {}) {
  return (await commissionRows(db, ctx))
    .filter((c) => c.status === "paid" && c.paid_day)
    .map((c) => ({
      id: String(c.id),
      date: c.paid_day,
      ...about(c),
      memo: c.to_wallet ? `Commission on ${c.ref} credited to the customer's wallet` : `Commission on ${c.ref} paid`,
      lines: [
        { key: "commissions_payable", debit: num(c.amount), party: ["customer", Number(c.customer_id)] },
        c.to_wallet
          ? { key: "suspense", credit: num(c.amount) }
          : { key: "commission_float", credit: num(c.amount), pfiId: c.pfi_id == null ? null : Number(c.pfi_id) },
      ],
    }));
}

module.exports = [
  { type: "commission_earned", load: earned },
  { type: "commission_paid", load: paid },
];
