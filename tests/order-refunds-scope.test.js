// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const refundService = require("../services/orderRefund.service");
const { orderRepo } = require("../repositories");
const { closeDb } = require("./helpers");
const { client } = require("../config/db");

/**
 * What the refund desk shows, to whom, and what it must never offer to pay.
 *
 *   scope      a person sees refunds on their PFIs, else their depots, else all
 *   moved on   surplus handed to another order in the wallet era is not owed
 *   stale      a request its order no longer covers is flagged, and unpayable
 *   paid       a refund paid shows on the finance report, and the balance is 0
 */
const RUN = Date.now();

describe("overpayment refunds — scope, money already moved, stale requests, the report", () => {
  let customerId;
  let accountId;
  let depotA;
  let depotB;
  let productId;
  let pfiA;
  const orderIds = [];
  const depositIds = [];

  const seedOrder = async ({ depotId, pfiId = null, total, paid }) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name, pfi_id, payment_status, amount_paid)
      VALUES (${`RS${RUN}${orderIds.length}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, 1000,
              ${total / 1000}, ${total}, 'pickup', 'Scope Test Co', ${pfiId}, 'Paid', ${paid})
      RETURNING id`;
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${o.id}, ${paid}, 'statement', now(), 'Test', 'seed', ${`SEED-${RUN}-${orderIds.length}`})`;
    orderIds.push(Number(o.id));
    return Number(o.id);
  };

  before(async () => {
    customerId = Number((await client`SELECT id FROM customers ORDER BY id LIMIT 1`)[0].id);
    accountId = Number((await client`SELECT id FROM bank_accounts ORDER BY id LIMIT 1`)[0].id);
    productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depots = await client`SELECT id FROM depots ORDER BY id LIMIT 2`;
    depotA = Number(depots[0].id);
    depotB = Number(depots[1].id);
    [pfiA] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, location_id, product_id, starting_qty_litres)
      VALUES (${`PFI/SCOPE/${RUN}`}, 'coastal', 'active', ${depotA}, ${productId}, 100000) RETURNING id, pfi_number`;
  });

  after(async () => {
    if (orderIds.length) {
      await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds}::int[])`;
      await client`DELETE FROM order_refunds WHERE order_id = ANY(${orderIds}::int[])`;
      await client`DELETE FROM order_deposit_allocations WHERE order_id = ANY(${orderIds}::int[])`;
    }
    if (depositIds.length) await client`DELETE FROM deposits WHERE id = ANY(${depositIds}::int[])`;
    if (orderIds.length) await client`DELETE FROM orders WHERE id = ANY(${orderIds}::int[])`;
    await client`DELETE FROM pfis WHERE id = ${pfiA.id}`;
    await closeDb();
  });

  const onPfi = () => ({ id: -1, canViewAllLocations: false, scope: { pfiIds: [Number(pfiA.id)], depotIds: [] } });
  const onDepot = (id) => ({ id: -1, canViewAllLocations: false, scope: { pfiIds: [], depotIds: [id] } });
  const everyone = { id: -1, canViewAllLocations: true, scope: {} };

  let aOrder;
  let bOrder;
  let pfiOrder;

  test("a person sees only the refunds inside their scope: PFIs, else depots", async () => {
    aOrder = await seedOrder({ depotId: depotA, total: 1_000_000, paid: 1_200_000 });
    bOrder = await seedOrder({ depotId: depotB, total: 1_000_000, paid: 1_300_000 });
    pfiOrder = await seedOrder({ depotId: depotA, pfiId: Number(pfiA.id), total: 500_000, paid: 600_000 });

    const ids = (rows) => rows.map((r) => r.orderId);
    const forA = ids(await refundService.listRefundable({ scopeUser: onDepot(depotA), limit: 1000 }));
    assert.ok(forA.includes(aOrder) && !forA.includes(bOrder), "depot A sees its own orders only");

    const forPfi = ids(await refundService.listRefundable({ scopeUser: onPfi(), limit: 1000 }));
    assert.deepEqual(forPfi.filter((id) => orderIds.includes(id)), [pfiOrder], "a PFI assignment is the whole answer");

    const all = ids(await refundService.listRefundable({ scopeUser: everyone, limit: 1000 }));
    assert.ok([aOrder, bOrder, pfiOrder].every((id) => all.includes(id)));

    const row = (await refundService.listRefundable({ scopeUser: onPfi(), limit: 1000 })).find((r) => r.orderId === pfiOrder);
    assert.equal(row.pfiNumber, pfiA.pfi_number, "the PFI is on the row");
    assert.ok(row.depotName, "and the location");
  });

  test("an order outside the person's scope reads as not found, for every act", async () => {
    await assert.rejects(() => refundService.assertOrderInScope(onDepot(depotA), bOrder), (e) => e.status === 404);
    await refundService.assertOrderInScope(onDepot(depotB), bOrder);
    await refundService.assertOrderInScope(everyone, bOrder);
  });

  test("surplus already handed to another order in the wallet era is not offered, and cannot be requested", async () => {
    const giver = await seedOrder({ depotId: depotA, total: 1_000_000, paid: 1_400_000 });
    const receiver = await seedOrder({ depotId: depotA, total: 400_000, paid: 1 });
    const [dp] = await client`
      INSERT INTO deposits (customer_id, amount, type, description)
      VALUES (${customerId}, 400000, 'credit', ${`Surplus from order #${giver}`}) RETURNING id`;
    depositIds.push(Number(dp.id));
    await client`
      INSERT INTO order_deposit_allocations (order_id, deposit_id, amount, applied_amount)
      VALUES (${receiver}, ${dp.id}, 400000, 400000)`;

    const listed = (await refundService.listRefundable({ scopeUser: everyone, limit: 1000 })).map((r) => r.orderId);
    assert.ok(!listed.includes(giver), "the ₦400,000 went to another order — nothing is owed back");

    const s = await refundService.realSurplus(giver);
    assert.equal(s.surplus, 0);
    assert.equal(s.movedOut, 400000);
    await assert.rejects(
      () => refundService.requestRefund({
        orderId: giver, destinationBank: "GTBank", destinationName: "Twice", destinationNumber: "0123456789",
      }),
      (e) => e.status === 409,
    );
  });

  test("a request its order no longer covers is flagged stale, and cannot be paid", async () => {
    const refund = await refundService.requestRefund({
      orderId: aOrder, destinationBank: "GTBank", destinationName: "Bello Musa", destinationNumber: "0123456789",
      reason: "Paid twice",
    });
    let row = (await refundService.listRefunds({ scopeUser: everyone })).find((r) => r.id === refund.id);
    assert.equal(row.stale, false);
    assert.equal(row.currentSurplus, 200000);

    // The wrong match is taken off and the right one put on — the money is no longer over.
    await client`UPDATE order_payments SET amount = 1000000 WHERE order_id = ${aOrder}`;
    row = (await refundService.listRefunds({ scopeUser: everyone })).find((r) => r.id === refund.id);
    assert.equal(row.stale, true, "the page must not offer to pay this");
    assert.equal(row.currentSurplus, 0);
    await assert.rejects(
      () => refundService.markRefunded({ refundId: refund.id, paidFromAccountId: accountId }),
      (e) => e.status === 409,
    );
    await refundService.cancelRefund({ refundId: refund.id, reason: "Payments corrected" });
  });

  test("the refund's record carries the account, the PFI and every step", async () => {
    const refund = await refundService.requestRefund({
      orderId: pfiOrder, destinationBank: "Zenith", destinationName: "Scope Customer", destinationNumber: "0011223344",
      reason: "Overpaid by transfer",
    });
    await refundService.markRefunded({ refundId: refund.id, paidFromAccountId: accountId, paymentReference: "RF-REF-1" });

    const one = await refundService.getRefund({ refundId: refund.id, scopeUser: onPfi() });
    assert.equal(one.destinationNumber, "0011223344");
    assert.equal(one.pfiNumber, pfiA.pfi_number);
    assert.equal(one.status, "refunded");
    assert.deepEqual(one.history.map((h) => h.action), ["requested", "paid"]);
    assert.equal(one.history[1].paymentReference, "RF-REF-1");

    await assert.rejects(() => refundService.getRefund({ refundId: refund.id, scopeUser: onDepot(depotB) }), (e) => e.status === 404);
  });

  test("once paid, the finance report says it was refunded and the balance is 0", async () => {
    const [o] = await client`SELECT order_number FROM orders WHERE id = ${pfiOrder}`;
    const report = await orderRepo.findFinanceReport({ search: o.order_number, paymentStatus: "all", limit: 50 });
    const row = (report.orders || report.rows || report.data || []).find((r) => Number(r.id) === pfiOrder);
    assert.ok(row, "the order is on the report");
    assert.equal(Number(row.refunded), -100000, "₦100,000 went back to the customer");
    assert.equal(Math.round(row.balance), 0, "nothing is left over");
    assert.equal(Math.round(row.surplus), 0);
    assert.equal(Number(report.totals?.totalRefunded ?? report.summary?.totalRefunded), 100000);
  });
});
