require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const commissionRepo = require("../repositories/commission.repository");
const { closeDb } = require("./helpers");

/**
 * Customer commission as it is really paid (0084): money requested on a 5410
 * expense is handed to a member of staff, who pays each customer's commission
 * out of it until it runs out.
 *
 *   earned     an order's commission is a cost the day the order sold, owed to
 *              its customer; a skipped one is owed to nobody
 *   given      the 5410 expense is money with staff, not a cost
 *   paid       marking it paid clears what the customer is owed and takes it
 *              off the money with staff — unless it went into the customer's
 *              wallet, as before 1 Sep 2026, which no staff member paid
 *   the page   the Commissions page's money-with-staff figures are the books'
 */
const RUN = Date.now();
const SOURCES = ["commission_earned", "commission_paid", "expense_bill"];

describe("customer commission", () => {
  let accounts;
  let pfiId;
  let customerId;
  let vendorId;
  let expenseId;
  let depositId;
  const orders = [];
  const commissions = {};

  const sumFor = async (key, { pfi = null, customer = null } = {}) => {
    const [r] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS b
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ${accounts[key]}
         AND ((e.source_type IN ('commission_earned', 'commission_paid') AND e.source_id = ANY(${Object.values(commissions).map(String)}))
              OR (e.source_type = 'expense_bill' AND e.source_id = ${String(expenseId)}))
         AND (${pfi}::int IS NULL OR l.pfi_id = ${pfi})
         AND (${customer}::int IS NULL OR (l.party_type = 'customer' AND l.party_id = ${customer}))`;
    return Number(r.b);
  };

  before(async () => {
    accounts = Object.fromEntries((await client`
      SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`).map((r) => [r.system_key, Number(r.id)]));
    const productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depotId = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);
    [{ id: pfiId }] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
      VALUES (${`COMM/${RUN}`}, 'coastal', 'active', 100000, 300) RETURNING id`;
    pfiId = Number(pfiId);
    [{ id: customerId }] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Commission ${RUN}`}, ${`+23486${String(RUN).slice(-8)}`}, 'Active', 'Commission Test Co') RETURNING id`;
    customerId = Number(customerId);
    const order = async (n) => {
      const [o] = await client`
        INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, pfi_id, quantity, price, total_amount,
                            delivery_type, company_name, payment_status, status, created_at)
        VALUES (${`CM${RUN}${n}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, ${pfiId}, 1000, 400, 400000,
                'pickup', 'Commission Test Co', 'Paid', 'Pending', '2026-10-05T10:00:00+01:00') RETURNING id`;
      orders.push(Number(o.id));
      return Number(o.id);
    };
    const commission = async (orderId, amount, status, paidAt = null) => Number((await client`
      INSERT INTO commissions (order_id, customer_id, depot_id, product_id, quantity, commission_rate, commission_amount,
                               status, rate_source, paid_at, skip_reason)
      VALUES (${orderId}, ${customerId}, ${depotId}, ${productId}, 1000, ${amount / 1000}, ${amount},
              ${status}, 'depot_product', ${paidAt}, ${status === "skipped" ? "test" : ""}) RETURNING id`)[0].id);
    commissions.owed = await commission(await order(1), 2000, "pending");
    commissions.paid = await commission(await order(2), 3000, "paid", "2026-10-07T12:00:00+01:00");
    commissions.skipped = await commission(await order(3), 500, "skipped");
    commissions.wallet = await commission(await order(4), 700, "paid", "2026-10-08T12:00:00+01:00");
    [{ id: depositId }] = await client`
      INSERT INTO deposits (customer_id, amount, type, reference)
      VALUES (${customerId}, 700, 'credit', ${`COM-${RUN}-${commissions.wallet}`}) RETURNING id`;

    [{ id: vendorId }] = await client`INSERT INTO vendors (name) VALUES (${`Float holder ${RUN}`}) RETURNING id`;
    vendorId = Number(vendorId);
    [{ id: expenseId }] = await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, vendor_id, amount, exchange_rate, description, status, expense_date, admin_approved_at)
      VALUES (${pfiId}, ${accounts.customer_commission}, ${vendorId}, 10000, 1, ${`${RUN} commission money`}, 'admin_approved',
              '2026-10-03T10:00:00+01:00', '2026-10-03T10:00:00+01:00') RETURNING id`;
    expenseId = Number(expenseId);

    const r = await run({ only: SOURCES });
    for (const t of SOURCES) assert.deepEqual(r.sources[t].failed, [], t);
  });

  after(async () => {
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      const mine = tx`
        SELECT id FROM journal_entries
         WHERE (source_type IN ('commission_earned', 'commission_paid') AND source_id = ANY(${Object.values(commissions).map(String)}))
            OR (source_type = 'expense_bill' AND source_id = ${String(expenseId)})`;
      await tx`DELETE FROM journal_lines WHERE entry_id IN (${mine})`;
      await tx`
        DELETE FROM ledger_postings
         WHERE (source_type IN ('commission_earned', 'commission_paid') AND source_id = ANY(${Object.values(commissions).map(String)}))
            OR (source_type = 'expense_bill' AND source_id = ${String(expenseId)})`;
      await tx`DELETE FROM journal_entries WHERE id IN (${mine})`;
    });
    if (depositId) await client`DELETE FROM deposits WHERE id = ${depositId}`;
    await client`DELETE FROM commissions WHERE id = ANY(${Object.values(commissions)}::int[])`;
    await client`DELETE FROM orders WHERE id = ANY(${orders}::int[])`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
    if (expenseId) await client`DELETE FROM pfi_expenses WHERE id = ${expenseId}`;
    if (vendorId) await client`DELETE FROM vendors WHERE id = ${vendorId}`;
    await client`DELETE FROM pfis WHERE id = ${pfiId}`;
    await closeDb();
  });

  test("an order's commission is a cost the day it sold, owed to its customer; a skipped one is not", async () => {
    // ₦2,000 + ₦3,000 + ₦700 earned; the skipped ₦500 is nobody's.
    assert.equal(await sumFor("customer_commission"), 5700);
    const [day] = await client`
      SELECT entry_date::text AS d FROM journal_entries WHERE source_type = 'commission_earned' AND source_id = ${String(commissions.owed)}`;
    assert.equal(day.d, "2026-10-05");
    // Still owed: the pending ₦2,000.
    assert.equal(await sumFor("commissions_payable", { customer: customerId }), -2000);
  });

  test("money requested on 5410 is money with staff, not a cost", async () => {
    const lines = await client`
      SELECT l.account_id, l.debit::numeric AS debit, l.party_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.source_type = 'expense_bill' AND e.source_id = ${String(expenseId)} AND l.debit > 0`;
    assert.deepEqual(lines.map((l) => [Number(l.account_id), Number(l.debit), Number(l.party_id)]), [[accounts.commission_float, 10000, vendorId]]);
  });

  test("paying a commission takes it off the money with staff; one paid into the wallet does not", async () => {
    // ₦10,000 given, ₦3,000 paid out of it; the ₦700 went into the wallet.
    assert.equal(await sumFor("commission_float", { pfi: pfiId }), 7000);
    const [wallet] = await client`
      SELECT l.account_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.source_type = 'commission_paid' AND e.source_id = ${String(commissions.wallet)} AND l.credit > 0`;
    assert.equal(Number(wallet.account_id), accounts.suspense);
  });

  test("the Commissions page's money with staff is what the books hold", async () => {
    const { rows } = await commissionRepo.moneyWithStaff();
    const row = rows.find((r) => r.pfiId === pfiId);
    assert.deepEqual(
      { given: row.given, paidOut: row.paidOut, owed: row.owed, left: row.left, requests: row.requests },
      { given: 10000, paidOut: 3000, owed: 2000, left: 7000, requests: 1 },
    );
    assert.match(row.givenTo, /Float holder/);
    assert.equal(row.left, await sumFor("commission_float", { pfi: pfiId }));
  });
});
