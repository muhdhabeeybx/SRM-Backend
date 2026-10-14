require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { run, normalize, difference } = require("../services/accounting/posting.service");
const { closeDb } = require("./helpers");

/**
 * The posting engine (services/accounting/posting.service.js).
 *
 *   booked      a sale and its payment book balanced entries on their days
 *   idempotent  a second run books nothing
 *   changed     a repriced order books only the difference
 *   gone        a removed payment is taken back
 *   opening     a record from before the books started books nothing
 *   late        a change landing in a closed month goes on the first open
 *               day, marked late, with its own day kept
 */
const RUN = Date.now();
const ONLY = ["order_sale", "order_payment"];

describe("the posting engine", () => {
  let customerId;
  let orderId;
  let oldOrderId;
  let paymentId;
  let accounts;

  const entriesFor = (type, id) => client`
    SELECT e.id, e.entry_date::text AS day, e.kind, e.is_late, e.original_date::text AS original
      FROM journal_entries e WHERE e.source_type = ${type} AND e.source_id = ${String(id)} ORDER BY e.id`;
  const balanceOf = async (key, type, id) => {
    const [r] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS b
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ${accounts[key]} AND e.source_type = ${type} AND e.source_id = ${String(id)}`;
    return Number(r.b);
  };

  before(async () => {
    accounts = Object.fromEntries((await client`
      SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`).map((r) => [r.system_key, Number(r.id)]));
    const productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depotId = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);
    const [bank] = await client`SELECT id FROM bank_accounts ORDER BY id LIMIT 1`;
    const [c] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Ledger ${RUN}`}, ${`+23482${String(RUN).slice(-8)}`}, 'Active', 'Ledger Test Co') RETURNING id`;
    customerId = Number(c.id);
    const order = async (day, total) => Number((await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price, total_amount,
                          delivery_type, company_name, payment_status, status, created_at)
      VALUES (${`LG${RUN}${day}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, 1000, ${total / 1000}, ${total},
              'pickup', 'Ledger Test Co', 'Paid', 'Pending', ${`${day}T10:00:00+01:00`}) RETURNING id`)[0].id);
    orderId = await order("2026-10-05", 1_000_000);
    oldOrderId = await order("2026-09-20", 500_000);
    const [p] = await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, bank_account_id, depositor, narration, bank_ref)
      VALUES (${orderId}, 1000000, 'statement', '2026-10-05T00:00:00Z', ${bank.id}, 'Payer', 'ledger test', ${`LG-${RUN}`})
      RETURNING id`;
    paymentId = Number(p.id);
    await client`DELETE FROM accounting_periods WHERE period IN ('2026-10', '2026-11')`;
  });

  after(async () => {
    await client`DELETE FROM accounting_periods WHERE period IN ('2026-10', '2026-11')`;
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      const ids = [String(orderId), String(oldOrderId), String(paymentId)];
      await tx`DELETE FROM journal_lines WHERE entry_id IN (
                 SELECT id FROM journal_entries WHERE source_type = ANY(${ONLY}) AND source_id = ANY(${ids}))`;
      await tx`DELETE FROM ledger_postings WHERE source_type = ANY(${ONLY}) AND source_id = ANY(${ids})`;
      await tx`DELETE FROM journal_entries WHERE source_type = ANY(${ONLY}) AND source_id = ANY(${ids})`;
    });
    await client`DELETE FROM order_payments WHERE order_id IN (${orderId}, ${oldOrderId})`;
    await client`DELETE FROM orders WHERE id IN (${orderId}, ${oldOrderId})`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
    await closeDb();
  });

  test("lines that do not balance are refused before anything is written", () => {
    assert.throws(
      () => normalize({ id: "x", date: "2026-10-01", lines: [{ key: "a", debit: 10 }, { key: "b", credit: 9 }] }, (k) => k),
      /do not balance/,
    );
    const delta = difference([{ d: "2026-10-01", a: 1, k: 500 }], [{ d: "2026-10-01", a: 1, k: 800 }]);
    assert.deepEqual(delta.map((l) => l.k), [300]);
  });

  test("a record from before the books started books only a change in its money, never a new tag", () => {
    const before = [{ d: "2026-09-20", a: 1, k: 500, u: null }, { d: "2026-09-20", a: 2, k: -500, u: null }];
    const retagged = before.map((l) => ({ ...l, u: "depot", f: 9 }));
    assert.deepEqual(difference(before, retagged, "2026-10-01"), []);
    // After the books started, the same re-tag moves the line between units.
    const late = before.map((l) => ({ ...l, d: "2026-10-05" }));
    assert.equal(difference(late, late.map((l) => ({ ...l, u: "depot" })), "2026-10-01").length, 4);
    // A real change to an opening record is booked, under its tags as they stand.
    const repriced = [{ d: "2026-09-20", a: 1, k: 700, u: "depot" }, { d: "2026-09-20", a: 2, k: -700, u: "depot" }];
    const delta = difference(before, repriced, "2026-10-01");
    assert.deepEqual(delta.map((l) => [l.a, l.k, l.u]), [[1, 200, "depot"], [2, -200, "depot"]]);
  });

  test("books a sale and its payment, balanced, on their own days", async () => {
    const r = await run({ only: ONLY });
    assert.deepEqual(r.sources.order_sale.failed, []);
    const [sale] = await entriesFor("order_sale", orderId);
    assert.equal(sale.day, "2026-10-05");
    assert.equal(await balanceOf("customer_receivables", "order_sale", orderId), 1_000_000);
    assert.equal(await balanceOf("sales_depot", "order_sale", orderId), -1_000_000);
    assert.equal(await balanceOf("customer_receivables", "order_payment", paymentId), -1_000_000);
  });

  test("a record from before the books started is carried by the opening balance, not booked", async () => {
    assert.equal((await entriesFor("order_sale", oldOrderId)).length, 0);
    const [noted] = await client`SELECT lines FROM ledger_postings WHERE source_type = 'order_sale' AND source_id = ${String(oldOrderId)}`;
    assert.ok(noted && noted.lines.length > 0);
  });

  test("a second run books nothing", async () => {
    const before = (await entriesFor("order_sale", orderId)).length;
    await run({ only: ONLY });
    assert.equal((await entriesFor("order_sale", orderId)).length, before);
  });

  test("a repriced order books only the difference; a removed payment is taken back", async () => {
    await client`UPDATE orders SET total_amount = 1200000, price = 1200 WHERE id = ${orderId}`;
    await client`DELETE FROM order_payments WHERE id = ${paymentId}`;
    await run({ only: ONLY });
    const sale = await entriesFor("order_sale", orderId);
    assert.equal(sale.length, 2);
    assert.equal(sale[1].kind, "adjustment");
    assert.equal(await balanceOf("customer_receivables", "order_sale", orderId), 1_200_000);
    assert.equal(await balanceOf("customer_receivables", "order_payment", paymentId), 0);
  });

  test("a change that lands in a closed month goes on the first open day, marked late", async () => {
    await client`INSERT INTO accounting_periods (period, status, closed_at) VALUES ('2026-10', 'closed', now())`;
    await client`UPDATE orders SET total_amount = 1300000, price = 1300 WHERE id = ${orderId}`;
    await run({ only: ["order_sale"] });
    const last = (await entriesFor("order_sale", orderId)).at(-1);
    assert.equal(last.day, "2026-11-01");
    assert.equal(last.is_late, true);
    assert.equal(last.original, "2026-10-05");
    assert.equal(await balanceOf("customer_receivables", "order_sale", orderId), 1_300_000);
    // Once more: still nothing new.
    const n = (await entriesFor("order_sale", orderId)).length;
    await run({ only: ["order_sale"] });
    assert.equal((await entriesFor("order_sale", orderId)).length, n);
  });
});
