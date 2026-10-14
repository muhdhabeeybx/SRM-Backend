// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { matchCredits } = require("../lib/accounting/sources/untracedCredits");
const { customerStatement } = require("../services/accounting/statements.service");
const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * Wallet-era bank credits left off the order they paid.
 *
 *   matching   exact to the kobo or not at all; fewest credits; a credit pays
 *              one order; nothing outside the order's dates
 *   statement  a matched credit is a payment on its order, so a customer who
 *              paid reads square; an order with no exact match still owes
 */
const RUN = Date.now();

describe("matching credits to what an order is missing", () => {
  const at = (day) => `${day}T10:00:00Z`;
  const order = (id, gap, day = "2026-07-13", confirmed = "2026-07-20") =>
    ({ id, customerId: 1, gap, at: at(day), confirmedAt: at(confirmed) });
  const credit = (id, amount, day = "2026-07-13", customerId = 1) => ({ id, customerId, amount, at: at(day) });

  test("a set of credits adding up exactly settles the order", () => {
    const m = matchCredits([order(1, 227355000)], [credit(1, 121240000), credit(2, 56115000), credit(3, 50000000), credit(4, 25326000)]);
    assert.equal(m.length, 1);
    assert.deepEqual(m[0].credits.map((c) => c.id).sort(), [1, 2, 3]);
  });

  test("near enough is not enough: no exact sum, no match", () => {
    assert.equal(matchCredits([order(1, 20125000)], [credit(1, 21072964)]).length, 0);
    assert.equal(matchCredits([order(1, 1000)], [credit(1, 999.99)]).length, 0);
  });

  test("the fewest credits win, and a credit pays one order only", () => {
    const m = matchCredits(
      [order(1, 300, "2026-07-01", "2026-07-02"), order(2, 300, "2026-07-03", "2026-07-04")],
      [credit(1, 100, "2026-07-01"), credit(2, 200, "2026-07-01"), credit(3, 300, "2026-07-01")],
    );
    assert.deepEqual(m.map((x) => [x.order.id, x.credits.map((c) => c.id).sort()]), [[1, [3]], [2, [1, 2]]]);
  });

  test("another customer's credit, or one dated after the order was confirmed, is never used", () => {
    assert.equal(matchCredits([order(1, 500)], [credit(1, 500, "2026-07-13", 2)]).length, 0);
    assert.equal(matchCredits([order(1, 500)], [credit(1, 500, "2026-07-25")]).length, 0);
  });
});

describe("the customer statement reads a matched credit as a payment", () => {
  let customerId;
  let productId;
  let depotId;
  const orderIds = [];
  const depositIds = [];

  const order = async ({ total, paid }) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price,
                          total_amount, amount_paid, delivery_type, company_name, payment_status, status,
                          payment_confirmed_at)
      VALUES (${`UC${RUN}${orderIds.length}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, 1000,
              ${total / 1000}, ${total}, ${paid}, 'pickup', 'Untraced Test Co', 'Paid', 'Completed', now())
      RETURNING id`;
    orderIds.push(Number(o.id));
    return Number(o.id);
  };
  const pay = (orderId, amount) => client`
    INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
    VALUES (${orderId}, ${amount}, 'statement', now(), 'Test Payer', 'untraced test', ${`UC-${RUN}-${orderId}-${amount}`})`;
  const deposit = async (amount, reference = "") => {
    const [d] = await client`
      INSERT INTO deposits (customer_id, amount, type, description, reference)
      VALUES (${customerId}, ${amount}, 'credit', 'From NIP/TEST PAYER', ${reference})
      RETURNING id`;
    depositIds.push(Number(d.id));
  };

  before(async () => {
    productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    depotId = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);
    const [c] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Untraced ${RUN}`}, ${`+23482${String(RUN).slice(-8)}`}, 'Active', 'Untraced Test Co')
      RETURNING id`;
    customerId = Number(c.id);

    // Paid 1,000,000, only 600,000 of it on the order; 250,000 + 150,000 left
    // in the deposits. A commission credit of 400,000 would also fit: never used.
    const square = await order({ total: 1000000, paid: 1000000 });
    await pay(square, 600000);
    await deposit(400000, `COM-${RUN}`);
    await deposit(250000);
    await deposit(150000);
    // Paid 500,000 with 300,000 on the order and a credit that does not fit.
    const short = await order({ total: 500000, paid: 500000 });
    await pay(short, 300000);
    await deposit(150001);
  });

  after(async () => {
    await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds}::int[])`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds}::int[])`;
    await client`DELETE FROM deposits WHERE id = ANY(${depositIds}::int[])`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
  });

  test("the order the credits fit reads paid; the one they do not still owes", async () => {
    const s = await customerStatement(customerId);
    // 1,500,000 sold; 600,000 + 300,000 on the orders + 400,000 matched.
    assert.equal(s.closing, 200000);
    const matched = s.rows.filter((r) => r.description.includes("left off this order"));
    assert.deepEqual(matched.map((r) => r.amount).sort((a, b) => a - b), [-250000, -150000]);
    assert.ok(matched.every((r) => r.orderId === orderIds[0]));
  });

  test("the payment records themselves are untouched", async () => {
    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = ANY(${orderIds}::int[])`;
    assert.equal(n, 2);
  });
});

after(closeDb);
