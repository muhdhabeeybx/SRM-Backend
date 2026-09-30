// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * The acts that move money, change a cargo or open an account are refused on
 * the server to anybody without the role — not merely hidden on the screen.
 *
 * Each call below uses an id that does not exist, so a caller who IS allowed
 * gets past the gate and is answered by the handler (404/400/422), while one
 * who is not is stopped at the gate with 403 before anything is looked up.
 */
const RUN = Date.now();
const NOPE = 999999999;

let desk;      // a gate officer: none of these are theirs
let finance;
let admin;

const call = (token, method, url, body = {}) =>
  request(app)[method](url).set("Authorization", `Bearer ${token}`).send(body);

describe("enforced roles on the acts that matter", () => {
  before(async () => {
    desk = (await staffTokenWithRoles(["security_entry"], `gate-desk-${RUN}@soroman.test`)).accessToken;
    finance = (await staffTokenWithRoles(["finance"], `gate-fin-${RUN}@soroman.test`)).accessToken;
    admin = (await staffTokenWithRoles(["admin"], `gate-adm-${RUN}@soroman.test`)).accessToken;
  });

  after(async () => {
    await closeDb();
  });

  const refused = async (token, method, url, body) => {
    const res = await call(token, method, url, body);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${url} must be refused: ${JSON.stringify(res.body)}`);
  };
  const passes = async (token, method, url, body) => {
    const res = await call(token, method, url, body);
    assert.notEqual(res.status, 403, `${method.toUpperCase()} ${url} must get past the gate: ${JSON.stringify(res.body)}`);
  };

  test("a desk officer is refused every one of them", async () => {
    await refused(desk, "delete", `/api/pfis/${NOPE}`);
    await refused(desk, "post", `/api/pfis/${NOPE}/activate`);
    await refused(desk, "post", `/api/pfis/${NOPE}/start`);
    await refused(desk, "post", `/api/depots/price-changes/${NOPE}/approve`);
    await refused(desk, "post", `/api/depots/price-changes/${NOPE}/reject`);
    await refused(desk, "post", `/api/orders/${NOPE}/payments`, { bankAccountId: 1, lineIds: [1] });
    await refused(desk, "delete", `/api/orders/${NOPE}/payments/1`, { reason: "x" });
    await refused(desk, "patch", `/api/order-refunds/${NOPE}/pay`, { paidFromAccountId: 1 });
    await refused(desk, "patch", `/api/order-refunds/${NOPE}/undo`, { reason: "x" });
    await refused(desk, "delete", `/api/orders/${NOPE}`);
    await refused(desk, "post", "/api/admin", { first_name: "A", surname: "B", email: `x-${RUN}@soroman.test` });
    await refused(desk, "delete", `/api/admin/${NOPE}`);
  });

  test("finance confirms payments and pays refunds, but does not approve prices or release PFIs", async () => {
    await passes(finance, "post", `/api/orders/${NOPE}/payments`, { bankAccountId: 1, lineIds: [1] });
    await passes(finance, "patch", `/api/order-refunds/${NOPE}/pay`, { paidFromAccountId: 1 });
    await refused(finance, "post", `/api/depots/price-changes/${NOPE}/approve`);
    await refused(finance, "post", `/api/pfis/${NOPE}/activate`);
    await refused(finance, "delete", `/api/pfis/${NOPE}`);
  });

  test("an admin approves prices, releases PFIs and records payments, but only a super admin deletes", async () => {
    await passes(admin, "post", `/api/depots/price-changes/${NOPE}/approve`);
    await passes(admin, "post", `/api/pfis/${NOPE}/activate`);
    await passes(admin, "post", `/api/orders/${NOPE}/payments`, { bankAccountId: 1, lineIds: [1] });
    await refused(admin, "delete", `/api/pfis/${NOPE}`);
    await refused(admin, "delete", `/api/orders/${NOPE}`);
    await refused(admin, "post", "/api/admin", { first_name: "A", surname: "B", email: `y-${RUN}@soroman.test` });
    await refused(admin, "patch", `/api/order-refunds/${NOPE}/pay`, { paidFromAccountId: 1 });
  });
});
