// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { depots, products, depotProductPrices, pfis } = require("../db/schema");
const { customerRepo, pfiRepo, bankAccountRepo, orderPfiAllocationRepo } = require("../repositories");
const { placeOrder } = require("../services/order.service");
const {
  staffTokenWithRoles, closeDb, seedLegacyHold, payOrderWithStatementLine, makeStatementLine,
} = require("./helpers");

const RUN = Date.now();
const UNIT_PRICE = 100;

describe("DELETE /api/orders/:id — hard delete must give the PFI its stock back", () => {
  let customerId;
  let depotId;
  let productId;
  let pfiId;
  let superStaff;
  let plainStaff;

  before(async () => {
    const [depot] = await db
      .insert(depots)
      .values({
        name: "Delete Depot",
        code: `DEL${String(RUN).slice(-5)}`,
        address: "1 Rd",
        city: "Lagos",
        state: "Lagos",
        country: "NG",
        postcode: "100001",
        maxCapacity: 10000000,
        establishedYear: "2020",
      })
      .returning();
    depotId = depot.id;

    await bankAccountRepo.create({
      bankName: "Test Bank",
      accountName: "Delete Depot Account",
      accountNumber: `DELACC${String(RUN).slice(-6)}`,
      depotIds: [depotId],
      status: "Active",
      isDefault: true,
    });

    const [product] = await db
      .insert(products)
      .values({ name: "Delete PMS", sku: `DEL-PMS-${String(RUN).slice(-5)}`, category: "PMS" })
      .returning();
    productId = product.id;

    await db.insert(depotProductPrices).values({ depotId, productId, currentPrice: String(UNIT_PRICE) });
    const [pfi] = await db
      .insert(pfis)
      .values({
        pfiNumber: `PFI-DEL-${RUN}`,
        status: "active",
        locationId: depotId,
        productId,
        startingQtyLitres: 2000000,
        soldQtyLitres: 0,
      })
      .returning();
    pfiId = pfi.id;

    const customer = await customerRepo.create({
      name: "Delete Customer",
      phone: `+234817${String(RUN).slice(-6)}9`,
      status: "Active",
    });
    customerId = customer.id;

    superStaff = await staffTokenWithRoles(["super_admin"], "test-delete-super@soroman.test");
    plainStaff = await staffTokenWithRoles(["ticketing"], "test-delete-plain@soroman.test");
  });

  after(async () => {
    await closeDb();
  });

  test("deleting an order releases its PFI reservation back to sold_qty_litres", async () => {
    const before = Number((await pfiRepo.findById(pfiId)).soldQtyLitres);

    const { order } = await placeOrder({
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity: 5000,
      deliveryType: "pickup",
      trucks: [],
    });

    const afterPlace = Number((await pfiRepo.findById(pfiId)).soldQtyLitres);
    assert.equal(afterPlace, before + 5000, "placing the order reserved its quantity");

    const allocations = await orderPfiAllocationRepo.findByOrderId(order.id);
    assert.ok(allocations.length > 0, "the order carries a PFI allocation to release");

    const res = await request(app)
      .delete(`/api/orders/${order.id}`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const afterDelete = Number((await pfiRepo.findById(pfiId)).soldQtyLitres);
    assert.equal(afterDelete, before, "deleting the order gave the reservation back — no permanent leak");

    const remainingAllocations = await orderPfiAllocationRepo.findByOrderId(order.id);
    assert.equal(remainingAllocations.length, 0, "the allocation row is gone too");
  });

  /**
   * Deleting a paid order used to destroy the customer's money.
   *
   * placeHold() takes the amount out of customers.balance, and the hold row is
   * the only record that it is owed back. The delete removed that row with a
   * raw DELETE, so the balance stayed short with nothing on the ledger saying
   * why. Order PU11486 — ₦103,700,000, deleted 2026-08-26 — left its customer
   * with three unspent credits and a zero balance.
   *
   * The assertion is on the BALANCE, not on the hold row: the row is supposed
   * to be gone afterwards either way, so its absence proves nothing.
   */
  test("deleting a paid order gives the customer their money back", async () => {
    const walletService = require("../services/wallet.service");

    const { order } = await placeOrder({
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity: 2000,
      deliveryType: "pickup",
      trucks: [],
    });
    const total = Number(order.totalAmount);

    await walletService.credit({ customerId, amount: total, description: "delete-test funding" });
    const funded = Number((await customerRepo.findById(customerId)).balance);

    await seedLegacyHold({ customerId, orderId: order.id, amount: total });
    assert.equal(
      Number((await customerRepo.findById(customerId)).balance),
      funded - total,
      "placing the hold took the money out of the balance",
    );

    const res = await request(app)
      .delete(`/api/orders/${order.id}`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(
      Number((await customerRepo.findById(customerId)).balance),
      funded,
      "deleting the order returned the held money — it must not vanish with the hold row",
    );
  });

  /** The fixture statement's account, assigned to this PFI so its orders can be paid into it. */
  async function paidOrder(quantity) {
    const { client } = require("../config/db");
    const { bankAccountId } = await makeStatementLine(1);
    await client`UPDATE bank_accounts SET pfi_ids = ${JSON.stringify([String(pfiId)])}::jsonb WHERE id = ${bankAccountId}`;
    const { order } = await placeOrder({
      customerId, state: "Lagos", depotId, productId, quantity, deliveryType: "pickup", trucks: [],
    });
    await payOrderWithStatementLine(order.id);
    return order;
  }

  /**
   * The credit that paid for a deleted order goes back to the pool.
   *
   * order_payments cascades with the order, but the statement line has no
   * foreign key to it, so the line used to stay MATCHED against nothing —
   * unspendable, and printed on the bank statement as "Order deleted".
   */
  test("deleting a paid order returns its bank credit to the unmatched pool", async () => {
    const { client } = require("../config/db");
    const order = await paidOrder(1500);
    const [paid] = await client`
      SELECT l.id, l.status FROM bank_statement_lines l
        JOIN order_payments op ON op.statement_line_id = l.id
       WHERE op.order_id = ${order.id}`;
    assert.equal(paid.status, "MATCHED");

    const res = await request(app)
      .delete(`/api/orders/${order.id}`)
      .set("Authorization", `Bearer ${superStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.deleted.statementLinesReturned, 1);

    const [line] = await client`
      SELECT status, matched_order_id, matched_deposit_id, matched_by, matched_at
        FROM bank_statement_lines WHERE id = ${paid.id}`;
    assert.equal(line.status, "UNMATCHED", "back in the pool, ready for the order it belongs to");
    assert.equal(line.matched_order_id, null);
    assert.equal(line.matched_by, null);
    assert.equal(line.matched_at, null);

    const [audit] = await client`
      SELECT metadata FROM audit_logs
       WHERE entity_type = 'order' AND entity_id = ${order.id} AND action = 'order.deleted'`;
    assert.deepEqual(audit.metadata.statementLinesReturned.map((l) => l.id), [Number(paid.id)]);
  });

  /**
   * A credit matched in the wallet era went to a deposit, and the deposit to
   * an order, so matched_order_id was never filled in — only its payment row
   * names the order. The statement must read the order from there, not print
   * "Order deleted" beside a live order.
   */
  test("the statement names the order a credit paid, even with no matched_order_id", async () => {
    const { client } = require("../config/db");
    const repo = require("../repositories/bankStatement.repository");
    const order = await paidOrder(1200);
    const [line] = await client`
      SELECT l.id, l.bank_account_id, l.statement_id FROM bank_statement_lines l
        JOIN order_payments op ON op.statement_line_id = l.id
       WHERE op.order_id = ${order.id}`;
    // As the wallet-era matches stand on the live book.
    await client`UPDATE bank_statement_lines SET matched_order_id = NULL WHERE id = ${line.id}`;

    const { lines } = await repo.accountLines({ bankAccountId: line.bank_account_id, limit: 5000 });
    const found = lines.find((l) => Number(l.id) === Number(line.id));
    assert.equal(Number(found.order_id), order.id, "the account statement names the order");

    const bySearch = await repo.accountLines({
      bankAccountId: line.bank_account_id, q: String(order.id), limit: 5000,
    });
    assert.ok(bySearch.lines.some((l) => Number(l.id) === Number(line.id)), "and finds the line by the order");

    const { lines: inUpload } = await repo.listStatementLines({ statementId: line.statement_id, limit: 5000 });
    assert.equal(Number(inUpload.find((l) => Number(l.id) === Number(line.id)).order_id), order.id);
  });

  test("a non-super-admin cannot delete an order", async () => {
    const { order } = await placeOrder({
      customerId,
      state: "Lagos",
      depotId,
      productId,
      quantity: 1000,
      deliveryType: "pickup",
      trucks: [],
    });

    const res = await request(app)
      .delete(`/api/orders/${order.id}`)
      .set("Authorization", `Bearer ${plainStaff.accessToken}`)
      .send({});
    assert.equal(res.status, 403);
  });
});
