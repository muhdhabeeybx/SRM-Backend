// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { buildStatement } = require("../lib/accounting/statement");
const { customerStatement, vendorStatement } = require("../services/accounting/statements.service");
const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * Customer and vendor statements.
 *
 *   builder    oldest first, a charge before what settles it on the same day,
 *              brought forward carried in, kobo-exact, nothing after the period
 *   customer   only sales are charged; money landed anywhere is theirs; the
 *              0021 duplicate is read past and said so; unpaid orders wait
 *   vendor     owed on approval, cleared on payment; approval still in
 *              progress is not owed; refund expenses are not the vendor's
 */
const RUN = Date.now();
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

describe("statement builder", () => {
  const ev = (id, day, amount, order) => ({ id, day, amount, order });

  test("sorts by day, then a charge before what settles it, and runs the balance", () => {
    const s = buildStatement([
      ev("pay", "2026-10-02", -400, 2),
      ev("sale", "2026-10-02", 1000, 0),
      ev("old", "2026-10-01", 250, 0),
    ]);
    assert.deepEqual(s.rows.map((r) => r.id), ["old", "sale", "pay"]);
    assert.deepEqual(s.rows.map((r) => r.balance), [250, 1250, 850]);
    assert.equal(s.closing, 850);
    assert.deepEqual(s.totals, { up: 1250, down: 400 });
  });

  test("a period carries what came before it in as one figure, and stops at its end", () => {
    const s = buildStatement(
      [ev("a", "2026-09-30", 100, 0), ev("b", "2026-10-05", 50, 0), ev("c", "2026-11-01", 7, 0)],
      { from: "2026-10-01", to: "2026-10-31" }
    );
    assert.equal(s.broughtForward, 100);
    assert.deepEqual(s.rows.map((r) => [r.id, r.balance]), [["b", 150]]);
    assert.equal(s.closing, 150);
  });

  test("adds in kobo, so a long run of decimals does not drift", () => {
    const s = buildStatement(Array.from({ length: 1000 }, (_, i) => ev(`x${i}`, "2026-10-01", 0.1, 0)));
    assert.equal(s.closing, 100);
  });
});

describe("customer statement", () => {
  let customerId;
  let productId;
  let depotId;
  const orderIds = [];

  const order = async ({ total, paymentStatus, status = "Pending" }) => {
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price,
                          total_amount, delivery_type, company_name, payment_status, status)
      VALUES (${`ST${RUN}${orderIds.length}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, 1000,
              ${total / 1000}, ${total}, 'pickup', 'Statement Test Co', ${paymentStatus}, ${status})
      RETURNING id`;
    orderIds.push(Number(o.id));
    return Number(o.id);
  };
  const pay = (orderId, amount, source = "statement") => client`
    INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref)
    VALUES (${orderId}, ${amount}, ${source}, ${source === "statement" ? client`now()` : null},
            'Test Payer', 'statement test', ${`ST-${RUN}-${orderId}-${amount}`})`;

  before(async () => {
    productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    depotId = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);
    const [c] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Statement ${RUN}`}, ${`+23481${String(RUN).slice(-8)}`}, 'Active', 'Statement Test Co')
      RETURNING id`;
    customerId = Number(c.id);

    // Paid in full off the bank, plus the 0021 duplicate of the same money.
    const paid = await order({ total: 1000000, paymentStatus: "Paid" });
    await pay(paid, 1000000);
    await pay(paid, 1000000, "legacy");
    // Part paid and still live: a sale at its full value.
    const part = await order({ total: 2000000, paymentStatus: "Part Paid" });
    await pay(part, 500000);
    // Part paid then cancelled: not a sale, so the money is theirs.
    const gone = await order({ total: 400000, paymentStatus: "Part Paid", status: "Cancelled" });
    await pay(gone, 100000);
    // Nothing paid yet: waits, uncharged.
    await order({ total: 300000, paymentStatus: "Unpaid" });
  });

  after(async () => {
    await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds}::int[])`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds}::int[])`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
  });

  test("charges sales only, credits every naira that landed, and reads past the duplicate", async () => {
    const s = await customerStatement(customerId);
    // 1,000,000 + 2,000,000 charged; 1,000,000 + 500,000 + 100,000 paid.
    assert.equal(s.closing, 1400000);
    assert.equal(s.totals.up, 3000000);
    assert.equal(s.totals.down, 1600000);
    assert.equal(s.leftOut.duplicates, 1000000);
    assert.deepEqual(s.awaiting, { count: 1, value: 300000 });
    assert.equal(s.rows.filter((r) => r.kind === "sale").length, 2);
    assert.ok(s.rows.every((r) => r.day === TODAY));
  });

  test("a period starting after everything carries it all in as brought forward", async () => {
    const s = await customerStatement(customerId, { from: "2999-01-01" });
    assert.equal(s.rows.length, 0);
    assert.equal(s.broughtForward, 1400000);
    assert.equal(s.closing, 1400000);
  });
});

describe("vendor statement", () => {
  let vendorId;
  let categoryId;
  let refundCategoryId;
  const tag = `VST${RUN}`;

  const expense = (values) => client`
    INSERT INTO pfi_expenses (category_id, vendor_id, amount, exchange_rate, description, status,
                              expense_date, admin_approved_at, amount_paid, payment_date, paid_at,
                              bank_paid_from, vat_amount, vat_withheld, wht_deduction)
    VALUES (${values.categoryId ?? categoryId}, ${vendorId}, ${values.amount}, 1, ${`${tag} ${values.label}`},
            ${values.status}, now(), ${values.approved ? client`now()` : null},
            ${values.paid ?? null}, ${values.paid ? client`now()` : null}, ${values.paid ? client`now()` : null},
            ${values.paid ? "Fidelity Bank" : null}, ${values.vat ?? 0}, ${values.vatWithheld ?? false}, ${values.wht ?? 0})`;

  before(async () => {
    const [v] = await client`INSERT INTO vendors (name) VALUES (${`Vendor ${tag}`}) RETURNING id`;
    vendorId = Number(v.id);
    categoryId = Number((await client`
      SELECT id FROM expense_categories WHERE NOT COALESCE(is_refund, false) ORDER BY id LIMIT 1`)[0].id);
    const refund = await client`SELECT id FROM expense_categories WHERE is_refund LIMIT 1`;
    refundCategoryId = refund[0] ? Number(refund[0].id) : null;

    await expense({ label: "approved", amount: 950000, status: "admin_approved", approved: true, vat: 75000, vatWithheld: true, wht: 50000 });
    await expense({ label: "paid", amount: 500000, status: "paid", approved: true, paid: 500000 });
    await expense({ label: "in approval", amount: 200000, status: "verified" });
    await expense({ label: "rejected", amount: 99, status: "rejected" });
    if (refundCategoryId) {
      await expense({ label: "refund", amount: 70000, status: "paid", approved: true, paid: 70000, categoryId: refundCategoryId });
    }
  });

  after(async () => {
    await client`DELETE FROM pfi_expenses WHERE description LIKE ${`${tag}%`}`;
    await client`DELETE FROM vendors WHERE id = ${vendorId}`;
  });

  test("owed on approval, cleared on payment; approval in progress and refunds are not the vendor's", async () => {
    const s = await vendorStatement(vendorId);
    assert.equal(s.closing, 950000);
    assert.equal(s.totals.up, 1450000);
    assert.equal(s.totals.down, 500000);
    assert.deepEqual(s.awaitingApproval, { count: 1, value: 200000 });
    assert.deepEqual(s.taxKept, { vat: 75000, wht: 50000 });
    assert.ok(!s.rows.some((r) => r.description.includes("refund")));
  });
});

after(closeDb);
