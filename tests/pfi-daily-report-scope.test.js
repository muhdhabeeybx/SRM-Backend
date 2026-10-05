require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { buildPfiDailyReportData } = require("../services/pfiDailyReport.service");
const { closeDb } = require("./helpers");

/**
 * What the Sales & Operations Report lists, and what it leaves out.
 *
 * Against the database, because every rule here is a rule about rows: which
 * batches count as active, which PFIs are depot batches, which sheets belong
 * on the staff grid. Each was wrong in a way that throws nothing — a closed
 * batch listed as trading, a trucking PFI printing "0 Litres" of closing stock
 * on the depot table, a column of "Not reported" against batches no desk
 * files for.
 *
 * The test database is shared, so every assertion is about this run's own
 * rows, found by the RUN tag in their names.
 */
const RUN = `SC${Date.now()}`.slice(-9);
const DAY = "2026-09-21";
const at = new Date(`${DAY}T12:00:00Z`);

describe("sales & operations report — what is listed", () => {
  let data;
  const ids = { pfis: [], customers: [] };
  const code = (s) => `PFI-${RUN}${s}`;
  const depotNumber = `DEPOT/${RUN}`;
  const truckingNumber = `PFI ${RUN}A`;

  before(async () => {
    const pfis = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, allocation_code)
      VALUES (${depotNumber},          'coastal',  'active',   1000000, '300',  NULL),
             (${truckingNumber},       'trucking', 'active',   500000,  '1200', ${code("A")}),
             (${`PFI ${RUN}F`},        'trucking', 'finished', 500000,  '1200', ${code("F")}),
             (${`PFI ${RUN}D`},        'trucking', 'active',   500000,  '1200', ${code("D")})
      RETURNING id`;
    ids.pfis = pfis.map((p) => Number(p.id));
    const [depot, activeTrucking, finishedTrucking, deskClosed] = ids.pfis;

    const customers = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number)
      VALUES (${`${RUN} Station`}, 'filling_station', '0800000001'),
             (${`${RUN} Buyer`},   'customer',        '0800000002')
      RETURNING id`;
    ids.customers = customers.map((c) => Number(c.id));
    const [station, buyer] = ids.customers;

    // The active batch: a truck to a buyer, stock to the station.
    // The finished one: the same shape, still owed money.
    await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, pfi_id, customer_id, quantity_allocated, loading_status, date_allocated)
      VALUES (${code("A")}, ${`${RUN}T1`}, ${activeTrucking},   ${buyer},   45000, 'loaded', ${DAY}),
             (${code("A")}, ${`${RUN}T2`}, ${activeTrucking},   ${station}, 50000, 'loaded', ${DAY}),
             (${code("F")}, ${`${RUN}T3`}, ${finishedTrucking}, ${buyer},   45000, 'loaded', '2026-08-01'),
             (${code("F")}, ${`${RUN}T4`}, ${finishedTrucking}, ${station}, 50000, 'loaded', '2026-08-01'),
             (${code("D")}, ${`${RUN}T5`}, ${deskClosed},       ${buyer},   45000, 'loaded', ${DAY})`;
    // D's PFI is still active, but the desk closed the batch on Delivery Inventory.
    await client`INSERT INTO delivery_batches (code, status) VALUES (${code("D")}, 'completed')`;
    // The station is a customer of the truck sale (migration 0070): its share
    // is charged at 1,100 and settled from the station account. What it sold
    // at the pump and banked is on its own book.
    await client`
      INSERT INTO delivery_sales (allocation_code, customer_id, customer_name, truck_number, date_loaded, quantity, rate, sales_value, payment_amount, book, payment_method)
      VALUES (${code("A")}, ${buyer},   ${`${RUN} Buyer`},   ${`${RUN}T1`}, ${DAY},        45000, 1200, 54000000, 50000000, 'trucking', 'manual'),
             (${code("A")}, ${station}, ${`${RUN} Station`}, ${`${RUN}T2`}, ${DAY},        20000, 1100, 22000000, 0,        'trucking', 'manual'),
             (${code("A")}, ${station}, ${`${RUN} Station`}, ${`${RUN}T2`}, ${DAY},        0,     0,    0,        22000000, 'trucking', 'station_account'),
             (${code("A")}, ${station}, ${`${RUN} Station`}, ${`${RUN}T2`}, ${DAY},        20000, 1200, 24000000, 24000000, 'station',  'manual'),
             (${code("F")}, ${buyer},   ${`${RUN} Buyer`},   ${`${RUN}T3`}, '2026-08-01', 45000, 1200, 54000000, 40000000, 'trucking', 'manual'),
             (${code("F")}, ${station}, ${`${RUN} Station`}, ${`${RUN}T4`}, '2026-08-01', 50000, 1200, 60000000, 55000000, 'station',  'manual')`;

    // One sheet against the depot batch, one against the trucking PFI.
    await client`
      INSERT INTO daily_reports (report_date, location, pfi_number, report_type, submitted_by_name)
      VALUES (${DAY}, 'Scope Depot', ${depotNumber},    'security_gate', ${`${RUN} Gate`}),
             (${DAY}, 'Scope Road',  ${truckingNumber}, 'security_gate', ${`${RUN} Road`})`;

    // A request raised on the day, one step into the approval chain.
    const [cat] = await client`SELECT id FROM expense_categories ORDER BY id LIMIT 1`;
    await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, amount, exchange_rate, description, status, expense_date)
      VALUES (${depot}, ${cat.id}, 300000, 1, ${`${RUN} diesel`}, 'verified', ${at.toISOString()})`;

    data = await buildPfiDailyReportData(at);
  });

  after(async () => {
    await client`DELETE FROM delivery_batches WHERE code LIKE ${`PFI-${RUN}%`}`;
    await client`DELETE FROM pfi_expenses WHERE description LIKE ${`${RUN}%`}`;
    await client`DELETE FROM daily_reports WHERE submitted_by_name LIKE ${`${RUN}%`}`;
    await client`DELETE FROM delivery_sales WHERE truck_number LIKE ${`${RUN}%`}`;
    await client`DELETE FROM delivery_inventory WHERE truck_number LIKE ${`${RUN}%`}`;
    if (ids.customers.length) await client`DELETE FROM delivery_customers WHERE id = ANY(${ids.customers})`;
    if (ids.pfis.length) await client`DELETE FROM pfis WHERE id = ANY(${ids.pfis})`;
    await closeDb();
  });

  test("a trucking PFI is not a depot batch", () => {
    const numbers = data.pfis.map((p) => p.pfiNumber);
    assert.ok(numbers.includes(depotNumber), "the coastal batch is on the depot tables");
    assert.ok(!numbers.includes(truckingNumber), "the trucking PFI is not");
  });

  test("truck sales list the open batch, summed as PFI Tracking sums it", () => {
    const codes = data.truckSales.map((b) => b.code);
    assert.ok(codes.includes(code("A")));
    assert.ok(!codes.includes(code("F")), "a finished PFI's batch is closed");
    assert.ok(!codes.includes(code("D")), "so is one the desk closed on Delivery Inventory");
    const a = data.truckSales.find((b) => b.code === code("A"));
    // Two trucks: one sold to the buyer, one to the station (sold on assignment).
    // The station's line is its charge and its settlement — never its pump
    // sales or its deposits.
    assert.equal(a.trucks, 2);
    assert.equal(a.soldTrucks, 2);
    assert.equal(a.salesValue, 54000000 + 22000000);
    assert.equal(a.paid, 50000000 + 22000000);
    assert.equal(a.unpaid, 4000000);
  });

  test("no closed-batch debt is carried on the report", () => {
    assert.equal(data.closedOwing, undefined);
  });

  test("a station is listed only for stock on an open PFI, read as its page reads it", () => {
    const mine = data.stations.filter((s) => s.party === `${RUN} Station`);
    assert.deepEqual(mine.map((s) => s.code), [code("A")]);
    const [row] = mine;
    assert.equal(row.received, 20000, "its share of the truck, as the station page states it");
    assert.equal(row.sold, 20000);
    assert.equal(row.soldToday, 20000, "sold at the pump on the report's day");
    assert.equal(row.stockLeft, 0);
    assert.equal(row.banked, 24000000);
    assert.equal(row.balance, 0);
  });

  test("the staff grid covers depot batches only", () => {
    const gate = data.staffReports.find((r) => r.type === "security_gate");
    const pfiNumbers = gate.rows.map((r) => r.pfiNumber);
    assert.ok(pfiNumbers.includes(depotNumber));
    assert.ok(!pfiNumbers.includes(truckingNumber), "no row, filed or not, for a trucking PFI");
    assert.ok(gate.rows.some((r) => r.submittedBy === `${RUN} Gate`));
    assert.ok(!gate.rows.some((r) => r.submittedBy === `${RUN} Road`));
  });

  test("each expense line says where its requests are in the chain", () => {
    const line = data.expenseLines.find((l) => l.label === depotNumber);
    assert.ok(line, "the day's request is on the expenses table");
    const item = line.items.find((i) => i.description === `${RUN} diesel`);
    assert.equal(item.status, "verified");
    assert.equal(item.statusLabel, "With CFO");
    assert.equal(item.amount, 300000);
  });
});
