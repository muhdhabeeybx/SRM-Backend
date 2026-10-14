const { db } = require("../../db");
const { buildStatement } = require("../../lib/accounting/statement");
const { customerSources } = require("../../lib/accounting/sources/customerOrders");
const { vendorSources } = require("../../lib/accounting/sources/vendorExpenses");

/**
 * Customer and vendor statements: everything done with one party, oldest
 * first, with a running balance. Read straight from the desks' own records —
 * orders and their payments, expenses — so a statement is never a second copy
 * of the money that can fall out of step with the first.
 *
 * Each row says what happened in the desk's words. The amount is signed:
 * positive raises the balance. A customer's balance is what they owe us
 * (negative: money of theirs we hold); a vendor's is what we owe them.
 */

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

const nairaText = (v) =>
  `₦${num(v).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const qtyText = (q, unit) => {
  const u = /lit/i.test(unit || "") || !unit ? "L" : unit;
  return `${num(q).toLocaleString("en-NG", { maximumFractionDigits: 2 })} ${u}`;
};

/** "Union Bank ••7476", or whichever half of it the row has. */
const accountText = (bank, number) => {
  const tail = number ? `••${String(number).slice(-4)}` : "";
  return [bank, tail].filter(Boolean).join(" ");
};

// Same-day order: a charge before what settles it. See lib/accounting/statement.
const ORDER = { sale: 0, surplus_delivery: 1, statement: 2, legacy: 2, transfer_in: 3, transfer_out: 3, wallet_moved: 3, refund: 4 };

function saleRow(s) {
  const what = [s.product, qtyText(s.quantity, s.unit)].filter(Boolean).join(" ");
  const price = s.pricingStatus === "pending" ? "price not set yet" : `at ${nairaText(s.price)}`;
  const delivery = num(s.deliveryFee) > 0 ? ` with ${nairaText(s.deliveryFee)} delivery` : "";
  return {
    id: `sale:${s.orderId}`,
    kind: "sale",
    day: s.day,
    at: s.at,
    order: ORDER.sale,
    orderId: Number(s.orderId),
    orderRef: s.orderRef,
    description: `Order: ${what} ${price}${delivery}`,
    reference: s.pfiNumber || "",
    amount: num(s.amount),
  };
}

function surplusDeliveryRow(d) {
  return {
    id: `surplus_delivery:${d.id}`,
    kind: "surplus_delivery",
    day: d.day,
    at: d.at,
    order: ORDER.surplus_delivery,
    orderId: Number(d.orderId),
    orderRef: d.orderRef,
    description: d.note ? `Surplus kept as delivery charge: ${d.note}` : "Surplus kept as delivery charge",
    reference: "",
    amount: num(d.amount),
  };
}

function paymentRow(p) {
  const account = accountText(p.bankName, p.accountNumber);
  let description;
  switch (p.source) {
    case "statement":
      description = [account ? `Paid into ${account}` : "Bank payment", p.depositor ? `by ${p.depositor}` : ""]
        .filter(Boolean).join(" ");
      break;
    case "legacy":
      description = "Paid before 1 Sep 2026, carried from the wallet";
      break;
    case "transfer_out":
      description = [`Moved to ${p.counterpart || "another order"}`, p.reason].filter(Boolean).join(": ");
      break;
    case "transfer_in":
      description = [`Moved from ${p.counterpart || "another order"}`, p.reason].filter(Boolean).join(": ");
      break;
    case "refund":
      description = account ? `Refund paid from ${account}` : "Refund paid";
      break;
    default:
      description = p.source;
  }
  return {
    id: `payment:${p.id}`,
    kind: p.source === "refund" ? "refund" : p.source?.startsWith("transfer") ? "transfer" : "payment",
    source: p.source,
    day: p.day,
    at: p.at,
    order: ORDER[p.source] ?? 2,
    orderId: Number(p.orderId),
    orderRef: p.orderRef,
    counterpartCustomerId: p.counterpartCustomerId == null ? null : Number(p.counterpartCustomerId),
    description,
    reference: p.bankRef || "",
    // Money in lowers what they owe; a transfer out or a refund (both stored
    // negative) raises it again.
    amount: -num(p.paid),
  };
}

function walletMoveRow(w) {
  return {
    id: `wallet_moved:${w.id}`,
    kind: "transfer",
    source: "wallet_moved",
    day: w.day,
    at: w.at,
    order: ORDER.wallet_moved,
    orderId: Number(w.orderId),
    orderRef: w.orderRef,
    counterpartCustomerId: w.counterpartCustomerId == null ? null : Number(w.counterpartCustomerId),
    description: `Moved to ${w.counterpart || "another order"} before 1 Sep 2026`,
    reference: "",
    amount: num(w.amount),
  };
}

/**
 * @param {number} customerId
 * @param {{from?: string, to?: string, pfiIds?: number[]|null}} opts
 */
async function customerStatement(customerId, { from, to, pfiIds = null } = {}) {
  const src = await customerSources(db, { customerId, pfiIds });

  const counted = src.payments.filter((p) => !p.leftOut);
  const leftOut = (kind) => src.payments
    .filter((p) => p.leftOut === kind)
    .reduce((n, p) => n + num(p.paid), 0);

  const events = [
    ...src.sales.map(saleRow),
    ...src.surplusDeliveries.map(surplusDeliveryRow),
    ...counted.map(paymentRow),
    ...src.walletMoves.map(walletMoveRow),
  ];
  const statement = buildStatement(events, { from, to });

  return {
    period: { from: from || null, to: to || null },
    ...statement,
    /** Orders open with nothing paid yet: not charged until money lands. */
    awaiting: src.awaiting,
    /**
     * Payment rows the finance report still counts that this statement does
     * not, because they are not money — see lib/accounting/sources/customerOrders.
     */
    leftOut: {
      duplicates: leftOut("duplicate"),
      recreated: leftOut("recreated"),
    },
  };
}

function invoiceRow(e) {
  const owed = e.owedNgn == null ? null : num(e.owedNgn);
  const parts = [e.category, e.pfiNumber, e.description].filter(Boolean).join(" · ");
  const unconverted = owed === null
    ? `, ${e.currency} ${num(e.amount).toLocaleString("en-NG", { maximumFractionDigits: 2 })} with no exchange rate yet, so not in the balance`
    : "";
  return {
    id: `invoice:${e.id}`,
    kind: "invoice",
    day: e.owedDay,
    at: e.owedAt,
    order: 0,
    expenseId: Number(e.id),
    expenseRef: e.reference || "",
    description: `Invoice approved: ${parts}${unconverted}`,
    reference: e.invoiceNumber || "",
    amount: owed ?? 0,
    vatKept: num(e.vatKept),
    whtKept: num(e.whtKept),
    unconverted: owed === null,
  };
}

function vendorPaymentRow(e) {
  return {
    id: `paid:${e.id}`,
    kind: "payment",
    day: e.paidDay,
    at: e.paidAt,
    order: 1,
    expenseId: Number(e.id),
    expenseRef: e.reference || "",
    description: e.bankPaidFrom ? `Paid from ${e.bankPaidFrom}` : "Paid",
    reference: e.paymentReference || "",
    amount: -num(e.paidNgn),
  };
}

/**
 * @param {number} vendorId
 * @param {{from?: string, to?: string}} opts
 */
async function vendorStatement(vendorId, { from, to } = {}) {
  const src = await vendorSources(db, { vendorId });

  const events = [
    ...src.approved.map(invoiceRow),
    ...src.approved.filter((e) => e.status === "paid" && e.paidDay).map(vendorPaymentRow),
  ];
  const statement = buildStatement(events, { from, to });

  // Tax kept back on the invoices approved in the period: what goes to FIRS
  // instead of to the vendor.
  const invoices = statement.rows.filter((r) => r.kind === "invoice");
  const sum = (key) => Math.round(invoices.reduce((n, r) => n + num(r[key]), 0) * 100) / 100;

  return {
    period: { from: from || null, to: to || null },
    ...statement,
    taxKept: { vat: sum("vatKept"), wht: sum("whtKept") },
    awaitingApproval: src.awaitingApproval,
    unconverted: src.approved.filter((e) => e.owedNgn == null).length,
  };
}

module.exports = { customerStatement, vendorStatement };
