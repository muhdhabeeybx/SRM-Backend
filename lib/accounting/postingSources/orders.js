const { sql } = require("drizzle-orm");
const { saleSql } = require("../../orderSale");
const { orderReferenceSql } = require("../../orderReferenceSql");
const { duplicateCtes, leftOutSql } = require("../sources/paymentRules");

/**
 * Depot orders in the general ledger: what each order and each naira against
 * it books. The same rules as the customer statement
 * (lib/accounting/sources/customerOrders), read for every customer at once.
 *
 *   order_sale        an order that counts as a sale (lib/orderSale), on the
 *                     day it was placed:
 *                       Dr Customer receivables      its value
 *                       Cr Sales – depot             the product
 *                       Cr Delivery charges          the delivery fee
 *                     and the litres it took off each PFI, which pfis.js
 *                     costs at that PFI's landed cost (pfi_cogs)
 *   order_payment     money in off a bank statement:
 *                       Dr the bank / Cr Customer receivables
 *                     money carried from the wallet before 1 Sep 2026:
 *                       Dr Suspense / Cr Customer receivables
 *                     a refund paid:
 *                       Dr Customer receivables / Cr the bank its withdrawal
 *                       left, once matched (0085) — until then Cr Suspense,
 *                       its bank named
 *   order_transfer    surplus moved between orders: the receiving customer
 *                     credited, the giving one debited — nothing at all when
 *                     both orders are the same customer's.
 *   wallet_move       surplus handed on in the wallet era, behind the finance
 *                     report's guard: Dr the giver / Cr Suspense.
 *   surplus_delivery  surplus kept as a delivery charge (0080):
 *                       Dr Customer receivables / Cr Delivery charges
 *
 * Only a bank statement line ever touches a bank account. Money typed in, or
 * paid out with no statement line yet, goes to Suspense with its bank named,
 * and the statement line clears it when it is matched or imported
 * (postingSources/bankLines).
 */

const rowsOf = (r) => r.rows ?? r;
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);
const customer = (id) => (id == null ? null : ["customer", Number(id)]);
const depot = (id) => (id == null ? null : ["depot", Number(id)]);

async function orderSales(db, ctx = {}) {
  if (ctx.orderSales) return ctx.orderSales;
  const rows = rowsOf(await db.execute(sql`
    SELECT o.id, o.customer_id, ${orderReferenceSql("o", "c")} AS ref, ${DAY("o.created_at")} AS day,
           o.total_amount::numeric AS total, COALESCE(o.delivery_fee, 0)::numeric AS delivery_fee,
           COALESCE(o.delivery_from_surplus, 0)::numeric AS dfs, o.quantity, o.pfi_id, o.depot_id,
           pr.name AS product,
           (SELECT json_agg(json_build_object('pfi', a.pfi_id, 'qty', a.quantity))
              FROM order_pfi_allocations a WHERE a.order_id = o.id) AS allocations
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN products pr ON pr.id = o.product_id
     WHERE ${sql.raw(saleSql("o"))}
  `));
  const records = rows.map((o) => {
    const value = num(o.total) - num(o.dfs);
    const delivery = num(o.delivery_fee) - num(o.dfs);
    const party = customer(o.customer_id);
    // Which cargo the litres came off, and at what cost: the order's own
    // split across PFIs where it has one, else its PFI.
    const parts = Array.isArray(o.allocations) && o.allocations.length
      ? o.allocations.map((a) => ({ pfiId: Number(a.pfi), qty: num(a.qty) }))
      : o.pfi_id ? [{ pfiId: Number(o.pfi_id), qty: num(o.quantity) }] : [];
    const product = num(o.total) - num(o.delivery_fee);
    const lines = [
      { key: "customer_receivables", debit: value, party },
      { key: "delivery_charges", credit: delivery },
    ];
    // The product's sale and its cost under each cargo it came off, in
    // proportion to the litres, so a PFI's sales and cost read the same way.
    const litres = parts.reduce((t, p) => t + p.qty, 0);
    if (parts.length && litres > 0) {
      parts.forEach((p) => lines.push({ key: "sales_depot", credit: (product * p.qty) / litres, pfiId: p.pfiId }));
    } else {
      lines.push({ key: "sales_depot", credit: product });
    }
    return {
      id: String(o.id), date: o.day, memo: `Order ${o.ref} sold${o.product ? `: ${o.product}` : ""}`, lines,
      unit: "depot", pfiId: o.pfi_id, location: depot(o.depot_id),
      // What it took out of stock — costed by pfis.js (pfi_cogs) at each
      // PFI's landed cost per litre.
      sold: parts.map((p) => ({ pfiId: p.pfiId, litres: p.qty })),
    };
  });
  ctx.orderSales = records;
  return records;
}

async function orderPayments(db) {
  // Refunds whose withdrawal is on a statement (0085): the bank and the day it left.
  const sent = new Map(rowsOf(await db.execute(sql`
    SELECT k.ref_id, d.bank_account_id, to_char(d.txn_date, 'YYYY-MM-DD') AS day
      FROM bank_line_classifications k JOIN bank_statement_debits d ON d.id = k.line_id
     WHERE k.direction = 'debit' AND k.kind = 'refund'`)).map((r) => [Number(r.ref_id), { bank: Number(r.bank_account_id), day: r.day }]));
  const rows = rowsOf(await db.execute(sql`
    WITH all_orders AS (SELECT id, total_amount::numeric AS total FROM orders),
    ${duplicateCtes("all_orders")}
    SELECT p.id, p.source::text AS source, p.amount::numeric AS amount, p.bank_account_id,
           o.customer_id, o.pfi_id, o.depot_id, ${orderReferenceSql("o", "c")} AS ref,
           ${DAY("CASE WHEN p.source = 'legacy' THEN COALESCE(d.created_at, o.created_at) ELSE COALESCE(p.txn_date, p.created_at) END")} AS day
      FROM order_payments p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN deposits d ON d.id = p.deposit_id
     WHERE p.source IN ('statement', 'legacy', 'refund')
       AND ${leftOutSql("p")} IS NULL
  `));
  return rows.map((p) => {
    const amount = num(p.amount);
    const party = customer(p.customer_id);
    const bank = p.bank_account_id == null ? null : Number(p.bank_account_id);
    let lines;
    let memo;
    if (p.source === "statement") {
      lines = [
        { key: bank ? `bank:${bank}` : "suspense", debit: amount, bankAccountId: bank },
        { key: "customer_receivables", credit: amount, party },
      ];
      memo = `Payment for ${p.ref}`;
    } else if (p.source === "legacy") {
      lines = [
        { key: "suspense", debit: amount },
        { key: "customer_receivables", credit: amount, party },
      ];
      memo = `Payment for ${p.ref}, carried from the wallet`;
    } else {
      // A refund is stored negative: money back to the customer — out of
      // the bank its withdrawal left, once that line is matched to it.
      const out = sent.get(Number(p.id));
      lines = [
        { key: "customer_receivables", debit: -amount, party },
        out
          ? { key: `bank:${out.bank}`, credit: -amount, bankAccountId: out.bank }
          : { key: "suspense", credit: -amount, bankAccountId: bank },
      ];
      memo = `Refund on ${p.ref}`;
      if (out) return { id: String(p.id), date: out.day, memo, lines, unit: "depot", pfiId: p.pfi_id, location: depot(p.depot_id) };
    }
    return { id: String(p.id), date: p.day, memo, lines, unit: "depot", pfiId: p.pfi_id, location: depot(p.depot_id) };
  });
}

async function orderTransfers(db) {
  const rows = rowsOf(await db.execute(sql`
    SELECT t.id, t.amount::numeric AS amount, ${DAY("t.created_at")} AS day,
           f.customer_id AS from_customer, tt.customer_id AS to_customer,
           f.pfi_id AS from_pfi, tt.pfi_id AS to_pfi, f.depot_id AS from_depot, tt.depot_id AS to_depot,
           ${orderReferenceSql("f", "fc")} AS from_ref, ${orderReferenceSql("tt", "tc")} AS to_ref
      FROM order_payment_transfers t
      JOIN orders f ON f.id = t.from_order_id
      LEFT JOIN customers fc ON fc.id = f.customer_id
      JOIN orders tt ON tt.id = t.to_order_id
      LEFT JOIN customers tc ON tc.id = tt.customer_id
     -- Both legs still there: a reversed transfer has none.
     WHERE EXISTS (SELECT 1 FROM order_payments p WHERE p.transfer_id = t.id)
  `));
  return rows.map((t) => ({
    id: String(t.id),
    date: t.day,
    memo: `Surplus moved from ${t.from_ref} to ${t.to_ref}`,
    unit: "depot",
    lines: [
      { key: "customer_receivables", debit: num(t.amount), party: customer(t.from_customer), pfiId: t.from_pfi, location: depot(t.from_depot) },
      { key: "customer_receivables", credit: num(t.amount), party: customer(t.to_customer), pfiId: t.to_pfi, location: depot(t.to_depot) },
    ],
  }));
}

async function walletMoves(db) {
  const rows = rowsOf(await db.execute(sql`
    WITH moved AS (
      SELECT o.id AS order_id, o.customer_id, o.total_amount::numeric AS total,
             dp.id AS deposit_id, dp.created_at AS at, dp.amount::numeric AS amount
        FROM orders o
        JOIN deposits dp
          ON dp.description ~ 'from order #[0-9]+'
         AND (regexp_match(dp.description, 'from order #([0-9]+)'))[1]::int = o.id
       WHERE o.payment_status IN ('Paid', 'Part Paid')
         AND EXISTS (SELECT 1 FROM order_deposit_allocations a
                       JOIN order_payments op ON op.deposit_id = dp.id AND op.order_id = a.order_id AND op.source = 'legacy'
                      WHERE a.deposit_id = dp.id)
    ),
    proven AS (
      SELECT mv.order_id
        FROM moved mv
       GROUP BY mv.order_id, mv.total
      HAVING ROUND((SELECT COALESCE(SUM(op.amount), 0) FROM order_payments op WHERE op.order_id = mv.order_id)
                   - SUM(mv.amount) - mv.total, 2) = 0
    )
    SELECT mv.deposit_id, mv.customer_id, mv.amount, ${DAY("mv.at")} AS day
      FROM moved mv JOIN proven pv ON pv.order_id = mv.order_id
  `));
  return rows.map((w) => ({
    id: String(w.deposit_id),
    date: w.day,
    memo: "Surplus handed on before 1 Sep 2026",
    unit: "depot",
    lines: [
      { key: "customer_receivables", debit: num(w.amount), party: customer(w.customer_id) },
      { key: "suspense", credit: num(w.amount) },
    ],
  }));
}

async function surplusDeliveries(db) {
  const rows = rowsOf(await db.execute(sql`
    SELECT s.id, s.amount::numeric AS amount, o.customer_id, o.pfi_id, o.depot_id, ${orderReferenceSql("o", "c")} AS ref,
           ${DAY("s.created_at")} AS day
      FROM order_surplus_deliveries s
      JOIN orders o ON o.id = s.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE s.voided_at IS NULL AND ${sql.raw(saleSql("o"))}
  `));
  return rows.map((s) => ({
    id: String(s.id),
    date: s.day,
    memo: `Surplus on ${s.ref} kept as its delivery charge`,
    unit: "depot",
    pfiId: s.pfi_id,
    location: depot(s.depot_id),
    lines: [
      { key: "customer_receivables", debit: num(s.amount), party: customer(s.customer_id) },
      { key: "delivery_charges", credit: num(s.amount) },
    ],
  }));
}

module.exports = [
  { type: "order_sale", load: orderSales, sells: true },
  { type: "order_payment", load: orderPayments },
  { type: "order_transfer", load: orderTransfers },
  { type: "wallet_move", load: walletMoves },
  { type: "surplus_delivery", load: surplusDeliveries },
];
