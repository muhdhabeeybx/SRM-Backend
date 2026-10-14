require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const vendorRepo = require("../repositories/vendor.repository");
const { vendorStatement } = require("../services/accounting/statements.service");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * The Vendors page's figures (vendorRepo.withMoney) and linking typed names
 * (services/vendorLinks).
 *
 *   owed now   the vendor statement's closing balance, to the kobo: approved
 *              bills less what was paid; one still in approval is waiting,
 *              a rejected one and a refund are nobody's
 *   period     billed, paid and tax kept back are the period's
 *   linking    an expense naming the vendor only as text is linked to it —
 *              by Finance, never by anyone else
 */
const RUN = String(Date.now()).slice(-7);
const NAME = `Vendor Money ${RUN}`;

describe("vendors at a glance", () => {
  let vendorId;
  let token;
  const ids = [];

  const expense = async (v) => {
    const [cat] = v.categoryId ? [{ id: v.categoryId }]
      : await client`SELECT id FROM expense_categories WHERE gl_group = 'general' AND NOT COALESCE(is_refund, false) ORDER BY gl_code LIMIT 1`;
    const [r] = await client`
      INSERT INTO pfi_expenses (category_id, vendor_id, vendor, amount, exchange_rate, description, status, expense_date,
                                admin_approved_at, amount_paid, payment_date, paid_at, vat_amount, vat_withheld, wht_deduction)
      VALUES (${cat.id}, ${v.linked === false ? null : vendorId}, ${v.typed ?? NAME}, ${v.amount}, 1, ${`${RUN} ${v.label}`}, ${v.status},
              ${v.approved ?? "2026-10-01"}, ${v.approved ? `${v.approved}T10:00:00+01:00` : null},
              ${v.paid ?? null}, ${v.paidOn ? `${v.paidOn}T10:00:00+01:00` : null}, ${v.paidOn ? `${v.paidOn}T10:00:00+01:00` : null},
              ${v.vat ?? 0}, ${v.vatWithheld ?? false}, ${v.wht ?? 0})
      RETURNING id`;
    ids.push(Number(r.id));
    return Number(r.id);
  };

  before(async () => {
    token = await staffToken(request, app);
    [{ id: vendorId }] = await client`INSERT INTO vendors (name) VALUES (${NAME}) RETURNING id`;
    vendorId = Number(vendorId);
    await expense({ label: "approved, taxed", amount: 100_000, status: "admin_approved", approved: "2026-10-02", vat: 7_500, vatWithheld: true, wht: 5_000 });
    await expense({ label: "paid", amount: 50_000, status: "paid", approved: "2026-10-03", paid: 50_000, paidOn: "2026-10-05" });
    await expense({ label: "in approval", amount: 20_000, status: "pending" });
    await expense({ label: "rejected", amount: 9, status: "rejected" });
    const [refund] = await client`SELECT id FROM expense_categories WHERE is_refund LIMIT 1`;
    if (refund) await expense({ label: "refund", amount: 7_000, status: "paid", approved: "2026-10-04", paid: 7_000, paidOn: "2026-10-04", categoryId: refund.id });
  });

  after(async () => {
    await client`DELETE FROM pfi_expense_audits WHERE expense_id = ANY(${ids}::int[])`;
    await client`DELETE FROM pfi_expenses WHERE id = ANY(${ids}::int[])`;
    await client`DELETE FROM vendors WHERE id = ${vendorId}`;
    await closeDb();
  });

  test("owed now is the statement's balance; waiting, rejected and refunds are apart", async () => {
    const [v] = await vendorRepo.withMoney({ vendorId, from: "2026-10-01", to: "2026-10-31" });
    assert.equal(v.money.owedNow, 100_000);
    assert.equal(v.money.owedNow, (await vendorStatement(vendorId)).closing);
    assert.deepEqual(v.money.waiting, { count: 1, amount: 20_000 });
    assert.equal(v.money.billed, 150_000);
    assert.equal(v.money.paid, 50_000);
    assert.equal(v.money.vatKept, 7_500);
    assert.equal(v.money.whtKept, 5_000);
    assert.equal(v.money.expenseCount, 3);
    assert.equal(v.money.oldestUnpaidDay, "2026-10-02");
    assert.equal(v.money.lastPaidDay, "2026-10-05");
  });

  test("billed and paid follow the period; owed now does not", async () => {
    const [v] = await vendorRepo.withMoney({ vendorId, from: "2026-10-04", to: "2026-10-31" });
    assert.equal(v.money.billed, 0);
    assert.equal(v.money.paid, 50_000);
    assert.equal(v.money.owedNow, 100_000);
  });

  test("the list with money, its totals, and one vendor's page", async () => {
    const list = await request(app).get("/api/vendors").query({ withMoney: "1", search: NAME, from: "2026-10-01", to: "2026-10-31" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.vendors.length, 1);
    assert.equal(list.body.data.totals.owedNow, 100_000);
    assert.equal(list.body.data.totals.owedTo, 1);
    const plain = await request(app).get("/api/vendors").query({ search: NAME }).set("Authorization", `Bearer ${token}`);
    assert.equal(plain.body.data.vendors[0].money, undefined, "the pickers get names only");
    const one = await request(app).get(`/api/vendors/${vendorId}`).query({ from: "2026-10-04" }).set("Authorization", `Bearer ${token}`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.data.money.paid, 50_000);
    assert.equal(one.body.data.money.billed, 0);
  });

  test("an expense naming the vendor only as text is linked to it — by Finance only", async () => {
    const typed = await expense({ label: "typed", amount: 3_000, status: "admin_approved", approved: "2026-10-06", linked: false, typed: `  ${NAME.toUpperCase()}.` });
    const weak = (await staffTokenWithRoles(["expenditure_officer"], "test-vendor-link-weak@soroman.test")).accessToken;
    assert.equal((await request(app).post("/api/vendors/link-typed-names").set("Authorization", `Bearer ${weak}`)).status, 403);

    const preview = await request(app).get("/api/vendors/typed-names").set("Authorization", `Bearer ${token}`);
    assert.equal(preview.status, 200);
    assert.ok(preview.body.data.matched >= 1);
    const finance = (await staffTokenWithRoles(["finance"], "test-vendor-link-finance@soroman.test")).accessToken;
    const linked = await request(app).post("/api/vendors/link-typed-names").set("Authorization", `Bearer ${finance}`);
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const [row] = await client`SELECT vendor_id FROM pfi_expenses WHERE id = ${typed}`;
    assert.equal(Number(row.vendor_id), vendorId);
    const [audit] = await client`SELECT action FROM pfi_expense_audits WHERE expense_id = ${typed}`;
    assert.equal(audit.action, "vendor_linked");
  });
});
