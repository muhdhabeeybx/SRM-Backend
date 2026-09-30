// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Any desk may read, create and edit a customer — the app is open by design.
 * What is held back is what hands over an account or cannot be undone:
 * deleting a customer, the numbers it signs in on, its main number, and the
 * money fields on the record.
 */
const RUN = Date.now();
const phone = (n) => `+23480${String(RUN).slice(-7)}${n}`.slice(0, 14);

describe("customer records — what any desk may do, and what it may not", () => {
  let desk;
  let admin;
  let superAdmin;
  let customerId;

  const call = (token, method, url, body = {}) =>
    request(app)[method](url).set("Authorization", `Bearer ${token}`).send(body);

  before(async () => {
    desk = (await staffTokenWithRoles(["sales_manager"], `cg-desk-${RUN}@soroman.test`)).accessToken;
    admin = (await staffTokenWithRoles(["admin"], `cg-adm-${RUN}@soroman.test`)).accessToken;
    superAdmin = (await staffTokenWithRoles(["super_admin"], `cg-sup-${RUN}@soroman.test`)).accessToken;
    const [c] = await client`
      INSERT INTO customers (name, phone, email, company_name, status, balance, deposit, previous_deposit)
      VALUES ('Gate Test Customer', ${phone(1)}, '', 'Gate Co', 'Active', 0, 0, 0) RETURNING id`;
    customerId = Number(c.id);
  });

  after(async () => {
    await client`DELETE FROM customer_phones WHERE customer_id = ${customerId}`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
    await closeDb();
  });

  test("a desk edits the name, and saving the same number back is not a change", async () => {
    const res = await call(desk, "patch", `/api/customers/${customerId}`, {
      name: "Gate Test Customer Ltd", phone: phone(1).replace("+234", "0"),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [log] = await client`SELECT metadata FROM audit_logs
      WHERE entity_type = 'customer' AND entity_id = ${customerId} AND action = 'customer.updated' ORDER BY id DESC LIMIT 1`;
    assert.ok(log, "the edit is on the audit log");
    assert.deepEqual(Object.keys(log.metadata.changes), ["name"]);
  });

  test("a desk may not change the main number, the money on the record, or the sign-in numbers", async () => {
    let res = await call(desk, "patch", `/api/customers/${customerId}`, { phone: phone(2) });
    assert.equal(res.status, 403);
    res = await call(desk, "patch", `/api/customers/${customerId}`, { balance: 5000000 });
    assert.equal(res.status, 403);
    res = await call(desk, "post", `/api/customers/${customerId}/phones`, { phone: phone(3) });
    assert.equal(res.status, 403);
    res = await call(desk, "delete", `/api/customers/${customerId}`);
    assert.equal(res.status, 403);
  });

  test("an admin adds a sign-in number, and it is on the audit log", async () => {
    const res = await call(admin, "post", `/api/customers/${customerId}/phones`, { phone: phone(3) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [log] = await client`SELECT actor_staff_id FROM audit_logs
      WHERE entity_type = 'customer' AND entity_id = ${customerId} AND action = 'customer.phone_added' ORDER BY id DESC LIMIT 1`;
    assert.ok(log);
  });

  test("only a super admin changes the balance, or deletes", async () => {
    let res = await call(admin, "patch", `/api/customers/${customerId}`, { balance: 1000 });
    assert.equal(res.status, 403);
    res = await call(admin, "delete", `/api/customers/${customerId}`);
    assert.equal(res.status, 403);
    res = await call(superAdmin, "patch", `/api/customers/${customerId}`, { balance: 1000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("a desk may not open a customer with money already on it", async () => {
    const res = await call(desk, "post", "/api/customers", { name: "Opening Balance", phone: phone(4), balance: 250000 });
    assert.equal(res.status, 403);
  });
});
