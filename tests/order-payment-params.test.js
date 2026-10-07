// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { staffToken, closeDb } = require("./helpers");
const orderSchemas = require("../schemas/order.schema");

/**
 * The second path param on the payment routes has to survive validation.
 *
 * `validate({ params })` replaces req.params with what the schema returns, and
 * Zod strips whatever the schema does not declare — that stripping is the
 * whitelist which closes mass assignment, so it is not going away. Four routes
 * carrying two params were validated against `idParam`, which declares only
 * `id`, so `paymentId` and `transferId` were deleted on the way to the
 * controller.
 *
 * What that looked like from the desk: every attempt to unmatch a payment came
 * back a flat 400. Nothing in the message mentioned an id — the controller read
 * `undefined`, `Number(undefined)` produced NaN, Postgres refused NaN as an
 * integer (SQLSTATE 22P02) and the error handler renders that as "Invalid
 * identifier or value". The correction path for a mis-matched payment was
 * simply unusable, which is why it had to be done by hand against the database.
 *
 * A 404 here is the PASSING result: it means the id arrived intact and the
 * service looked for a payment that genuinely does not exist. A 400 means it
 * was stripped again.
 */
describe("order payment routes — the id in the path must reach the controller", () => {
  after(async () => {
    await closeDb();
  });

  test("unmatching a payment reports it missing, not an invalid id", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .delete("/api/orders/1/payments/99999999")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "regression check" });

    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.match(res.body.message, /not found/i);
  });

  test("reversing a transfer straight away is retired — it is requested and approved", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .delete("/api/orders/1/payments/transfer/99999999")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    assert.equal(res.status, 410, JSON.stringify(res.body));
  });

  test("reviewing a payment reports it missing, not an invalid id", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .post("/api/orders/1/payments/99999999/review")
      .set("Authorization", `Bearer ${token}`)
      .send({ note: "regression check, long enough to pass the floor" });

    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  test("a genuinely malformed id is still rejected", async () => {
    // The whitelist still has to do its job — this must not become a 404.
    const token = await staffToken(request, app);
    const res = await request(app)
      .delete("/api/orders/1/payments/not-a-number")
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "regression check" });

    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  test("the schemas declare both params", () => {
    // Guards the shape directly, so the reason the routes work is visible
    // without reading the router.
    assert.deepEqual(
      Object.keys(orderSchemas.paymentParam.shape).sort(),
      ["id", "paymentId"]
    );
    assert.deepEqual(
      Object.keys(orderSchemas.transferParam.shape).sort(),
      ["id", "transferId"]
    );
  });
});
