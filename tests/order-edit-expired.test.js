require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const orderService = require("../services/order.service");
const mergeService = require("../services/orderMerge.service");
const { closeDb } = require("./helpers");

/**
 * An expired order accepts one correction: whose it is.
 *
 * The case it exists for: one buyer opened as three customer records, an
 * order under each at the same price on one PFI. A merge needs one customer,
 * and the expired order could not be edited, so it could never be merged.
 */
const RUN = `${Date.now()}`.slice(-9);
const actor = { type: "system" };

describe("editing an expired order", () => {
  let keep;
  let other;
  let pfiId;
  const ids = {};

  const customer = async (key) => {
    const [c] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Expired Edit ${key}`}, ${`+23481${RUN}${key === "keep" ? 1 : 2}`}, 'Active', 'Expired Edit Co')
      RETURNING id`;
    return Number(c.id);
  };

  const makeOrder = async (key, customerId, status) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name, status, pfi_id)
      SELECT ${`EE${RUN}${key}`}, ${customerId}, 'Lagos', d.id, p.id, 100,
             990, 99000, 'pickup', 'Expired Edit Co', ${status}, ${pfiId}
        FROM (SELECT id FROM depots ORDER BY id LIMIT 1) d, (SELECT id FROM products ORDER BY id LIMIT 1) p
      RETURNING id`;
    ids[key] = Number(o.id);
  };

  const customerOf = async (orderId) => {
    const [o] = await client`SELECT customer_id FROM orders WHERE id = ${orderId}`;
    return Number(o.customer_id);
  };

  before(async () => {
    keep = await customer("keep");
    other = await customer("other");
    const [p] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
      VALUES (${`TEST/EXPIRED-EDIT/${RUN}`}, 'coastal', 'active', 1000000, '990') RETURNING id`;
    pfiId = Number(p.id);
    await makeOrder("live", keep, "Pending");
    await makeOrder("expired", other, "Expired");
    await makeOrder("cancelled", other, "Cancelled");
  });

  after(async () => {
    const all = Object.values(ids);
    await client`DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY(${all})`;
    await client`DELETE FROM orders WHERE id = ANY(${all})`;
    await client`DELETE FROM pfis WHERE id = ${pfiId}`;
    await client`DELETE FROM customers WHERE id IN (${keep}, ${other})`;
    await closeDb();
  });

  test("anything but the customer is still refused", async () => {
    await assert.rejects(
      orderService.updateOrder(ids.expired, { quantity: 200 }, { actor }),
      /expired order can no longer be edited/,
    );
    await assert.rejects(
      orderService.updateOrder(ids.expired, { customerId: keep, quantity: 200 }, { actor }),
      /expired order can no longer be edited/,
    );
    assert.equal(await customerOf(ids.expired), other);
  });

  test("a cancelled order cannot change customer", async () => {
    await assert.rejects(
      orderService.updateOrder(ids.cancelled, { customerId: keep }, { actor }),
      /cancelled order can no longer be edited/,
    );
    assert.equal(await customerOf(ids.cancelled), other);
  });

  test("its customer moves, on the record, and it can then be merged", async () => {
    const before = await mergeService.mergeOverview(ids.live);
    assert.equal(before.candidates.length, 0, "under another customer it is not a match");

    // The form sends the fields it rendered; unchanged ones must not count.
    const [row] = await client`SELECT quantity, total_amount FROM orders WHERE id = ${ids.expired}`;
    await orderService.updateOrder(
      ids.expired,
      { customerId: keep, quantity: Number(row.quantity), totalAmount: row.total_amount },
      { actor },
    );
    assert.equal(await customerOf(ids.expired), keep);

    const [audit] = await client`
      SELECT metadata FROM audit_logs
       WHERE entity_type = 'order' AND entity_id = ${ids.expired} AND action = 'order.updated'`;
    assert.deepEqual(audit.metadata.changes.customerId, [other, keep]);

    const after = await mergeService.mergeOverview(ids.live);
    assert.deepEqual(after.candidates.map((c) => c.id), [ids.expired]);
    assert.deepEqual(after.candidates[0].blockers, []);
  });
});
