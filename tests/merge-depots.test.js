require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * scripts/merge-depots.js — one depot's everything under another.
 *
 *   dry run   says what would change and changes nothing
 *   apply     orders and PFIs move; a price the second depot already has is
 *             kept once; text naming the first depot names the second; the
 *             first depot is gone; every old value is in the undo table
 */
const RUN = String(Date.now()).slice(-6);

describe("merging depots", () => {
  let from;
  let into;
  let orderId;
  let pfiId;
  let saleId;
  let productId;
  let customerId;

  const script = (...args) => execFileSync(process.execPath, [path.join(__dirname, "../scripts/merge-depots.js"), ...args], {
    env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8",
  });

  before(async () => {
    productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depot = async (name) => Number((await client`
      INSERT INTO depots (name, code, address, city, state, country, postcode, max_capacity, established_year, status)
      VALUES (${name}, ${`DM${RUN}${name[6]}`}, 'Test', 'Lagos', 'Lagos', 'Nigeria', '100001', 1000, '2026', 'Active') RETURNING id`)[0].id);
    from = await depot(`Merge From ${RUN}`);
    into = await depot(`Merge Into ${RUN}`);
    for (const d of [from, into]) {
      await client`INSERT INTO depot_product_prices (depot_id, product_id, current_price) VALUES (${d}, ${productId}, 1000)`;
    }
    const [staff] = await client`SELECT id FROM staff ORDER BY id LIMIT 1`;
    await client`INSERT INTO depot_staff (depot_id, staff_id) VALUES (${from}, ${staff.id})`;
    [{ id: customerId }] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Depot Merge ${RUN}`}, ${`+23487${String(RUN).padStart(8, "0")}`}, 'Active', 'Depot Merge Co') RETURNING id`;
    [{ id: orderId }] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price, total_amount, delivery_type, company_name)
      VALUES (${`DM${RUN}`}, ${customerId}, 'Lagos', ${from}, ${productId}, 1000, 1000, 1000000, 'pickup', 'Depot Merge Co') RETURNING id`;
    [{ id: pfiId }] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, location_id, location_name)
      VALUES (${`DMERGE/${RUN}`}, 'coastal', 'finished', 1000, 300, ${from}, ${`Merge From ${RUN}`}) RETURNING id`;
    [{ id: saleId }] = await client`
      INSERT INTO delivery_sales (customer_name, depot_loaded, quantity) VALUES ('x', ${`Merge From ${RUN} Ticket`}, 1) RETURNING id`;
  });

  after(async () => {
    await client`DELETE FROM delivery_sales WHERE id = ${saleId}`;
    await client`DELETE FROM pfis WHERE id = ${pfiId}`;
    await client`DELETE FROM orders WHERE id = ${orderId}`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
    await client`DELETE FROM audit_logs WHERE entity_type = 'depot' AND entity_id = ${into}`;
    await client`DELETE FROM depots WHERE id IN (${from}, ${into})`;
    await client.unsafe(`DROP TABLE IF EXISTS depot_merge_${from}_into_${into}`);
    await closeDb();
  });

  test("a dry run says what would change and changes nothing", async () => {
    const out = script("--from", String(from), "--into", String(into));
    assert.match(out, /orders: 1 moved/);
    assert.match(out, /depot_product_prices: 0 moved, 1 dropped/);
    assert.match(out, /Dry run/);
    const [o] = await client`SELECT depot_id FROM orders WHERE id = ${orderId}`;
    assert.equal(Number(o.depot_id), from);
  });

  test("applied: everything falls under the second depot, and the first is gone", async () => {
    script("--from", String(from), "--into", String(into), "--text", `Merge From ${RUN} Ticket`, "--apply");
    const [o] = await client`SELECT depot_id FROM orders WHERE id = ${orderId}`;
    assert.equal(Number(o.depot_id), into);
    const [p] = await client`SELECT location_id, location_name FROM pfis WHERE id = ${pfiId}`;
    assert.equal(Number(p.location_id), into);
    assert.equal(p.location_name, `Merge Into ${RUN}`);
    const [s] = await client`SELECT depot_loaded FROM delivery_sales WHERE id = ${saleId}`;
    assert.equal(s.depot_loaded, `Merge Into ${RUN}`);
    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM depot_product_prices WHERE depot_id = ${into} AND product_id = ${productId}`;
    assert.equal(n, 1, "the price is kept once");
    const [{ staffHere }] = await client`SELECT COUNT(*)::int AS "staffHere" FROM depot_staff WHERE depot_id = ${into}`;
    assert.equal(staffHere, 1, "the staff assignment moved");
    assert.equal((await client`SELECT id FROM depots WHERE id = ${from}`).length, 0);
    const undo = await client.unsafe(`SELECT tbl, col, old_value FROM depot_merge_${from}_into_${into}`);
    assert.ok(undo.some((u) => u.tbl === "orders" && u.old_value === String(from)));
    assert.ok(undo.some((u) => u.tbl === "depots" && u.col === "*row*"));
  });
});
