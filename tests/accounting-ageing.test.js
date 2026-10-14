require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const { ageing } = require("../services/accounting/ageing.service");
const reports = require("../services/accounting/reports.service");
const { closeDb } = require("./helpers");

/**
 * Ageing (services/accounting/ageing) and the reports that read parties
 * (reports.service: balance sheet, ledger links, product columns).
 *
 *   oldest first  a payment clears the oldest charge; what is left is aged
 *                 from its own day, history before the books at its own date
 *   paid ahead    money paid with nothing charged is shown apart, never as
 *                 a smaller debt — on the ageing and on the balance sheet
 *   payables      a vendor's approved, unpaid bill is aged on the other side
 *   links         a ledger line opens the order it came from
 *   products      the profit and loss in columns per product adds up to the
 *                 whole
 */
const RUN = Date.now();
const AT = "2026-10-31";
const SOURCES = ["order_sale", "order_payment", "expense_bill"];

describe("ageing", () => {
  let owing;
  let ahead;
  let vendorId;
  let expenseId;
  const orders = {};
  const payments = [];
  let accounts;

  before(async () => {
    accounts = Object.fromEntries((await client`
      SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`).map((r) => [r.system_key, Number(r.id)]));
    const productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depotId = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);
    const [bank] = await client`SELECT id FROM bank_accounts ORDER BY id LIMIT 1`;
    const customer = async (n) => Number((await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Ageing ${RUN} ${n}`}, ${`+2348${n}${String(RUN).slice(-8)}`}, 'Active', 'Ageing Test Co') RETURNING id`)[0].id);
    owing = await customer(4);
    ahead = await customer(5);
    const order = async (customerId, day, total, paymentStatus) => Number((await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price, total_amount,
                          delivery_type, company_name, payment_status, status, created_at)
      VALUES (${`AG${RUN}${customerId}${day.replaceAll("-", "")}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, 1000, ${total / 1000}, ${total},
              'pickup', 'Ageing Test Co', ${paymentStatus}, 'Pending', ${`${day}T10:00:00+01:00`}) RETURNING id`)[0].id);
    const payment = async (orderId, day, amount) => payments.push(Number((await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, bank_account_id, depositor, narration, bank_ref)
      VALUES (${orderId}, ${amount}, 'statement', ${`${day}T09:00:00+01:00`}, ${bank.id}, 'Payer', 'ageing test', ${`AG-${RUN}-${payments.length}`})
      RETURNING id`)[0].id));

    // Owed from August (before the books), part paid in October, and a new
    // sale in October.
    orders.august = await order(owing, "2026-08-01", 500_000, "Paid");
    orders.october = await order(owing, "2026-10-05", 1_000_000, "Paid");
    await payment(orders.october, "2026-10-02", 200_000);
    // Paid for an order not yet a sale: money held for them.
    orders.unpaid = await order(ahead, "2026-10-03", 300_000, "Unpaid");
    await payment(orders.unpaid, "2026-10-03", 300_000);

    const [v] = await client`INSERT INTO vendors (name) VALUES (${`Ageing vendor ${RUN}`}) RETURNING id`;
    vendorId = Number(v.id);
    const [cat] = await client`
      SELECT id FROM expense_categories WHERE gl_group = 'general' AND NOT COALESCE(is_refund, false) ORDER BY gl_code LIMIT 1`;
    [{ id: expenseId }] = await client`
      INSERT INTO pfi_expenses (category_id, vendor_id, amount, exchange_rate, description, status, expense_date, admin_approved_at)
      VALUES (${cat.id}, ${vendorId}, 50000, 1, ${`${RUN} ageing`}, 'admin_approved', '2026-10-04T10:00:00+01:00', '2026-10-04T10:00:00+01:00')
      RETURNING id`;

    const r = await run({ only: SOURCES });
    for (const t of SOURCES) assert.deepEqual(r.sources[t].failed, [], t);
  });

  after(async () => {
    const ids = [
      ...Object.values(orders).map((id) => ["order_sale", id]),
      ...payments.map((id) => ["order_payment", id]),
      ...(expenseId ? [["expense_bill", expenseId]] : []),
    ];
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      for (const [type, id] of ids) {
        await tx`DELETE FROM journal_lines WHERE entry_id IN (
                   SELECT id FROM journal_entries WHERE source_type = ${type} AND source_id = ${String(id)})`;
        await tx`DELETE FROM ledger_postings WHERE source_type = ${type} AND source_id = ${String(id)}`;
        await tx`DELETE FROM journal_entries WHERE source_type = ${type} AND source_id = ${String(id)}`;
      }
    });
    await client`DELETE FROM order_payments WHERE id = ANY(${payments}::int[])`;
    await client`DELETE FROM orders WHERE id = ANY(${Object.values(orders)}::int[])`;
    await client`DELETE FROM customers WHERE id IN (${owing}, ${ahead})`;
    if (expenseId) await client`DELETE FROM pfi_expenses WHERE id = ${expenseId}`;
    if (vendorId) await client`DELETE FROM vendors WHERE id = ${vendorId}`;
    await closeDb();
  });

  test("a payment clears the oldest charge; what is left is aged from its own day", async () => {
    const a = await ageing({ side: "receivables", at: AT });
    const row = a.rows.find((r) => r.partyType === "customer" && r.partyId === owing);
    assert.ok(row, "the customer who owes is on the ageing");
    assert.equal(row.owed, 1_300_000);
    // August's ₦500,000 less the ₦200,000 paid, 91 days old; October's sale, 26.
    assert.deepEqual(row.groups, [1_000_000, 0, 0, 300_000]);
    assert.equal(row.paidAhead, 0);
    assert.equal(row.oldestDay, "2026-08-01");
    assert.equal(row.oldestDays, 91);
  });

  test("money paid with nothing charged is paid ahead, not a smaller debt", async () => {
    const a = await ageing({ side: "receivables", at: AT });
    const row = a.rows.find((r) => r.partyType === "customer" && r.partyId === ahead);
    assert.equal(row.owed, 0);
    assert.equal(row.paidAhead, 300_000);
    assert.equal(a.totals.owed, Math.round(a.rows.reduce((t, r) => t + r.owed * 100, 0)) / 100);
  });

  test("a vendor's approved, unpaid bill is aged as what we owe", async () => {
    const a = await ageing({ side: "payables", at: AT });
    const row = a.rows.find((r) => r.partyType === "vendor" && r.partyId === vendorId);
    assert.equal(row.owed, 50_000);
    assert.deepEqual(row.groups, [50_000, 0, 0, 0]);
    assert.equal(row.kind, "Vendor");
    assert.equal(row.accountKey, "vendor_payables");
  });

  test("the balance sheet shows money paid ahead as held for the customer, and still balances", async () => {
    const bs = await reports.balanceSheet({ at: AT });
    assert.equal(bs.difference, 0);
    const held = bs.liabilities.lines.find((l) => l.name === "Paid ahead by depot customers");
    assert.ok(held && held.amount >= 300_000, "paid-ahead money is a liability");
    assert.equal(held.heading, "Paid ahead");
  });

  test("a ledger line opens the order it came from", async () => {
    const ledger = await reports.accountLedger(accounts.customer_receivables, { partyType: "customer", partyId: owing });
    const sale = ledger.lines.find((l) => l.sourceType === "order_sale");
    const paid = ledger.lines.find((l) => l.sourceType === "order_payment");
    assert.deepEqual(sale.link, { kind: "order", id: orders.october });
    assert.deepEqual(paid.link, { kind: "order", id: orders.october });
  });

  test("the profit and loss in a column per product adds up to the whole", async () => {
    const pl = await reports.profitAndLoss({ from: "2026-10-01", to: AT, by: "product" });
    const sum = (f) => Math.round(pl.segments.reduce((t, s) => t + f(s.figures) * 100, 0)) / 100;
    assert.equal(sum((f) => f.sales.total), pl.current.sales.total);
    assert.equal(sum((f) => f.netProfit), pl.current.netProfit);
    assert.ok(pl.segments.every((s) => s.label));
  });
});
