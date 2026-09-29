// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { resetPricesForTheDay } = require("../services/priceReset.service");
const { PRICE_RESET_CRON } = require("../jobs/scheduler");
const { closeDb } = require("./helpers");

/**
 * The nightly price reset.
 *
 * What has to hold: every live price goes to 0, each one moved lands in the
 * price history, the audit row keeps what it was, and a second run changes
 * nothing. It runs at 23:59.
 *
 * The reset is global, and other suites price orders off this database — so
 * every price is put back exactly as it was when this file finishes.
 */
let saved = [];
let depotId;
let productId;

describe("Nightly price reset", () => {
  before(async () => {
    saved = await client`SELECT id, current_price FROM depot_product_prices`;
    // At least one live price, whatever the database held.
    const [d] = await client`SELECT id FROM depots ORDER BY id LIMIT 1`;
    const [p] = await client`SELECT id FROM products ORDER BY id LIMIT 1`;
    depotId = Number(d.id);
    productId = Number(p.id);
    await client`
      INSERT INTO depot_product_prices (depot_id, product_id, current_price)
      VALUES (${depotId}, ${productId}, 950)
      ON CONFLICT (depot_id, product_id) DO UPDATE SET current_price = 950`;
  });

  after(async () => {
    for (const row of saved) {
      await client`UPDATE depot_product_prices SET current_price = ${row.current_price} WHERE id = ${row.id}`;
    }
    await closeDb();
  });

  test("it runs at 23:59", () => {
    assert.equal(PRICE_RESET_CRON, "59 23 * * *");
  });

  test("every live price goes to 0, into the history, with the old figure on the audit row", async () => {
    const [{ n: live }] = await client`SELECT COUNT(*)::int AS n FROM depot_product_prices WHERE current_price <> 0`;
    const startedAt = new Date();

    const result = await resetPricesForTheDay();
    assert.equal(result.updated, live);

    const [{ n: left }] = await client`SELECT COUNT(*)::int AS n FROM depot_product_prices WHERE current_price <> 0`;
    assert.equal(left, 0);

    const [ours] = await client`
      SELECT id FROM depot_product_prices WHERE depot_id = ${depotId} AND product_id = ${productId}`;
    const history = await client`
      SELECT price FROM depot_price_history
       WHERE depot_product_price_id = ${ours.id} AND set_at >= ${startedAt.toISOString()}`;
    assert.ok(history.some((h) => Number(h.price) === 0), "the zero is in the price history");

    const [audit] = await client`
      SELECT actor_type, metadata FROM audit_logs
       WHERE action = 'depot.prices_zeroed_nightly' AND created_at >= ${startedAt.toISOString()}
       ORDER BY created_at DESC LIMIT 1`;
    assert.equal(audit.actor_type, "system");
    const before = audit.metadata.before.find(
      (b) => Number(b.depotId) === depotId && Number(b.productId) === productId,
    );
    assert.equal(Number(before.price), 950);
  });

  test("a second run changes nothing and writes no audit row", async () => {
    const startedAt = new Date();
    const result = await resetPricesForTheDay();
    assert.equal(result.updated, 0);
    const rows = await client`
      SELECT id FROM audit_logs WHERE action = 'depot.prices_zeroed_nightly' AND created_at >= ${startedAt.toISOString()}`;
    assert.equal(rows.length, 0);
  });
});
