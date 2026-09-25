require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db, client } = require("../config/db");
const mergeService = require("../services/orderMerge.service");
const orderPaymentService = require("../services/orderPayment.service");
const { staffToken, closeDb, makeStatementLine } = require("./helpers");

/**
 * Folding orders at one unit price into one.
 *
 * What is pinned here is what would be expensive to get wrong: that no naira
 * appears or disappears, that every truck, ticket and litre of stock arrives
 * on the surviving order, that the merged-away orders are left empty and say
 * where they went — and that migration 0021, which is re-run on every deploy,
 * does not read the moved rows as missing and write them back.
 */
const RUN = `${Date.now()}`.slice(-9);
const PRICE = 1000;
const QTY = 100;
const TOTAL = PRICE * QTY;

const n = (v) => Number(v);

describe("order merge", () => {
  let token;
  let customerId;
  let pfiId;
  const ids = {};
  let t1; // A → C, between two orders that merge
  let t2; // X → B, from an order that does not
  let depositId;
  let lineId;

  const makeOrder = async (key, { status = "Pending", price = PRICE, withPfi = true } = {}) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                          price, total_amount, delivery_type, company_name, status, pfi_id)
      SELECT ${`MG${RUN}${key}`}, ${customerId}, 'Lagos', d.id, p.id, ${QTY},
             ${price}, ${price * QTY}, 'pickup', 'Merge Test Co', ${status}, ${withPfi ? pfiId : null}
        FROM (SELECT id FROM depots ORDER BY id LIMIT 1) d, (SELECT id FROM products ORDER BY id LIMIT 1) p
      RETURNING id`;
    ids[key] = Number(o.id);
    return ids[key];
  };

  const pay = (orderId, amount, source = "statement", extra = {}) => client`
    INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref, transfer_id)
    VALUES (${orderId}, ${amount}, ${source}, now(), 'Test', 'seed', ${`SEED-${RUN}`}, ${extra.transferId ?? null})`;

  const transfer = async (from, to, amount) => {
    const [t] = await client`
      INSERT INTO order_payment_transfers (from_order_id, to_order_id, amount, reason)
      VALUES (${from}, ${to}, ${amount}, 'seed') RETURNING id`;
    await pay(from, -amount, "transfer_out", { transferId: t.id });
    await pay(to, amount, "transfer_in", { transferId: t.id });
    return Number(t.id);
  };

  const truck = async (orderId, index) => {
    const [t] = await client`
      INSERT INTO order_trucks (order_id, truck_index, truck_number, quantity, status)
      VALUES (${orderId}, ${index}, ${`TRK-${RUN}-${orderId}-${index}`}, 50, 'gated_out') RETURNING id`;
    await client`
      INSERT INTO tickets (ticket_number, order_id, order_truck_id, qr_code_data_url)
      VALUES (${`TCK-${RUN}-${orderId}-${index}`}, ${orderId}, ${t.id}, 'data:')`;
  };

  const recompute = (orderId) => db.transaction((tx) => orderPaymentService.recomputeOrder(orderId, tx));

  const sumOf = async (orderIds) => {
    const [r] = await client`SELECT COALESCE(SUM(amount), 0)::numeric AS s FROM order_payments WHERE order_id = ANY(${orderIds})`;
    return n(r.s);
  };

  before(async () => {
    token = await staffToken(request, app);
    const [c] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES ('Merge Test Customer', ${`+23480${RUN}`}, 'Active', 'Merge Test Co') RETURNING id`;
    customerId = Number(c.id);
    const [p] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
      VALUES (${`TEST/MERGE/${RUN}`}, 'coastal', 'active', 1000000, '1000') RETURNING id`;
    pfiId = Number(p.id);

    // A — the survivor. Released, two trucks out, paid 105k then gave 5k to C.
    await makeOrder("A", { status: "Released" });
    await pay(ids.A, 105000);
    await truck(ids.A, 1);
    await truck(ids.A, 2);
    await client`INSERT INTO order_pfi_allocations (order_id, pfi_id, quantity) VALUES (${ids.A}, ${pfiId}, ${QTY})`;
    await client`INSERT INTO pfi_movements (pfi_id, order_id, action, qty_litres) VALUES (${pfiId}, ${ids.A}, 'RELEASE', 100)`;

    // B — Pending, part paid, and from before multi-PFI allocations: it holds
    // its stock implicitly, with no allocation row at all.
    await makeOrder("B");
    await pay(ids.B, 30000, "legacy");

    // C — Completed, one truck, a set-aside overpayment.
    await makeOrder("C", { status: "Completed" });
    await pay(ids.C, 95000);
    await truck(ids.C, 1);
    await client`INSERT INTO order_pfi_allocations (order_id, pfi_id, quantity) VALUES (${ids.C}, ${pfiId}, ${QTY})`;
    await client`INSERT INTO pfi_movements (pfi_id, order_id, action, qty_litres) VALUES (${pfiId}, ${ids.C}, 'RELEASE', 50)`;
    await client`
      INSERT INTO order_refunds (order_id, customer_id, amount, status, reason)
      VALUES (${ids.C}, ${customerId}, 1, 'skipped', 'seed')`;

    // X — same customer and price, NOT merged. Paid by one ₦20k bank line
    // that B and C each drew part of in the wallet era: exactly the shape
    // migration 0021 section 4 restates as transfers X→B and X→C. After the
    // merge both draws sit on A as ONE summed allocation, which matches
    // neither transfer by amount — the case the guard in 0021 exists for.
    await makeOrder("X");
    const { line } = await makeStatementLine(20000, `MERGE ${RUN}`);
    lineId = Number(line.id);
    const [dep] = await client`
      INSERT INTO deposits (customer_id, amount, type) VALUES (${customerId}, 20000, 'credit') RETURNING id`;
    depositId = Number(dep.id);
    await client`UPDATE bank_statement_lines SET matched_deposit_id = ${depositId}, status = 'MATCHED' WHERE id = ${lineId}`;
    await client`
      INSERT INTO order_payments (order_id, statement_line_id, amount, source, txn_date, deposit_id)
      VALUES (${ids.X}, ${lineId}, 20000, 'statement', now(), ${depositId})`;

    t1 = await transfer(ids.A, ids.C, 5000);
    t2 = await transfer(ids.X, ids.B, 7000);
    await transfer(ids.X, ids.C, 3000);
    await client`
      INSERT INTO order_deposit_allocations (order_id, deposit_id, amount, applied_amount, source)
      VALUES (${ids.X}, ${depositId}, 20000, 10000, 'bank'),
             (${ids.B}, ${depositId}, 7000, 7000, 'wallet'),
             (${ids.C}, ${depositId}, 3000, 3000, 'wallet')`;

    // D — different price. E — open refund request.
    await makeOrder("D", { price: 1100 });
    await makeOrder("E");
    await pay(ids.E, TOTAL + 20000);
    await client`
      INSERT INTO order_refunds (order_id, customer_id, amount, status)
      VALUES (${ids.E}, ${customerId}, 20000, 'requested')`;

    // F — the migration-0021 duplicate shape: a transfer_in and a legacy row
    // for the same amount, settling the order exactly once without the legacy.
    await makeOrder("F");
    await pay(ids.X, TOTAL);
    await transfer(ids.X, ids.F, TOTAL);
    await pay(ids.F, TOTAL, "legacy");

    for (const key of Object.keys(ids)) await recompute(ids[key]);
  });

  after(async () => {
    const all = Object.values(ids);
    if (all.length) {
      await client`UPDATE orders SET merged_into_order_id = NULL WHERE id = ANY(${all})`;
      await client`DELETE FROM order_merges WHERE target_order_id = ANY(${all}) OR source_order_id = ANY(${all})`;
      await client`DELETE FROM tickets WHERE order_id = ANY(${all})`;
      await client`DELETE FROM order_trucks WHERE order_id = ANY(${all})`;
      await client`DELETE FROM order_payments WHERE order_id = ANY(${all})`;
      await client`DELETE FROM order_payment_transfers WHERE from_order_id = ANY(${all}) OR to_order_id = ANY(${all})`;
      await client`DELETE FROM order_refunds WHERE order_id = ANY(${all})`;
      await client`DELETE FROM order_pfi_allocations WHERE order_id = ANY(${all})`;
      await client`DELETE FROM pfi_movements WHERE order_id = ANY(${all})`;
      await client`DELETE FROM commissions WHERE order_id = ANY(${all})`;
      await client`DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY(${all})`;
      await client`DELETE FROM order_deposit_allocations WHERE order_id = ANY(${all})`;
      await client`DELETE FROM orders WHERE id = ANY(${all})`;
    }
    if (lineId) await client`DELETE FROM bank_statement_lines WHERE id = ${lineId}`;
    if (depositId) await client`DELETE FROM deposits WHERE id = ${depositId}`;
    if (pfiId) await client`DELETE FROM pfis WHERE id = ${pfiId}`;
    if (customerId) await client`DELETE FROM customers WHERE id = ${customerId}`;
    await closeDb();
  });

  test("the overview lists the matching orders, with the reason any is blocked", async () => {
    const res = await request(app).get(`/api/orders/${ids.A}/merges`).set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const byId = new Map(res.body.data.candidates.map((c) => [c.id, c]));
    assert.ok(byId.has(ids.B) && byId.has(ids.C) && byId.has(ids.X), "same customer, product, depot, PFI and price");
    assert.ok(!byId.has(ids.D), "a different unit price is not a candidate");
    assert.ok(byId.get(ids.E).blockers.some((b) => /refund request/.test(b)));
    assert.ok(byId.get(ids.F).blockers.some((b) => /not real money/.test(b)));
    assert.equal(byId.get(ids.B).blockers.length, 0);
  });

  test("a different unit price is refused, in the preview and the merge", async () => {
    const preview = await mergeService.previewMerge({ targetOrderId: ids.A, sourceOrderIds: [ids.D] });
    assert.equal(preview.ok, false);
    assert.ok(preview.problems.some((p) => /priced at/.test(p)));
    await assert.rejects(
      () => mergeService.mergeOrders({ targetOrderId: ids.A, sourceOrderIds: [ids.D], reason: "test" }),
      (e) => e.status === 409,
    );
  });

  test("an open refund request, or a phantom payment row, blocks the merge", async () => {
    for (const id of [ids.E, ids.F]) {
      await assert.rejects(
        () => mergeService.mergeOrders({ targetOrderId: ids.A, sourceOrderIds: [id], reason: "test" }),
        (e) => e.status === 409,
      );
    }
  });

  test("merge needs finance or super admin, and a reason", async () => {
    const res = await request(app)
      .post(`/api/orders/${ids.A}/merge`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceOrderIds: [ids.B] });
    assert.equal(res.status, 400, "no reason");
  });

  let moneyBefore;
  let result;

  test("merging B and C into A", async () => {
    moneyBefore = await sumOf([ids.A, ids.B, ids.C, ids.X]);
    const preview = await mergeService.previewMerge({ targetOrderId: ids.A, sourceOrderIds: [ids.B, ids.C] });
    assert.equal(preview.ok, true, preview.problems.join("; "));
    assert.equal(preview.result.status, "Loading", "a Completed order merged with unfinished ones is Loading");
    assert.equal(preview.result.quantity, 300);
    assert.equal(preview.result.totalAmount, 300000);

    const res = await request(app)
      .post(`/api/orders/${ids.A}/merge`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceOrderIds: [ids.B, ids.C], reason: "Same customer, same price — one order" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    result = res.body.data;
    assert.equal(result.merged.length, 2);
  });

  test("no money appears or disappears", async () => {
    assert.equal(await sumOf([ids.A, ids.B, ids.C, ids.X]), moneyBefore);
    const [a] = await client`SELECT * FROM orders WHERE id = ${ids.A}`;
    assert.equal(n(a.quantity), 300);
    assert.equal(n(a.total_amount), 300000);
    // 100k (A) + 37k (B: 30k legacy + 7k from X) + 103k (C: 95k + 5k from A + 3k from X)
    assert.equal(n(a.amount_paid), 240000);
    assert.equal(a.payment_status, "Part Paid");
    assert.equal(a.status, "Loading");
  });

  test("the merged-away orders are empty, Cancelled, and name where they went", async () => {
    const rows = await client`SELECT * FROM orders WHERE id = ANY(${[ids.B, ids.C]})`;
    for (const o of rows) {
      assert.equal(o.status, "Cancelled");
      assert.equal(Number(o.merged_into_order_id), ids.A);
      assert.equal(n(o.amount_paid), 0);
      assert.equal(o.payment_status, "Unpaid");
      assert.match(o.cancellation_reason, /^Merged into /);
    }
    const [{ left }] = await client`
      SELECT (SELECT COUNT(*) FROM order_payments WHERE order_id = ANY(${[ids.B, ids.C]}))
           + (SELECT COUNT(*) FROM order_trucks WHERE order_id = ANY(${[ids.B, ids.C]}))
           + (SELECT COUNT(*) FROM tickets WHERE order_id = ANY(${[ids.B, ids.C]}))
           + (SELECT COUNT(*) FROM order_pfi_allocations WHERE order_id = ANY(${[ids.B, ids.C]}))
           + (SELECT COUNT(*) FROM pfi_movements WHERE order_id = ANY(${[ids.B, ids.C]}))
           + (SELECT COUNT(*) FROM order_refunds WHERE order_id = ANY(${[ids.B, ids.C]})) AS left`;
    assert.equal(n(left), 0);
  });

  test("trucks are renumbered after the survivor's own, and tickets follow", async () => {
    const trucks = await client`SELECT truck_index FROM order_trucks WHERE order_id = ${ids.A} ORDER BY truck_index`;
    assert.deepEqual(trucks.map((t) => n(t.truck_index)), [1, 2, 3]);
    const [{ c }] = await client`SELECT COUNT(*) AS c FROM tickets WHERE order_id = ${ids.A}`;
    assert.equal(n(c), 3);
  });

  test("stock reservations and movements are summed, including the implicit one", async () => {
    const alloc = await client`SELECT pfi_id, quantity FROM order_pfi_allocations WHERE order_id = ${ids.A}`;
    assert.equal(alloc.length, 1);
    assert.equal(n(alloc[0].quantity), 300, "A 100 + B's implicit 100 + C 100");
    const moves = await client`SELECT action, qty_litres FROM pfi_movements WHERE order_id = ${ids.A}`;
    assert.deepEqual(moves.map((m) => [m.action, n(m.qty_litres)]), [["RELEASE", 150]]);
  });

  test("transfers: the internal one stays as history, the external one follows", async () => {
    const [internal] = await client`SELECT * FROM order_payment_transfers WHERE id = ${t1}`;
    assert.equal(n(internal.from_order_id), ids.A);
    assert.equal(n(internal.to_order_id), ids.C);
    const [external] = await client`SELECT * FROM order_payment_transfers WHERE id = ${t2}`;
    assert.equal(n(external.from_order_id), ids.X);
    assert.equal(n(external.to_order_id), ids.A);
    const [alloc] = await client`
      SELECT amount, applied_amount FROM order_deposit_allocations WHERE order_id = ${ids.A} AND deposit_id = ${depositId}`;
    assert.equal(n(alloc.applied_amount), 10000, "B's 7k and C's 3k draws, summed");
    await assert.rejects(
      () => orderPaymentService.reverseTransfer({ transferId: t1, reason: "test" }),
      (e) => e.status === 409,
    );
  });

  test("the set-aside overpayment is lifted, since the surplus it judged is gone", async () => {
    const [skip] = await client`SELECT status, order_id FROM order_refunds WHERE customer_id = ${customerId} AND reason = 'seed'`;
    assert.equal(skip.status, "cancelled");
    assert.equal(n(skip.order_id), ids.A);
  });

  test("the merge is recorded with every order's figures before and after", async () => {
    const rows = await client`SELECT * FROM order_merges WHERE target_order_id = ${ids.A} ORDER BY source_order_id`;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].merge_group, rows[1].merge_group);
    const b = rows.find((r) => n(r.source_order_id) === ids.B);
    assert.equal(n(b.source_before.amountPaid), 37000);
    assert.equal(n(b.target_before.amountPaid), 100000);
    assert.equal(n(b.target_after.amountPaid), 240000);

    const res = await request(app).get(`/api/orders/${ids.B}/merges`).set("Authorization", `Bearer ${token}`);
    assert.equal(res.body.data.mergedInto.orderId, ids.A);
    const resA = await request(app).get(`/api/orders/${ids.A}/merges`).set("Authorization", `Bearer ${token}`);
    assert.equal(resA.body.data.mergedFrom.length, 2);
  });

  test("a merged-away order cannot be merged again", async () => {
    await assert.rejects(
      () => mergeService.mergeOrders({ targetOrderId: ids.X, sourceOrderIds: [ids.B], reason: "again" }),
      (e) => e.status === 409,
    );
  });

  test("re-running migration 0021 writes nothing for merged orders", async () => {
    // First prove the hazard is real: without the merge guard, section 4
    // WOULD now see a ₦10k draw on A from X with no matching transfer.
    const [{ unguarded }] = await client`
      SELECT COUNT(*) AS unguarded
        FROM order_deposit_allocations draw
        JOIN bank_statement_lines l ON l.matched_deposit_id = draw.deposit_id
        JOIN order_payments owner ON owner.statement_line_id = l.id
       WHERE draw.order_id <> owner.order_id AND draw.applied_amount > 0
         AND draw.order_id = ${ids.A}
         AND NOT EXISTS (SELECT 1 FROM order_payment_transfers t
                          WHERE t.from_order_id = owner.order_id AND t.to_order_id = draw.order_id
                            AND t.amount = draw.applied_amount)`;
    assert.equal(n(unguarded), 1, "the summed draw matches no existing transfer");

    const count = async () => {
      const [r] = await client`
        SELECT (SELECT COUNT(*) FROM order_payments) AS p, (SELECT COUNT(*) FROM order_payment_transfers) AS t`;
      return [n(r.p), n(r.t)];
    };
    const before = await count();
    const file = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0021_order_payments.sql"), "utf8");
    await client.unsafe(file);
    assert.deepEqual(await count(), before);
  });
});
