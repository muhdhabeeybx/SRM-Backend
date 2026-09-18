require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const commissionService = require("../services/commission.service");
const commissionRepo = require("../repositories/commission.repository");
const { customerRepo, orderRepo, depotRepo, productRepo } = require("../repositories");
const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * A commission rate that belongs to the customer.
 *
 * Commission is configured per depot and product; some customers are on ₦2.00
 * per litre by agreement and the rate table has no room for that. These pin
 * the resolution order and — more importantly — the one way the feature breaks
 * silently: a depot rate edit sweeping an agreed rate away.
 */
describe("a customer's own commission rate", () => {
  let customerId = null;
  let plainCustomerId = null;
  let depotId = null;
  let productId = null;
  let ready = false;

  before(async () => {
    const [{ exists }] = await client`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'customers' AND column_name = 'commission_rate'
      ) AS exists`;
    if (!exists) return;

    const depots = await client`SELECT id FROM depots ORDER BY id LIMIT 1`;
    const products = await client`SELECT id FROM products ORDER BY id LIMIT 1`;
    const customers = await client`SELECT id FROM customers ORDER BY id LIMIT 2`;
    if (!depots.length || !products.length || customers.length < 2) return;

    depotId = Number(depots[0].id);
    productId = Number(products[0].id);
    customerId = Number(customers[0].id);
    plainCustomerId = Number(customers[1].id);
    ready = true;
  });

  // The pool is closed once, by the LAST suite in this file. Closing it here
  // too would shut it before the HTTP suite below ever runs.
  after(async () => {
    if (ready) {
      await customerRepo.update(customerId, { commissionRate: null });
      await customerRepo.update(plainCustomerId, { commissionRate: null });
    }
  });

  test("null means no agreement, and the depot's rate applies", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await customerRepo.update(customerId, { commissionRate: null });
    await commissionRepo.upsertRate(depotId, productId, 1);

    const { rate, source } = await commissionService.resolveRate({
      customerId, depotId, productId,
    });
    assert.equal(rate, 1);
    assert.equal(source, "depot_product");
  });

  test("an agreed rate wins where the depot pays something", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    await commissionRepo.upsertRate(depotId, productId, 1);
    await customerRepo.update(customerId, { commissionRate: "2.00" });

    const { rate, source } = await commissionService.resolveRate({
      customerId, depotId, productId,
    });
    assert.equal(rate, 2);
    assert.equal(source, "customer");
  });

  test("an agreed rate does NOT open up a depot that pays nobody", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");

    /*
     * The depot+product rate decides WHETHER an order earns; the customer's
     * rate only decides HOW MUCH once it does. Resolving the customer first
     * would have started paying ₦2.00 at Dangote Refinery and AIPEC Lagos —
     * 200 paid orders and 26.4m litres in sixty days where nobody earns
     * anything today.
     */
    const unrated = await client`
      SELECT p.id FROM products p
       WHERE NOT EXISTS (
         SELECT 1 FROM depot_product_commissions d
          WHERE d.depot_id = ${depotId} AND d.product_id = p.id)
       LIMIT 1`;
    if (!unrated.length) return t.skip("every product at this depot has a rate");

    await customerRepo.update(customerId, { commissionRate: "2.00" });
    const { rate, source } = await commissionService.resolveRate({
      customerId, depotId, productId: Number(unrated[0].id),
    });
    assert.equal(rate, null, "no depot rate means no commission, agreement or not");
    assert.equal(source, "depot_product");
  });

  test("an agreed rate of zero is an agreement, not an absence", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    // The defect this pins: `customer.commissionRate || depotRate` reads 0 as
    // missing and pays ₦1.00 to a customer explicitly given nothing.
    await commissionRepo.upsertRate(depotId, productId, 1);
    await customerRepo.update(customerId, { commissionRate: "0.00" });

    const { rate, source } = await commissionService.resolveRate({
      customerId, depotId, productId,
    });
    assert.equal(rate, 0);
    assert.equal(source, "customer", "it came from the customer, not from a missing depot rate");
  });

  test("a depot rate edit does NOT sweep an agreed rate away", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");

    /*
     * The single way this feature breaks silently. findPendingFor selects
     * every pending row at a depot and knows nothing about who bought, so
     * without the guard the first Warri/PMS adjustment quietly rewrites every
     * ₦2.00 customer down to ₦1.00 — no error, nothing on the page.
     */
    await customerRepo.update(customerId, { commissionRate: "2.00" });
    await customerRepo.update(plainCustomerId, { commissionRate: null });

    const order = await client`
      SELECT id FROM orders WHERE depot_id = ${depotId} AND product_id = ${productId} LIMIT 1`;
    if (!order.length) return t.skip("no order at this depot and product");

    const [agreed] = await client`
      INSERT INTO commissions (order_id, customer_id, depot_id, product_id, quantity,
                               commission_rate, commission_amount, status, rate_source)
      VALUES (${order[0].id}, ${customerId}, ${depotId}, ${productId}, 1000,
              '2.00', '2000.00', 'pending', 'customer')
      RETURNING id`;
    const [ordinary] = await client`
      INSERT INTO commissions (order_id, customer_id, depot_id, product_id, quantity,
                               commission_rate, commission_amount, status, rate_source)
      VALUES (${order[0].id}, ${plainCustomerId}, ${depotId}, ${productId}, 1000,
              '0.50', '500.00', 'pending', 'depot_product')
      RETURNING id`;

    try {
      await commissionRepo.upsertRate(depotId, productId, 1);
      const result = await commissionService.recomputeForRate(depotId, productId);
      assert.ok(result.skipped >= 1, "the agreed row was skipped, not repriced");

      const after = await client`
        SELECT id, commission_rate::text AS rate, rate_source FROM commissions
         WHERE id IN (${agreed.id}, ${ordinary.id})`;
      const byId = new Map(after.map((r) => [Number(r.id), r]));

      assert.equal(byId.get(Number(agreed.id)).rate, "2.00", "₦2.00 customer untouched");
      assert.equal(byId.get(Number(agreed.id)).rate_source, "customer");
      assert.equal(byId.get(Number(ordinary.id)).rate, "1.00", "ordinary customer repriced");
    } finally {
      await client`DELETE FROM commissions WHERE id IN (${agreed.id}, ${ordinary.id})`;
    }
  });

  test("changing the agreed rate reprices what is already waiting", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const order = await client`
      SELECT id FROM orders WHERE depot_id = ${depotId} AND product_id = ${productId} LIMIT 1`;
    if (!order.length) return t.skip("no order at this depot and product");

    await customerRepo.update(customerId, { commissionRate: "2.00" });
    const [row] = await client`
      INSERT INTO commissions (order_id, customer_id, depot_id, product_id, quantity,
                               commission_rate, commission_amount, status, rate_source)
      VALUES (${order[0].id}, ${customerId}, ${depotId}, ${productId}, 1000,
              '1.00', '1000.00', 'pending', 'depot_product')
      RETURNING id`;

    try {
      await commissionService.recomputeForCustomer(customerId);
      const [after] = await client`
        SELECT commission_rate::text AS rate, commission_amount::text AS amount, rate_source
          FROM commissions WHERE id = ${row.id}`;
      assert.equal(after.rate, "2.00");
      assert.equal(after.amount, "2000.00", "the amount follows the rate");
      assert.equal(after.rate_source, "customer");

      // Clearing sends them back to the depot's rate — not to zero. "No
      // agreement" means the usual rate applies.
      await customerRepo.update(customerId, { commissionRate: null });
      await commissionService.recomputeForCustomer(customerId);
      const [cleared] = await client`
        SELECT commission_rate::text AS rate, rate_source FROM commissions WHERE id = ${row.id}`;
      assert.equal(cleared.rate, "1.00");
      assert.equal(cleared.rate_source, "depot_product");
    } finally {
      await client`DELETE FROM commissions WHERE id = ${row.id}`;
    }
  });

  test("a paid commission is never repriced by either sweep", async (t) => {
    if (!ready) return t.skip("schema or fixtures unavailable");
    const order = await client`
      SELECT id FROM orders WHERE depot_id = ${depotId} AND product_id = ${productId} LIMIT 1`;
    if (!order.length) return t.skip("no order at this depot and product");

    await customerRepo.update(customerId, { commissionRate: "2.00" });
    const [paid] = await client`
      INSERT INTO commissions (order_id, customer_id, depot_id, product_id, quantity,
                               commission_rate, commission_amount, status, rate_source, paid_at)
      VALUES (${order[0].id}, ${customerId}, ${depotId}, ${productId}, 1000,
              '0.50', '500.00', 'paid', 'depot_product', now())
      RETURNING id`;

    try {
      await commissionService.recomputeForCustomer(customerId);
      await commissionService.recomputeForRate(depotId, productId);
      const [after] = await client`
        SELECT commission_rate::text AS rate FROM commissions WHERE id = ${paid.id}`;
      // That money has left. Repricing history is a rewrite, not a
      // recalculation.
      assert.equal(after.rate, "0.50");
    } finally {
      await client`DELETE FROM commissions WHERE id = ${paid.id}`;
    }
  });
});

/**
 * The endpoint the desk uses, over HTTP.
 *
 * A new route on this router is closed by default (config/apiPermissions), and
 * /customer-rates has to be matched ABOVE /:id or the id route answers for it
 * — both are silent failures that only show up here.
 */
describe("the customer rate endpoints", () => {
  const request = require("supertest");
  const app = require("../app");
  const { staffToken } = require("./helpers");

  after(async () => {
    await closeDb();
  });

  test("the list is reachable and is not swallowed by GET /:id", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .get("/api/commissions/customer-rates")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.data.rates));
  });

  test("a rate is set and cleared through the API", async () => {
    const token = await staffToken(request, app);
    const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    if (!c) return;

    const set = await request(app)
      .post("/api/commissions/customer-rate")
      .set("Authorization", `Bearer ${token}`)
      .send({ customerId: Number(c.id), commissionRate: 2 });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const [after] = await client`SELECT commission_rate::text AS r FROM customers WHERE id = ${c.id}`;
    assert.equal(after.r, "2.00");

    const cleared = await request(app)
      .post("/api/commissions/customer-rate")
      .set("Authorization", `Bearer ${token}`)
      .send({ customerId: Number(c.id), commissionRate: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

    const [gone] = await client`SELECT commission_rate FROM customers WHERE id = ${c.id}`;
    assert.equal(gone.commission_rate, null, "null clears the agreement, it does not write 0");
  });

  test("a negative rate is refused", async () => {
    const token = await staffToken(request, app);
    const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    if (!c) return;
    const res = await request(app)
      .post("/api/commissions/customer-rate")
      .set("Authorization", `Bearer ${token}`)
      .send({ customerId: Number(c.id), commissionRate: -1 });
    assert.equal(res.status, 400);
  });
});
