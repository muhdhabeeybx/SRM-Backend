// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis, depots, products, orders, bankAccounts, bankStatements, bankStatementLines } = require("../db/schema");
const orderService = require("../services/order.service");
const { closeDb, staffToken, ensureTestCustomer } = require("./helpers");

/**
 * A PFI's collections open date, as a rule on the credits offered for it.
 *
 * One account collects for many PFIs, so a credit dated before a PFI opened
 * most likely paid for an earlier cargo. The user, 20 Oct 2026: seeing those
 * when matching a payment is "confusing and very risky". So the picker's
 * search leaves them out when it is told the order or the PFI, with no way to
 * ask for them back, and confirming an order's payment refuses one outright.
 */
const RUN = Date.now();
const OPENS = "2026-10-01";

let admin;
let depot;
let product;
let pfi;
let account;
let statement;
let order;
const lines = {};

const line = async (tag, txnDate) => {
  const [row] = await db.insert(bankStatementLines).values({
    statementId: statement.id, bankAccountId: account.id, txnDate, amount: "1000",
    depositor: `WINDOW ${tag}`, narration: `window ${tag} ${RUN}`, bankRef: `WIN-${RUN}-${tag}`,
    dedupKey: `WIN-${RUN}-${tag}`, status: "UNMATCHED",
  }).returning();
  return row;
};

const search = (params) =>
  request(app)
    .get("/api/bank-statements/lines")
    .query({ bankAccountId: account.id, limit: "all", ...params })
    .set("Authorization", `Bearer ${admin}`);

const ids = (res) => res.body.data.lines.map((l) => Number(l.id)).sort((a, b) => a - b);

describe("credits from before a PFI's collections open date", () => {
  before(async () => {
    admin = await staffToken(request, app);
    const customer = await ensureTestCustomer();
    [depot] = await db.insert(depots).values({
      name: `Window Depot ${RUN}`, code: `WD${RUN}`.slice(-12), address: "1 Rd",
      city: "Lagos", state: "Lagos", country: "NG", postcode: "100001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS W ${RUN}`, sku: `WN${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    [pfi] = await db.insert(pfis).values({
      pfiNumber: `PFI/WIN/${RUN}`, status: "active", startingQtyLitres: 100000,
      locationId: depot.id, productId: product.id, collectionsOpenFrom: OPENS,
    }).returning();
    [account] = await db.insert(bankAccounts).values({
      bankName: "Test Bank", accountName: `WINDOW TEST ${RUN}`, accountNumber: `8${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [pfi.id],
    }).returning();
    [statement] = await db.insert(bankStatements)
      .values({ bankAccountId: account.id, filename: `window-${RUN}.csv` }).returning();
    [order] = await db.insert(orders).values({
      orderNumber: `ORD-WIN-${RUN}`, customerId: customer.id, state: "Lagos",
      depotId: depot.id, productId: product.id, pfiId: pfi.id,
      quantity: 1, price: "1000", totalAmount: "1000", deliveryType: "pickup",
    }).returning();

    lines.before = await line("before", "2026-09-30");
    lines.opening = await line("opening", OPENS);
    lines.after = await line("after", "2026-10-05");
  });

  after(async () => {
    try {
      await client`DELETE FROM order_payments WHERE order_id = ${order.id}`;
      await client`DELETE FROM audit_logs WHERE entity_id = ${String(order.id)} AND entity_type = 'order'`.catch(() => {});
      await client`DELETE FROM orders WHERE id = ${order.id}`;
      await client`DELETE FROM bank_statement_lines WHERE bank_account_id = ${account.id}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${account.id}`;
      await client`DELETE FROM bank_accounts WHERE id = ${account.id}`;
      await client`DELETE FROM pfis WHERE id = ${pfi.id}`;
      await client`DELETE FROM depots WHERE id = ${depot.id}`;
      await client`DELETE FROM products WHERE id = ${product.id}`;
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  test("paying an order: only credits from the open date on, and the date says so as a day", async () => {
    const res = await search({ orderId: order.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(ids(res), [lines.opening.id, lines.after.id].sort((a, b) => a - b));
    assert.deepEqual(res.body.data.window, { pfiNumber: pfi.pfiNumber, opensFrom: OPENS });
  });

  test("a truck's or station load's PFI narrows it the same way", async () => {
    const res = await search({ pfiId: pfi.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(ids(res), [lines.opening.id, lines.after.id].sort((a, b) => a - b));
  });

  test("there is no way to ask for the earlier ones back", async () => {
    const res = await search({ orderId: order.id, includeEarlier: "true" });
    assert.ok(!ids(res).includes(lines.before.id), "an earlier credit came back with includeEarlier");
  });

  test("with no order or PFI named, the whole account is offered", async () => {
    const res = await search({});
    assert.ok(ids(res).includes(lines.before.id));
    assert.equal(res.body.data.window, null);
  });

  test("confirming an order with an earlier credit is refused, and the credit stays in the pool", async () => {
    await assert.rejects(
      orderService.confirmOrderPayment({
        orderId: order.id, bankAccountId: account.id, lineIds: [lines.before.id],
        actor: { type: "system" }, notifyWhatsApp: false,
      }),
      (err) => {
        assert.equal(err.status ?? err.statusCode, 409);
        assert.match(err.message, /dated 2026-09-30, before PFI\/WIN\/\d+'s collections opened on 2026-10-01/);
        return true;
      },
    );
    const [row] = await client`SELECT status FROM bank_statement_lines WHERE id = ${lines.before.id}`;
    assert.equal(row.status, "UNMATCHED");
    const paid = await client`SELECT id FROM order_payments WHERE order_id = ${order.id}`;
    assert.equal(paid.length, 0);
  });

  test("a credit dated on the open date itself is taken", async () => {
    await orderService.confirmOrderPayment({
      orderId: order.id, bankAccountId: account.id, lineIds: [lines.opening.id],
      actor: { type: "system" }, notifyWhatsApp: false,
    });
    const [row] = await client`SELECT status FROM bank_statement_lines WHERE id = ${lines.opening.id}`;
    assert.equal(row.status, "MATCHED");
  });
});
