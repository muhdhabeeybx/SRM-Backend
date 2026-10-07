require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Surplus moves between orders only once somebody else approves it — the
 * owner's rule of 7 October 2026 (services/orderTransferRequest.service.js).
 *
 * Real staff, real tokens, the running API: a finance officer asks, a plain
 * finance officer cannot decide, the asker cannot approve their own, a named
 * approver can — and only then does money move.
 */
describe("surplus transfers by request and approval", () => {
  const RUN = Date.now();
  let pfiA, pfiB, cust, orderFrom, orderTo, orderOther;
  let asker, askerId, approver, approverId, plain, superAdmin;
  const savedApprovers = process.env.TRANSFER_APPROVER_STAFF_IDS;
  // Switched off by default (routes/administration/orderTransferRequest.route.js);
  // these tests are the feature, so they turn it on.
  const savedSwitch = process.env.SURPLUS_TRANSFERS_ENABLED;
  let ready = false;

  const as = (token) => ({
    get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
    post: (url, body = {}) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
  });
  const skip = (t) => !ready && t.skip("fixtures unavailable");
  const received = async (orderId) => {
    const [r] = await client`SELECT COALESCE(SUM(amount), 0)::numeric AS n FROM order_payments WHERE order_id = ${orderId}`;
    return Number(r.n);
  };

  before(async () => {
    try {
      const pfi = async (n) => {
        const [p] = await client`
          INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
          VALUES (${`XFER/${n}/${RUN}`}, 'coastal', 'active', 1000000, '1000') RETURNING id, pfi_number`;
        return p;
      };
      pfiA = await pfi("A");
      pfiB = await pfi("B");
      ;[cust] = await client`
        INSERT INTO customers (name, phone, company_name)
        VALUES (${`Xfer ${RUN}`}, ${"0" + String(RUN).slice(-10)}, 'Xfer Co') RETURNING id`;
      const order = async (pfiId, total) => {
        const [o] = await client`
          INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                              price, total_amount, delivery_type, company_name, pfi_id)
          SELECT ${"XF" + Math.floor(Math.random() * 1e9)}, ${cust.id}, 'Lagos', d.id, p.id, 1000,
                 1000, ${total}, 'pickup', 'Xfer Co', ${pfiId}
            FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
          RETURNING id, order_number`;
        return { id: Number(o.id), number: o.order_number };
      };
      orderFrom = await order(pfiA.id, 1000000);
      orderTo = await order(pfiA.id, 1000000);
      orderOther = await order(pfiB.id, 1000000);
      // ₦1,600,000 paid on a ₦1,000,000 order: ₦600,000 surplus.
      await client`
        INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
        VALUES (${orderFrom.id}, 1600000, 'statement', now(), 'Xfer', 'transfer test', ${"XF" + RUN})`;

      const mk = async (roles, tag) => {
        const s = await staffTokenWithRoles(roles, `xfer-${tag}-${RUN}@soroman.test`);
        return { token: s.accessToken, id: Number(s.staff.id) };
      };
      ;({ token: asker, id: askerId } = await mk(["finance"], "asker"));
      ;({ token: approver, id: approverId } = await mk(["finance"], "approver"));
      ;({ token: plain } = await mk(["finance"], "plain"));
      superAdmin = await staffToken(request, app);
      // The asker is named too, so refusing their own request is the rule
      // being tested, not merely their not being an approver.
      process.env.TRANSFER_APPROVER_STAFF_IDS = `${approverId},${askerId}`;
      process.env.SURPLUS_TRANSFERS_ENABLED = "true";
      ready = true;
    } catch (e) {
      console.error("transfer-request fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (savedApprovers === undefined) delete process.env.TRANSFER_APPROVER_STAFF_IDS;
    else process.env.TRANSFER_APPROVER_STAFF_IDS = savedApprovers;
    if (savedSwitch === undefined) delete process.env.SURPLUS_TRANSFERS_ENABLED;
    else process.env.SURPLUS_TRANSFERS_ENABLED = savedSwitch;
    if (ready) {
      const ids = [orderFrom.id, orderTo.id, orderOther.id];
      await client`DELETE FROM order_refunds WHERE order_id = ANY(${ids})`.catch(() => {});
      await client`DELETE FROM order_payments WHERE order_id = ANY(${ids})`;
      await client`DELETE FROM order_transfer_requests WHERE from_order_id = ANY(${ids}) OR to_order_id = ANY(${ids})`;
      await client`DELETE FROM order_payment_transfers WHERE from_order_id = ANY(${ids}) OR to_order_id = ANY(${ids})`;
      await client`DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY(${ids})`;
      await client`DELETE FROM orders WHERE id = ANY(${ids})`;
      await client`DELETE FROM customers WHERE id = ${cust.id}`;
      await client`DELETE FROM pfis WHERE id = ANY(${[pfiA.id, pfiB.id]})`;
    }
    await closeDb();
  });

  let firstId;

  test("asking moves nothing, and holds the amount on the order", async (t) => {
    if (skip(t)) return;
    const res = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 400000,
      reason: "Customer asked to move the balance onto the next order",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.request.status, "requested");
    firstId = Number(res.body.data.request.id);
    assert.equal(await received(orderFrom.id), 1600000);
    assert.equal(await received(orderTo.id), 0);

    const spare = await as(asker).get(`/api/order-transfer-requests/spare/${orderFrom.id}`);
    assert.equal(spare.body.data.order.surplus, 600000);
    assert.equal(spare.body.data.order.held, 400000);
    assert.equal(spare.body.data.order.available, 200000);
  });

  test("a second request can only reach what is not held", async (t) => {
    if (skip(t)) return;
    const res = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 300000, reason: "Trying to move more than is left",
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /already held/);
  });

  test("a refund can only reach what a waiting transfer does not hold", async (t) => {
    if (skip(t)) return;
    const res = await as(superAdmin).post("/api/order-refunds", {
      orderId: orderFrom.id, amount: 300000, destinationBank: "Test Bank",
      destinationName: "Xfer Co", destinationNumber: "0123456789", reason: "test",
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /held by a surplus transfer/);
  });

  test("orders on different PFIs, or the reason missing, are refused", async (t) => {
    if (skip(t)) return;
    const other = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderOther.id, amount: 1000, reason: "Different cargo on purpose",
    });
    assert.equal(other.status, 409, JSON.stringify(other.body));
    assert.match(other.body.message, /same PFI/);
    const noReason = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 1000, reason: "",
    });
    assert.equal(noReason.status, 400);
  });

  test("the asker cannot approve their own, and a plain finance officer cannot approve at all", async (t) => {
    if (skip(t)) return;
    const own = await as(asker).post(`/api/order-transfer-requests/${firstId}/approve`);
    assert.equal(own.status, 403, JSON.stringify(own.body));
    assert.match(own.body.message, /somebody else/);
    const notNamed = await as(plain).post(`/api/order-transfer-requests/${firstId}/approve`);
    assert.equal(notNamed.status, 403, JSON.stringify(notNamed.body));
    assert.equal(await received(orderTo.id), 0);
  });

  test("a named approver approves, and only then does the money move — with its trail", async (t) => {
    if (skip(t)) return;
    const res = await as(approver).post(`/api/order-transfer-requests/${firstId}/approve`, { note: "Checked with the customer" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.request.status, "approved");
    assert.equal(await received(orderFrom.id), 1200000);
    assert.equal(await received(orderTo.id), 400000);

    const [req] = await client`SELECT * FROM order_transfer_requests WHERE id = ${firstId}`;
    assert.equal(Number(req.decided_by), approverId);
    assert.equal(Number(req.from_before.surplus), 600000);
    assert.equal(Number(req.from_after.surplus), 200000);
    const [tr] = await client`SELECT request_id FROM order_payment_transfers WHERE id = ${req.transfer_id}`;
    assert.equal(Number(tr.request_id), firstId);
    const legs = await client`SELECT note FROM order_payments WHERE transfer_id = ${req.transfer_id}`;
    assert.equal(legs.length, 2);
    assert.ok(legs.every((l) => l.note.includes(`request #${firstId}`) && l.note.includes("approved by")));
    const audit = await client`
      SELECT action FROM audit_logs WHERE entity_type = 'order' AND entity_id = ${orderFrom.id}
         AND action IN ('order.transfer_requested', 'order.transfer_approved')`;
    assert.deepEqual([...new Set(audit.map((a) => a.action))].sort(), ["order.transfer_approved", "order.transfer_requested"]);
  });

  test("an approved request cannot be decided again", async (t) => {
    if (skip(t)) return;
    const again = await as(approver).post(`/api/order-transfer-requests/${firstId}/approve`);
    assert.equal(again.status, 409);
  });

  test("a rejection needs a reason and moves nothing; a withdrawal is the asker's", async (t) => {
    if (skip(t)) return;
    const asked = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 100000, reason: "A second move to be rejected",
    });
    const id = Number(asked.body.data.request.id);
    const bare = await as(approver).post(`/api/order-transfer-requests/${id}/reject`, {});
    assert.equal(bare.status, 400);
    const rejected = await as(approver).post(`/api/order-transfer-requests/${id}/reject`, { note: "No customer letter" });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(await received(orderTo.id), 400000);

    const again = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 100000, reason: "Asked, then thought better of it",
    });
    const id2 = Number(again.body.data.request.id);
    const notMine = await as(plain).post(`/api/order-transfer-requests/${id2}/cancel`);
    assert.equal(notMine.status, 403);
    const withdrawn = await as(asker).post(`/api/order-transfer-requests/${id2}/cancel`, { note: "Wrong order" });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.data.request.status, "cancelled");
  });

  test("approving a request the order can no longer cover is refused, not half done", async (t) => {
    if (skip(t)) return;
    const asked = await as(asker).post("/api/order-transfer-requests", {
      fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 150000, reason: "Will go stale before approval",
    });
    const id = Number(asked.body.data.request.id);
    // The order's value corrected upwards in between: it now has ₦100,000 to spare.
    await client`UPDATE orders SET total_amount = 1100000 WHERE id = ${orderFrom.id}`;
    const listed = await as(approver).get(`/api/order-transfer-requests?status=requested&orderId=${orderFrom.id}`);
    assert.ok(listed.body.data.requests.find((r) => r.id === id).stale);
    const res = await as(approver).post(`/api/order-transfer-requests/${id}/approve`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(await received(orderTo.id), 400000);
    await client`UPDATE orders SET total_amount = 1000000 WHERE id = ${orderFrom.id}`;
    await as(approver).post(`/api/order-transfer-requests/${id}/reject`, { note: "Out of date" });
  });

  test("undoing a transfer is asked for and approved too, and keeps the original on the record", async (t) => {
    if (skip(t)) return;
    const [req] = await client`SELECT transfer_id FROM order_transfer_requests WHERE id = ${firstId}`;
    // While the receiving order still needs the money, it cannot go back.
    const needed = await as(asker).post("/api/order-transfer-requests/reversal", {
      transferId: Number(req.transfer_id), reason: "Too early to undo",
    });
    assert.equal(needed.status, 409, JSON.stringify(needed.body));
    // The customer then pays that order in full directly: the moved money is spare again.
    await client`
      INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
      VALUES (${orderTo.id}, 1000000, 'statement', now(), 'Xfer', 'paid direct', ${"XFT" + RUN})`;
    const asked = await as(asker).post("/api/order-transfer-requests/reversal", {
      transferId: Number(req.transfer_id), reason: "Moved to the wrong order",
    });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const dup = await as(asker).post("/api/order-transfer-requests/reversal", {
      transferId: Number(req.transfer_id), reason: "Asking twice",
    });
    assert.equal(dup.status, 409);
    const res = await as(approver).post(`/api/order-transfer-requests/${asked.body.data.request.id}/approve`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await received(orderFrom.id), 1600000);
    assert.equal(await received(orderTo.id), 1000000);
    const [original] = await client`SELECT id FROM order_payment_transfers WHERE id = ${req.transfer_id}`;
    assert.ok(original, "the original transfer is kept");
    const listed = await as(approver).get(`/api/order-transfer-requests?orderId=${orderFrom.id}`);
    const first = listed.body.data.requests.find((r) => r.id === firstId);
    assert.equal(first.reversed, true);
    assert.equal(first.canReverse, false);
  });

  test("switched off, every transfer route refuses — a refund is the only way", async (t) => {
    if (skip(t)) return;
    process.env.SURPLUS_TRANSFERS_ENABLED = "false";
    try {
      const ask = await as(asker).post("/api/order-transfer-requests", {
        fromOrderId: orderFrom.id, toOrderId: orderTo.id, amount: 1000, reason: "Switched off on purpose",
      });
      assert.equal(ask.status, 410, JSON.stringify(ask.body));
      assert.match(ask.body.message, /Refund/);
      const list = await as(approver).get("/api/order-transfer-requests");
      assert.equal(list.status, 410);
    } finally {
      process.env.SURPLUS_TRANSFERS_ENABLED = "true";
    }
  });

  test("the old move-it-now routes are retired", async (t) => {
    if (skip(t)) return;
    const move = await as(superAdmin).post(`/api/orders/${orderFrom.id}/payments/transfer`, {
      toOrderId: orderTo.id, amount: 1, reason: "the old way",
    });
    assert.equal(move.status, 410);
    const undo = await request(app).delete(`/api/orders/${orderFrom.id}/payments/transfer/1`).set("Authorization", `Bearer ${superAdmin}`);
    assert.equal(undo.status, 410);
  });
});
