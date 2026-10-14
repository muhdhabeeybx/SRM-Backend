require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { db, client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const { landedCosts } = require("../lib/accounting/landedCost");
const { closeDb } = require("./helpers");

/**
 * Landed cost (lib/accounting/landedCost) and the cost of sales it prices
 * (postingSources/pfis.js, pfi_cogs).
 *
 *   per litre   (billed quantity × unit price + the cargo costs that go into
 *               stock) ÷ the litres in the tank; a cost whose account does not
 *               go into stock is left out
 *   batch       a trucking batch drawn off a cargo takes the cargo's cost per
 *               litre, and is never bought again
 *   sold        each sale's litres cost the PFI that sold them, and come out
 *               of the stock of the cargo whose tank they left
 *   plants      an LPG plant's sales are costed at the cargo its delivery came
 *               from, found by the batch code the delivery and the rows share
 *   sold out    a cargo sold to its last litre leaves nothing in Stock — what
 *               the bills put in is what the litres take out
 */
const RUN = Date.now();
const SALE_DAY = "2026-10-06";
const SOURCES = ["order_sale", "station_sale", "pfi_purchase", "pfi_cogs"];

describe("landed cost", () => {
  let cargo;
  let batch;
  let customerId;
  let plantId;
  let loadId;
  let plantRowId;
  let order;
  const orders = [];
  const expenses = [];
  let accounts;

  // A PFI's cost of sales for one unit: its records are keyed pfi|day|unit|place.
  const linesOf = (type, pfiId, unit = "depot") => client`
    SELECT l.account_id, l.pfi_id, l.debit::numeric AS debit, l.credit::numeric AS credit
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.source_type = ${type} AND e.source_id LIKE ${`${pfiId}|%|${unit}|%`}`;

  before(async () => {
    accounts = Object.fromEntries((await client`
      SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`).map((r) => [r.system_key, Number(r.id)]));
    const productId = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depotId = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);

    // 1,000 L billed at ₦285, 950 L landed in the tank.
    [cargo] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, bl_qty_litres, starting_qty_litres, unit_price, product_name, activated_at)
      VALUES (${`LANDED/${RUN}`}, 'coastal', 'active', 1000, 950, 285, ${`Landed ${RUN}`}, ${`${SALE_DAY}T08:00:00+01:00`})
      RETURNING id`;
    [batch] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, parent_pfi_id, product_name)
      VALUES (${`LANDED/${RUN}B`}, 'trucking', 'active', 100, 0, ${cargo.id}, ${`Landed ${RUN}`})
      RETURNING id`;

    const [into] = await client`
      SELECT id FROM expense_categories WHERE gl_group = 'pfi_direct' AND into_stock ORDER BY gl_code LIMIT 1`;
    const [notInto] = await client`
      SELECT id FROM expense_categories WHERE gl_group = 'pfi_direct' AND NOT into_stock ORDER BY gl_code LIMIT 1`;
    const expense = async (categoryId, amount) => Number((await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, amount, exchange_rate, description, status, expense_date, admin_approved_at)
      VALUES (${cargo.id}, ${categoryId}, ${amount}, 1, ${`${RUN} landed`}, 'admin_approved', ${`${SALE_DAY}T09:00:00+01:00`}, now())
      RETURNING id`)[0].id);
    expenses.push(await expense(into.id, 19_000));
    if (notInto) expenses.push(await expense(notInto.id, 5_000));

    const [c] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Landed ${RUN}`}, ${`+23483${String(RUN).slice(-8)}`}, 'Active', 'Landed Test Co') RETURNING id`;
    customerId = Number(c.id);
    order = async (pfiId, litres, n) => Number((await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, pfi_id, quantity, price, total_amount,
                          delivery_type, company_name, payment_status, status, created_at)
      VALUES (${`LC${RUN}${n}`}, ${customerId}, 'Lagos', ${depotId}, ${productId}, ${pfiId}, ${litres}, 400, ${litres * 400},
              'pickup', 'Landed Test Co', 'Paid', 'Pending', ${`${SALE_DAY}T10:00:00+01:00`}) RETURNING id`)[0].id);
    orders.push(await order(cargo.id, 200, 1), await order(batch.id, 100, 2));

    // A plant sent a load off the cargo under a code no PFI carries as its
    // own; the plant's row of sales carries that code too.
    const code = `LND${String(RUN).slice(-6)}B`;
    [{ id: plantId }] = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code)
      VALUES (${`${RUN} Landed LPG`}, 'lpg_plant', '0800000301', ${`LND-${RUN}`}) RETURNING id`;
    [{ id: loadId }] = await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, pfi_id, pfi_number, customer_id, quantity_allocated, loading_status, date_allocated)
      VALUES (${code}, ${`LND${String(RUN).slice(-4)}`}, ${cargo.id}, ${`LANDED/${RUN}`}, ${plantId}, 50, 'loaded', '2026-10-02')
      RETURNING id`;
    [{ id: plantRowId }] = await client`
      INSERT INTO delivery_sales (customer_id, customer_name, quantity, rate, sales_value, date_of_payment, allocation_code, book)
      VALUES (${plantId}, ${`${RUN} Landed LPG`}, 10, 1300, 13000, ${SALE_DAY}, ${code}, 'station')
      RETURNING id`;
  });

  after(async () => {
    const pfiIds = [Number(cargo.id), Number(batch.id)];
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      const mine = tx`
        SELECT id FROM journal_entries
         WHERE (source_type = 'order_sale' AND source_id = ANY(${orders.map(String)}))
            OR (source_type = 'station_sale' AND source_id = ${String(plantRowId)})
            OR (source_type = 'expense_bill' AND source_id = ANY(${expenses.map(String)}))
            OR (source_type = 'pfi_purchase' AND source_id = ANY(${pfiIds.map(String)}))
            OR (source_type = 'pfi_cogs' AND split_part(source_id, '|', 1) = ANY(${pfiIds.map(String)}))`;
      await tx`DELETE FROM journal_lines WHERE entry_id IN (${mine})`;
      await tx`
        DELETE FROM ledger_postings
         WHERE (source_type = 'order_sale' AND source_id = ANY(${orders.map(String)}))
            OR (source_type = 'station_sale' AND source_id = ${String(plantRowId)})
            OR (source_type = 'expense_bill' AND source_id = ANY(${expenses.map(String)}))
            OR (source_type = 'pfi_purchase' AND source_id = ANY(${pfiIds.map(String)}))
            OR (source_type = 'pfi_cogs' AND split_part(source_id, '|', 1) = ANY(${pfiIds.map(String)}))`;
      await tx`DELETE FROM journal_entries WHERE id IN (${mine})`;
    });
    if (plantRowId) await client`DELETE FROM delivery_sales WHERE id = ${plantRowId}`;
    if (loadId) await client`DELETE FROM delivery_inventory WHERE id = ${loadId}`;
    if (plantId) await client`DELETE FROM delivery_customers WHERE id = ${plantId}`;
    await client`DELETE FROM orders WHERE id = ANY(${orders}::int[])`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
    await client`DELETE FROM pfi_expenses WHERE id = ANY(${expenses}::int[])`;
    await client`DELETE FROM pfis WHERE id = ANY(${pfiIds}::int[])`;
    await closeDb();
  });

  test("a litre costs what was billed plus the costs that go into stock, over the litres landed", async () => {
    const costs = await landedCosts(db);
    const c = costs.get(Number(cargo.id));
    assert.equal(c.bought, 285_000);
    assert.equal(c.extras, 19_000);
    assert.equal(c.perLitre, 320);
    assert.equal(c.isBatch, false);
  });

  test("a trucking batch takes its cargo's cost per litre and draws on the cargo's stock", async () => {
    const b = (await landedCosts(db)).get(Number(batch.id));
    assert.equal(b.isBatch, true);
    assert.equal(b.stockPfiId, Number(cargo.id));
    assert.equal(b.perLitre, 320);
  });

  test("the cargo is bought once; each sale costs its own PFI and empties the cargo's tank", async () => {
    const r = await run({ only: SOURCES });
    for (const t of SOURCES) assert.deepEqual(r.sources[t].failed, [], t);

    const bought = await client`
      SELECT e.source_id, SUM(l.debit)::numeric AS d FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.source_type = 'pfi_purchase' AND e.source_id = ANY(${[String(cargo.id), String(batch.id)]})
         AND l.account_id = ${accounts.stock}
       GROUP BY e.source_id`;
    assert.deepEqual(bought.map((x) => [x.source_id, Number(x.d)]), [[String(cargo.id), 285_000]]);

    for (const [pfi, litres] of [[cargo.id, 200], [batch.id, 100]]) {
      const lines = await linesOf("pfi_cogs", pfi);
      const cost = lines.find((l) => Number(l.account_id) === accounts.cost_of_product_sold);
      const out = lines.find((l) => Number(l.account_id) === accounts.stock);
      assert.equal(Number(cost.debit), litres * 320);
      assert.equal(Number(cost.pfi_id), Number(pfi), "cost of sales is the selling PFI's");
      assert.equal(Number(out.credit), litres * 320);
      assert.equal(Number(out.pfi_id), Number(cargo.id), "the litres leave the cargo's stock");
    }
  });

  test("an LPG plant's sales cost the cargo its delivery came from", async () => {
    const lines = await linesOf("pfi_cogs", cargo.id, "lpg_plants");
    const cost = lines.find((l) => Number(l.account_id) === accounts.cost_of_product_sold);
    const out = lines.find((l) => Number(l.account_id) === accounts.stock);
    assert.ok(cost, "the plant's sales are costed");
    assert.equal(Number(cost.debit), 10 * 320);
    assert.equal(Number(out.credit), 10 * 320);
    assert.equal(Number(out.pfi_id), Number(cargo.id));
  });

  test("a cargo cost approved later re-costs what was already sold, as a change", async () => {
    // Another ₦9,500 into stock: ₦10 more on every one of the 950 litres.
    const [into] = await client`
      SELECT id FROM expense_categories WHERE gl_group = 'pfi_direct' AND into_stock ORDER BY gl_code LIMIT 1`;
    const [e] = await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, amount, exchange_rate, description, status, expense_date, admin_approved_at)
      VALUES (${cargo.id}, ${into.id}, 9500, 1, ${`${RUN} landed late`}, 'admin_approved', ${`${SALE_DAY}T11:00:00+01:00`}, now())
      RETURNING id`;
    expenses.push(Number(e.id));
    await run({ only: ["pfi_cogs"] });
    const lines = await linesOf("pfi_cogs", batch.id);
    const cost = lines.filter((l) => Number(l.account_id) === accounts.cost_of_product_sold)
      .reduce((t, l) => t + Number(l.debit) - Number(l.credit), 0);
    assert.equal(cost, 100 * 330);
  });

  test("a cargo sold to its last litre leaves nothing in stock", async () => {
    // ₦950 more into stock — ₦800 to the vendor, ₦50 WHT and ₦100 VAT kept
    // back — a naira a litre, so a litre now costs ₦331.
    const [into] = await client`
      SELECT id FROM expense_categories WHERE gl_group = 'pfi_direct' AND into_stock ORDER BY gl_code LIMIT 1`;
    const [e] = await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, amount, exchange_rate, description, status, expense_date,
                                admin_approved_at, wht_deduction, vat_amount, vat_withheld)
      VALUES (${cargo.id}, ${into.id}, 800, 1, ${`${RUN} landed taxed`}, 'admin_approved', ${`${SALE_DAY}T12:00:00+01:00`},
              now(), 50, 100, true)
      RETURNING id`;
    expenses.push(Number(e.id));
    // The 640 litres still in the tank: 950 landed, less 200, 100 and 10 sold.
    orders.push(await order(cargo.id, 640, 3));
    const r = await run({ only: ["expense_bill", "order_sale", "pfi_cogs"] });
    for (const t of ["expense_bill", "order_sale", "pfi_cogs"]) assert.deepEqual(r.sources[t].failed, [], t);

    assert.equal((await landedCosts(db)).get(Number(cargo.id)).perLitre, 331);
    const [left] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS b FROM journal_lines l
       WHERE l.account_id = ${accounts.stock} AND l.pfi_id = ${cargo.id}`;
    assert.equal(Number(left.b), 0);
  });
});
