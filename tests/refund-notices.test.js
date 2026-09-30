// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { sql } = require("drizzle-orm");

const refundService = require("../services/orderRefund.service");
const { db, client } = require("../config/db");
const { notifications } = require("../db/schema");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * A refund reaches the people it concerns: finance hears there is money to
 * send, and whoever asked hears when it went — or why it did not.
 */
const RUN = Date.now();

async function waitFor(type, refundId, staffId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select({ staffId: notifications.staffId, body: notifications.body })
      .from(notifications)
      .where(sql`${notifications.type} = ${type} AND ${notifications.data}->>'refundId' = ${String(refundId)}`);
    const hit = rows.find((r) => Number(r.staffId) === Number(staffId));
    if (hit || Date.now() > deadline) return hit || null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("refund notices", () => {
  let finance;
  let requester;
  let orderId;
  let accountId;

  before(async () => {
    finance = (await staffTokenWithRoles(["finance"], `rn-fin-${RUN}@soroman.test`)).staff;
    requester = (await staffTokenWithRoles(["sales_manager"], `rn-req-${RUN}@soroman.test`)).staff;
    const customerId = Number((await client`SELECT id FROM customers ORDER BY id LIMIT 1`)[0].id);
    accountId = Number((await client`SELECT id FROM bank_accounts ORDER BY id LIMIT 1`)[0].id);
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price, total_amount,
                          delivery_type, company_name, payment_status, amount_paid)
      SELECT ${`RN${RUN}`}, ${customerId}, 'Lagos', d.id, p.id, 1000, 1000, 1000000, 'pickup', 'Notice Co', 'Paid', 1100000
        FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
      RETURNING id`;
    orderId = Number(o.id);
    await client`INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
                 VALUES (${orderId}, 1100000, 'statement', now(), 'Test', 'seed', ${`RN-${RUN}`})`;
  });

  after(async () => {
    await client`DELETE FROM order_payments WHERE order_id = ${orderId}`;
    await client`DELETE FROM order_refunds WHERE order_id = ${orderId}`;
    await client`DELETE FROM orders WHERE id = ${orderId}`;
    await closeDb();
  });

  test("finance is told there is a refund to pay, with the account", async () => {
    const refund = await refundService.requestRefund({
      orderId, destinationBank: "GTBank", destinationName: "Notice Customer", destinationNumber: "0123456789",
      staffId: requester.id,
    });
    const hit = await waitFor("staff.refund_requested", refund.id, finance.id);
    assert.ok(hit, "finance heard about it");
    assert.match(hit.body, /Notice Customer · GTBank 0123456789/);

    await refundService.markRefunded({ refundId: refund.id, paidFromAccountId: accountId, paymentReference: "RN-REF", staffId: finance.id });
    const sent = await waitFor("staff.refund_decided", refund.id, requester.id);
    assert.ok(sent, "whoever asked heard it was sent");
    assert.match(sent.body, /was sent/);
    assert.match(sent.body, /RN-REF/);
  });
});
