require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const repo = require("../repositories/bankStatement.repository");
const { closeDb } = require("./helpers");

/**
 * One bank account read PFI by PFI (the owner's ask, 16 Oct 2026).
 *
 *   order        a credit belongs to the PFI of the order it paid
 *   truck sale   one a truck sale claimed, to the PFI its batch code names
 *   unmatched    one nothing has claimed belongs to no PFI yet
 *   timeline     each PFI runs from its first credit here to its last, and
 *                the PFIs add up to the account
 *   filter       the lines, their totals and the days narrow to one PFI
 *   report       one PFI's orders: what came in here, what came in
 *                elsewhere, what is still owed
 */
const RUN = String(Date.now()).slice(-6);

describe("a bank statement, PFI by PFI", () => {
  let bankId;
  let statementId;
  let customerId;
  const pfi = {};
  const orders = [];
  const lines = [];
  const sales = [];

  const line = async (day, amount, depositor) => {
    const [r] = await client`
      INSERT INTO bank_statement_lines (bank_account_id, statement_id, txn_date, amount, depositor, narration, dedup_key)
      VALUES (${bankId}, ${statementId}, ${day}, ${amount}, ${depositor}, ${depositor}, ${`P${RUN}${Math.random()}`.slice(0, 60)})
      RETURNING id`;
    lines.push(Number(r.id));
    return Number(r.id);
  };
  const order = async (pfiId, total, paid) => {
    const product = Number((await client`SELECT id FROM products ORDER BY id LIMIT 1`)[0].id);
    const depot = Number((await client`SELECT id FROM depots ORDER BY id LIMIT 1`)[0].id);
    const [o] = await client`
      INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity, price,
                          total_amount, delivery_type, company_name, payment_status, status, pfi_id, amount_paid)
      VALUES (${`PF${RUN}${orders.length}`}, ${customerId}, 'Lagos', ${depot}, ${product}, 1000, ${total / 1000},
              ${total}, 'pickup', 'Pfi Split Co', ${paid >= total ? "Paid" : "Part Paid"}, 'Pending', ${pfiId}, ${paid})
      RETURNING id`;
    orders.push(Number(o.id));
    return Number(o.id);
  };
  const pays = (orderId, lineId, amount) => client`
    INSERT INTO order_payments (order_id, amount, source, statement_line_id, bank_account_id, txn_date)
    VALUES (${orderId}, ${amount}, 'statement', ${lineId}, ${bankId}, now())`;

  before(async () => {
    const [b] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
      VALUES ('Pfi Bank', ${`Zp${RUN}`}, ${`66${RUN}01`}, 'Active') RETURNING id`;
    bankId = Number(b.id);
    [{ id: statementId }] = await client`INSERT INTO bank_statements (bank_account_id, filename) VALUES (${bankId}, ${`p-${RUN}.csv`}) RETURNING id`;
    statementId = Number(statementId);
    [{ id: customerId }] = await client`
      INSERT INTO customers (name, phone, status, company_name)
      VALUES (${`Pfi Split ${RUN}`}, ${`+23482${RUN.padStart(8, "0")}`}, 'Active', 'Pfi Split Co') RETURNING id`;
    customerId = Number(customerId);
    for (const [key, number, code] of [["a", `PFIA/${RUN}`, null], ["b", `PFIB/${RUN}`, `PFI-${RUN}B`]]) {
      const [p] = await client`
        INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, product_name, allocation_code)
        VALUES (${number}, 'coastal', 'active', 1000, 100, 'PMS', ${code}) RETURNING id`;
      pfi[key] = Number(p.id);
    }

    // PFI A collects from the 1st to the 5th: two orders.
    const a1 = await order(pfi.a, 5_000_000, 5_000_000);
    await pays(a1, await line("2026-10-01", 5_000_000, "CUSTOMER ONE"), 5_000_000);
    // Part paid here, part into another bank: ₦1m still owed.
    const a2 = await order(pfi.a, 4_000_000, 3_000_000);
    await pays(a2, await line("2026-10-05", 2_000_000, "CUSTOMER TWO"), 2_000_000);
    // PFI B from the 4th: one order, and a truck sale under its batch code.
    const b1 = await order(pfi.b, 7_000_000, 7_000_000);
    await pays(b1, await line("2026-10-04", 7_000_000, "CUSTOMER THREE"), 7_000_000);
    const truckLine = await line("2026-10-08", 1_500_000, "TRUCK BUYER");
    const [s] = await client`
      INSERT INTO delivery_sales (truck_number, date_loaded, allocation_code, customer_name, quantity, payment_amount, statement_line_id, bank_ref)
      VALUES (${`T${RUN}`}, '2026-10-08', ${`pfi-${RUN}b`}, 'Truck Buyer', 1000, 1500000, ${truckLine}, '') RETURNING id`;
    sales.push(Number(s.id));
    // Nothing has claimed this one.
    await line("2026-10-09", 300_000, "UNKNOWN PAYER");
  });

  after(async () => {
    await client`DELETE FROM delivery_sales WHERE id = ANY(${sales}::int[])`;
    await client`DELETE FROM order_payments WHERE order_id = ANY(${orders}::int[])`;
    await client`DELETE FROM orders WHERE id = ANY(${orders}::int[])`;
    await client`DELETE FROM bank_statement_lines WHERE id = ANY(${lines}::int[])`;
    await client`DELETE FROM bank_statements WHERE id = ${statementId}`;
    await client`DELETE FROM pfis WHERE id IN (${pfi.a}, ${pfi.b})`;
    await client`DELETE FROM customers WHERE id = ${customerId}`;
    await client`DELETE FROM expense_categories WHERE bank_account_id = ${bankId}`;
    await client`DELETE FROM bank_accounts WHERE id = ${bankId}`;
    await closeDb();
  });

  test("each PFI runs from its first credit here to its last, the unclaimed apart, and they add up", async () => {
    const rows = await repo.accountPfis({ bankAccountId: bankId });
    const of = (id) => rows.find((r) => (r.pfi_id == null ? null : Number(r.pfi_id)) === id);
    assert.deepEqual([of(pfi.a).first_day, of(pfi.a).last_day, of(pfi.a).line_count, Number(of(pfi.a).amount)], ["2026-10-01", "2026-10-05", 2, 7_000_000]);
    assert.deepEqual([of(pfi.b).first_day, of(pfi.b).last_day, of(pfi.b).line_count, Number(of(pfi.b).amount)], ["2026-10-04", "2026-10-08", 2, 8_500_000],
      "a truck sale's credit belongs to the PFI its batch code names, whatever its case");
    assert.equal(Number(of(null).amount), 300_000);
    assert.equal(rows[rows.length - 1].pfi_id, null, "the unclaimed come last");
    assert.equal(rows.reduce((t, r) => t + Number(r.amount), 0), 15_800_000);
  });

  test("the lines, their totals and the days narrow to one PFI", async () => {
    const b = await repo.accountLines({ bankAccountId: bankId, pfi: String(pfi.b), limit: 50 });
    assert.equal(b.totals.total, 2);
    assert.equal(Number(b.totals.total_amount), 8_500_000);
    assert.ok(b.lines.every((l) => Number(l.pfi_id) === pfi.b && l.pfi_number === `PFIB/${RUN}`));
    const none = await repo.accountLines({ bankAccountId: bankId, pfi: "none", limit: 50 });
    assert.deepEqual(none.lines.map((l) => Number(l.amount)), [300_000]);
    const days = await repo.accountDays({ bankAccountId: bankId, pfi: String(pfi.a) });
    assert.deepEqual(days.map((d) => d.day), ["2026-10-05", "2026-10-01"]);
  });

  test("one PFI's orders: in here, in elsewhere, still owed — and its truck payments", async () => {
    const a = await repo.accountPfiReport({ bankAccountId: bankId, pfiId: pfi.a });
    const part = a.orders.find((o) => Number(o.total_amount) === 4_000_000);
    assert.equal(Number(part.paid_here), 2_000_000);
    assert.equal(Number(part.amount_paid) - Number(part.paid_here), 1_000_000, "paid into another account");
    assert.equal(Number(part.total_amount) - Number(part.amount_paid), 1_000_000, "still owed");
    assert.equal(a.deliveries.length, 0);
    const b = await repo.accountPfiReport({ bankAccountId: bankId, pfiId: pfi.b });
    assert.equal(b.orders.length, 1);
    assert.deepEqual(b.deliveries.map((d) => [d.truck_number, Number(d.line_amount)]), [[`T${RUN}`, 1_500_000]]);
  });
});
