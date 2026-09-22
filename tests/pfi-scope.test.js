require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * A person assigned to a PFI sees that PFI's world, and nothing else.
 *
 * Proven the only way that counts: a real staff member, genuinely confined —
 * no "see all locations", one PFI — asking the running API for another PFI's
 * data in every area, and getting none of it. An unrestricted person asks the
 * same questions alongside, so a filter that simply returned nothing to
 * anybody would fail here rather than pass.
 */
describe("staff assigned to a PFI see only that PFI", () => {
  const RUN = Date.now();
  const tag = String(RUN).slice(-7);
  let mine, other, custMine, custOther, orderMine, orderOther, saleMine, saleOther, reportOther;
  let confined, confinedId, everyone;
  let ready = false;

  const CODE_MINE = `SCOPE-M${tag}`;
  const CODE_OTHER = `SCOPE-O${tag}`;

  before(async () => {
    try {
      const pfi = async (n) => {
        const [p] = await client`
          INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
          VALUES (${`SCOPE/${n}/${RUN}`}, 'coastal', 'active', 1000000, '300') RETURNING id, pfi_number`;
        return p;
      };
      mine = await pfi("MINE");
      other = await pfi("OTHER");

      const customer = async (n) => {
        const [c] = await client`
          INSERT INTO customers (name, phone, company_name)
          VALUES (${`Scope ${n} ${RUN}`}, ${"0" + String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}, ${`Scope ${n} Co`})
          RETURNING id, name`;
        return c;
      };
      custMine = await customer("Mine");
      custOther = await customer("Other");

      const order = async (customerId, pfiId) => {
        const [o] = await client`
          INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                              price, total_amount, delivery_type, company_name, pfi_id)
          SELECT ${"SP" + Math.floor(Math.random() * 1e9)}, ${customerId}, 'Lagos', d.id, p.id, 1000,
                 1000, 1000000, 'pickup', 'Scope Co', ${pfiId}
            FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
          RETURNING id`;
        // Overpaid, so it appears among refunds.
        await client`
          INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
          VALUES (${o.id}, 1250000, 'statement', now(), 'Test', 'scope', ${"SP" + o.id})`;
        return Number(o.id);
      };
      orderMine = await order(custMine.id, mine.id);
      orderOther = await order(custOther.id, other.id);

      // A batch on each PFI, and a truck sale on each.
      await client`
        INSERT INTO delivery_inventory (allocation_code, truck_number, pfi_id, quantity_allocated, loading_status)
        VALUES (${CODE_MINE}, 'SCOPE1', ${mine.id}, 45000, 'loaded'),
               (${CODE_OTHER}, 'SCOPE2', ${other.id}, 45000, 'loaded')`;
      const sale = async (code, truck) => {
        const [s] = await client`
          INSERT INTO delivery_sales (truck_number, date_loaded, allocation_code, customer_name, quantity)
          VALUES (${truck}, '2026-09-21', ${code}, 'Scope', 45000) RETURNING id`;
        return Number(s.id);
      };
      saleMine = await sale(CODE_MINE, "SCOPE1");
      saleOther = await sale(CODE_OTHER, "SCOPE2");

      const [r] = await client`
        INSERT INTO daily_reports (report_date, location, pfi_number)
        VALUES ('2026-09-21', 'Scope Depot', ${other.pfi_number}) RETURNING id`;
      reportOther = Number(r.id);

      everyone = await staffToken(request, app);
      const s = await staffTokenWithRoles(["admin", "finance"], `pfi-scope-${RUN}@soroman.test`);
      confinedId = Number(s.staff.id);
      confined = s.accessToken;
      await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
      await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${mine.id}, ${confinedId})`;
      ready = true;
    } catch (e) {
      console.error("pfi-scope fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
      await client`DELETE FROM daily_reports WHERE id = ${reportOther}`;
      await client`DELETE FROM delivery_sales WHERE id = ANY(${[saleMine, saleOther]})`;
      await client`DELETE FROM delivery_inventory WHERE allocation_code = ANY(${[CODE_MINE, CODE_OTHER]})`;
      await client`DELETE FROM order_refunds WHERE order_id = ANY(${[orderMine, orderOther]})`;
      await client`DELETE FROM order_payments WHERE order_id = ANY(${[orderMine, orderOther]})`;
      await client`DELETE FROM orders WHERE id = ANY(${[orderMine, orderOther]})`;
      await client`DELETE FROM customers WHERE id = ANY(${[custMine.id, custOther.id]})`;
      await client`DELETE FROM pfis WHERE id = ANY(${[mine.id, other.id]})`;
    }
    await closeDb();
  });

  const as = (token) => ({
    get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
    post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
    del: (url) => request(app).delete(url).set("Authorization", `Bearer ${token}`),
  });
  const skip = (t) => !ready && t.skip("fixtures unavailable");

  // ── Refunds ─────────────────────────────────────────────────────────────

  test("refunds: only their PFI's overpaid orders", async (t) => {
    if (skip(t)) return;
    const res = await as(confined).get("/api/order-refunds/refundable?limit=1000");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.data.orders.map((o) => o.orderId);
    assert.ok(ids.includes(orderMine), "their own");
    assert.ok(!ids.includes(orderOther), "not another PFI's");

    const all = await as(everyone).get("/api/order-refunds/refundable?limit=1000");
    assert.ok(all.body.data.orders.map((o) => o.orderId).includes(orderOther), "an unrestricted person still sees it");
  });

  test("refunds: cannot act on another PFI's order", async (t) => {
    if (skip(t)) return;
    const res = await as(confined).post("/api/order-refunds/skip", { orderId: orderOther, reason: "test" });
    assert.equal(res.status, 404);
  });

  // ── Truck sales ─────────────────────────────────────────────────────────

  test("truck sales: only their batches'", async (t) => {
    if (skip(t)) return;
    const res = await as(confined).get("/api/delivery-sales?limit=1000");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = (res.body.data.sales || []).map((s) => Number(s.id));
    assert.ok(ids.includes(saleMine));
    assert.ok(!ids.includes(saleOther));
  });

  test("truck sales: another PFI's sale is not found, and cannot be deleted", async (t) => {
    if (skip(t)) return;
    assert.equal((await as(confined).get(`/api/delivery-sales/${saleOther}`)).status, 404);
    assert.equal((await as(confined).del(`/api/delivery-sales/${saleOther}`)).status, 404);
    const [{ n }] = await client`SELECT count(*)::int AS n FROM delivery_sales WHERE id = ${saleOther}`;
    assert.equal(n, 1, "still there");
  });

  test("delivery batches: only their batches' statuses", async (t) => {
    if (skip(t)) return;
    await client`INSERT INTO delivery_batches (code, status) VALUES (${CODE_OTHER}, 'completed')
                 ON CONFLICT (code) DO NOTHING`;
    const res = await as(confined).get("/api/delivery-inventory/batches");
    assert.equal(res.status, 200);
    assert.ok(!Object.keys(res.body.data.batches || {}).includes(CODE_OTHER));
    await client`DELETE FROM delivery_batches WHERE code = ${CODE_OTHER}`;
  });

  // ── Customers ───────────────────────────────────────────────────────────

  test("customers: browsing shows only their PFI's customers", async (t) => {
    if (skip(t)) return;
    const res = await as(confined).get("/api/customers?limit=5000");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.data.customers.map((c) => Number(c.id));
    assert.ok(ids.includes(Number(custMine.id)));
    assert.ok(!ids.includes(Number(custOther.id)));
  });

  test("customers: a search finds anyone to order for, but only as a name", async (t) => {
    if (skip(t)) return;
    const res = await as(confined).get(`/api/customers?search=${encodeURIComponent(custOther.name)}`);
    assert.equal(res.status, 200);
    const hit = res.body.data.customers.find((c) => Number(c.id) === Number(custOther.id));
    assert.ok(hit, "findable, so an order can be raised");
    assert.equal(hit.outsideYourPfi, true);
    assert.equal(hit.balance, null, "no balance");
    assert.equal(hit.email, undefined, "no email");
  });

  test("customers: another PFI's customer, their phones and licences are not found", async (t) => {
    if (skip(t)) return;
    assert.equal((await as(confined).get(`/api/customers/${custOther.id}`)).status, 404);
    assert.equal((await as(confined).get(`/api/customers/${custOther.id}/phones`)).status, 404);
    assert.equal((await as(everyone).get(`/api/customers/${custOther.id}`)).status, 200);
  });

  // ── Daily reports ───────────────────────────────────────────────────────

  test("daily reports: another PFI's report is not found", async (t) => {
    if (skip(t)) return;
    assert.equal((await as(confined).get(`/api/daily-reports/${reportOther}`)).status, 404);
    const list = await as(confined).get("/api/daily-reports?limit=1000");
    assert.equal(list.status, 200);
    const ids = (list.body.data.reports || list.body.data.dailyReports || []).map((r) => Number(r.id));
    assert.ok(!ids.includes(reportOther));
  });

  // ── Areas with no PFI link: refused outright ────────────────────────────

  for (const url of [
    "/api/contacts",
    "/api/people",
    "/api/offline-sales",
    "/api/filing-stations",
    "/api/dangote-order-requests",
    "/api/dashboard/overview",
    "/api/dashboard/stats",
    "/api/dashboard/activity",
    "/api/dashboard/desk-nudges",
  ]) {
    test(`${url} is refused to a PFI's staff`, async (t) => {
      if (skip(t)) return;
      const res = await as(confined).get(url);
      assert.equal(res.status, 403, `${url} → ${res.status}`);
    });
  }

  test("their own work queues still load", async (t) => {
    if (skip(t)) return;
    const res = await as(confined).get("/api/dashboard/work-queues");
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("an unrestricted person is refused none of it", async (t) => {
    if (skip(t)) return;
    for (const url of ["/api/contacts", "/api/dashboard/overview", "/api/offline-sales"]) {
      const res = await as(everyone).get(url);
      assert.notEqual(res.status, 403, `${url} → ${res.status}`);
    }
  });
});
