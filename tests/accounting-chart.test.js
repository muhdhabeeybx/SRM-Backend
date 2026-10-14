require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { ensureBankAccounts } = require("../lib/accounting/chart");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * The whole chart of accounts (migration 0081).
 *
 *   one list   the ledger's accounts sit beside the cost accounts, in their own
 *              groups, and the expense form is never offered them
 *   refused    an expense cannot be booked to a bank, a payable or a sales
 *              account, and an account the ledger posts to cannot be deleted
 *              or moved to another group
 *   Finance's  only finance, audit or an admin may change the chart
 *   banks      every bank account gets its own 11xx account, new ones too
 *   stock      only a cargo cost can go into a cargo's stock value, and a new
 *              one does unless Finance says not
 */
const RUN = String(Date.now()).slice(-7);

describe("the chart of accounts", () => {
  let token;
  let weak;
  let bankId;
  const made = [];

  before(async () => {
    token = await staffToken(request, app);
    weak = (await staffTokenWithRoles(["expenditure_officer"], "test-chart-weak@soroman.test")).accessToken;
    const [b] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number)
      VALUES ('Chart Test Bank', ${`Chart ${RUN}`}, ${`99${RUN}`}) RETURNING id`;
    bankId = Number(b.id);
  });

  after(async () => {
    if (made.length) await client`DELETE FROM expense_categories WHERE id = ANY(${made}::int[])`;
    await client`DELETE FROM bank_accounts WHERE id = ${bankId}`;
    await closeDb();
  });

  test("lists the ledger's groups around the cost accounts, and the form is offered only the costs", async () => {
    const chart = await request(app).get("/api/accounts/chart").set("Authorization", `Bearer ${token}`);
    assert.equal(chart.status, 200);
    const codes = chart.body.data.groups.map((g) => g.code);
    assert.deepEqual(codes, ["assets", "liabilities", "equity", "income", "cost_of_sales", "pfi_direct", "general"]);
    const keys = new Set(chart.body.data.accounts.map((a) => a.systemKey));
    for (const k of ["customer_receivables", "suspense", "vendor_payables", "vat_payable", "sales_depot", "stock"]) {
      assert.ok(keys.has(k), `missing ${k}`);
    }

    const form = await request(app).get("/api/expenses/categories").set("Authorization", `Bearer ${token}`);
    const offered = [...form.body.data.general, ...form.body.data.pfi, ...form.body.data.groups.flatMap((g) => g.accounts)];
    assert.ok(offered.length > 0);
    assert.ok(offered.every((c) => ["general", "pfi_direct"].includes(c.gl_group)));
  });

  test("an expense booked to a ledger account is refused", async () => {
    const [bank] = await client`SELECT id FROM expense_categories WHERE system_key = 'vendor_payables'`;
    const res = await request(app)
      .post("/api/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({ category_id: bank.id, amount: 1000, description: `Chart ${RUN}` });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /ledger account/);
  });

  test("an account the ledger posts to cannot be deleted or regrouped, and only Finance may try", async () => {
    const [stock] = await client`SELECT id FROM expense_categories WHERE system_key = 'stock'`;

    const refused = await request(app)
      .delete(`/api/expenses/categories/${stock.id}`)
      .set("Authorization", `Bearer ${weak}`);
    assert.equal(refused.status, 403);

    const del = await request(app).delete(`/api/expenses/categories/${stock.id}`).set("Authorization", `Bearer ${token}`);
    assert.equal(del.status, 400);
    const move = await request(app)
      .patch(`/api/expenses/categories/${stock.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ gl_group: "income" });
    assert.equal(move.status, 400);
  });

  test("Finance can add an account to any group", async () => {
    const res = await request(app)
      .post("/api/expenses/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: `Director's loan ${RUN}`, gl_code: `24${RUN.slice(-2)}`, gl_group: "liabilities", gl_subgroup: "Loans" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    made.push(Number(res.body.data.category.id));
    assert.equal(res.body.data.category.gl_group, "liabilities");
  });

  test("only a cargo cost goes into stock value, and a new one does unless told not to", async () => {
    const make = (body) => request(app).post("/api/expenses/categories").set("Authorization", `Bearer ${token}`).send(body);
    const cargo = await make({ name: `Barge hire ${RUN}`, gl_group: "pfi_direct" });
    assert.equal(cargo.status, 201, JSON.stringify(cargo.body));
    made.push(Number(cargo.body.data.category.id));
    assert.equal(cargo.body.data.category.into_stock, true);

    const kept = await make({ name: `Agent's fee ${RUN}`, gl_group: "pfi_direct", into_stock: false });
    assert.equal(kept.status, 201, JSON.stringify(kept.body));
    made.push(Number(kept.body.data.category.id));
    assert.equal(kept.body.data.category.into_stock, false);

    const overhead = await make({ name: `Office rent ${RUN}`, gl_group: "general", into_stock: true });
    assert.equal(overhead.status, 400);

    const off = await request(app)
      .patch(`/api/expenses/categories/${cargo.body.data.category.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ into_stock: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const [row] = await client`SELECT into_stock FROM expense_categories WHERE id = ${cargo.body.data.category.id}`;
    assert.equal(row.into_stock, false);

    // Commission money is handed to staff (0084): never into stock.
    const [commission] = await client`SELECT id FROM expense_categories WHERE system_key = 'customer_commission'`;
    if (commission) {
      const intoStock = await request(app)
        .patch(`/api/expenses/categories/${commission.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ into_stock: true });
      assert.equal(intoStock.status, 400);
    }

    const [general] = await client`SELECT id FROM expense_categories WHERE gl_group = 'general' AND NOT is_system_category ORDER BY id LIMIT 1`;
    const wrong = await request(app)
      .patch(`/api/expenses/categories/${general.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ into_stock: true });
    assert.equal(wrong.status, 400);
  });

  test("a new bank account gets its own chart account, once", async () => {
    await ensureBankAccounts();
    await ensureBankAccounts();
    const rows = await client`SELECT name, gl_group, system_key FROM expense_categories WHERE bank_account_id = ${bankId}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gl_group, "assets");
    assert.equal(rows[0].system_key, `bank:${bankId}`);
    assert.match(rows[0].name, /Chart Test Bank · Chart \d+ · ••\d{4}/);
  });
});
