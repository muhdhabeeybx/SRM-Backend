// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { closeDb, staffTokenWithRoles } = require("./helpers");

// In place before the module under test takes its own reference to notify.
const notifications = require("../notifications");
const sent = [];
notifications.notify = async (type, opts) => {
  sent.push({ type, to: opts.to, data: opts.data });
};
const stepNotices = require("../services/stepNotices.service");

/**
 * Who gets a text on a truck: nobody hears what they already know.
 *
 * Loaded → the people who sell it, not the driver. Sold → the customer and the
 * driver, not finance. Payment matched → the customer, once a save, and nobody
 * else. A deposit keyed in by hand texts nobody until it is confirmed.
 */
const RUN = `SW${Date.now()}`.slice(-10);
const PLATE = `SW${RUN.slice(-6)}`;
const CODE = `PFI-61B-${RUN}`;
const DRIVER_PHONE = "0800000501";
const CUSTOMER_PHONE = "0800000502";

const settle = () => new Promise((r) => setTimeout(r, 500));
const typesSent = () => sent.map((s) => s.type).sort();

describe("who a truck's texts go to", () => {
  let pfiId;
  let truckId;
  let loadId;
  let customerId;
  let salesOfficer;
  let finance;
  let staffIds;

  const sale = (over = {}) => ({
    id: 1,
    truckNumber: PLATE,
    allocationCode: CODE,
    customerId,
    customerName: "Musa",
    phoneNumber: "0800000503",
    payerName: "Bello",
    paymentAmount: "0",
    ...over,
  });

  before(async () => {
    salesOfficer = Number((await staffTokenWithRoles(["truck_sales"], `who-sales-${RUN}@soroman.test`)).staff.id);
    finance = Number((await staffTokenWithRoles(["finance"], `who-fin-${RUN}@soroman.test`)).staff.id);
    staffIds = [salesOfficer, finance];

    const [pfi] = await client`
      INSERT INTO pfis (pfi_number, status, starting_qty_litres, pfi_type, allocation_code, sales_manager_id, audit_officer_id)
      VALUES (${`PFI/61B/${RUN}`}, 'active', 50000, 'trucking', ${CODE}, ${salesOfficer}, ${finance})
      RETURNING id`;
    pfiId = Number(pfi.id);
    const [truck] = await client`
      INSERT INTO fleet_trucks (plate_number, driver_name, driver_phone)
      VALUES (${PLATE}, 'Sani', ${DRIVER_PHONE})
      RETURNING id`;
    truckId = Number(truck.id);
    const [load] = await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, truck_id, pfi_id, quantity_allocated, loading_status, date_allocated, depot)
      VALUES (${CODE}, ${PLATE}, ${truckId}, ${pfiId}, 50000, 'loaded', '2026-10-30', 'Dangote Lekki')
      RETURNING id`;
    loadId = Number(load.id);
    const [c] = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code)
      VALUES (${`${RUN} Musa`}, 'customer', ${CUSTOMER_PHONE}, ${`CUST-${RUN}`})
      RETURNING id`;
    customerId = Number(c.id);
  });

  beforeEach(() => {
    sent.length = 0;
  });

  after(async () => {
    await client`DELETE FROM delivery_inventory WHERE id = ${loadId}`;
    await client`DELETE FROM delivery_customers WHERE id = ${customerId}`;
    await client`DELETE FROM fleet_trucks WHERE id = ${truckId}`;
    await client`DELETE FROM pfis WHERE id = ${pfiId}`;
    await client`UPDATE staff SET is_active = false WHERE id = ANY(${staffIds})`;
    await closeDb();
  });

  test("a truck loaded texts its sales officer and not the driver", async () => {
    stepNotices.trucksLoaded([loadId]);
    await settle();
    assert.deepEqual(typesSent(), ["desk.trucks_to_sell"]);
    assert.deepEqual(sent[0].to, [{ staffId: salesOfficer }]);
  });

  test("a truck sold texts the customer and the driver and not finance", async () => {
    stepNotices.truckSold(loadId, [
      { id: 1, customerId, customerName: "Musa", quantity: 30000, rate: 1350, salesValue: 40500000, location: "Kano" },
    ]);
    await settle();
    assert.deepEqual(typesSent(), ["delivery.sold_customer", "delivery.sold_driver"]);
  });

  test("a payment matched to the bank texts the customer and nobody else", async () => {
    stepNotices.salesRecorded([sale({ id: 901, paymentAmount: "5000000", statementLineId: 77 })]);
    await settle();
    assert.deepEqual(typesSent(), ["delivery.payment_confirmed"]);
    assert.equal(sent[0].to.phone, CUSTOMER_PHONE);
    assert.equal(sent[0].data.amount, 5000000);
  });

  test("several bank lines matched in one save are one text, with the total", async () => {
    stepNotices.salesRecorded([
      sale({ id: 902, paymentAmount: "5000000", statementLineId: 78 }),
      sale({ id: 903, paymentAmount: "2500000", statementLineId: 79 }),
      sale({ id: 904, paymentAmount: "500000.50", statementLineId: 80 }),
    ]);
    await settle();
    assert.deepEqual(typesSent(), ["delivery.payment_confirmed"]);
    assert.equal(sent[0].data.amount, 8000000.5);
  });

  test("a deposit keyed in by hand texts nobody until it is confirmed", async () => {
    stepNotices.salesRecorded([sale({ id: 905, paymentAmount: "1000000" })]);
    await settle();
    assert.deepEqual(typesSent(), []);

    stepNotices.depositConfirmed(sale({ id: 905, paymentAmount: "1000000" }));
    await settle();
    assert.deepEqual(typesSent(), ["delivery.payment_confirmed"]);
  });

  test("a matched payment is not told a second time when its deposit is marked", async () => {
    stepNotices.depositConfirmed(sale({ id: 906, paymentAmount: "1000000", statementLineId: 81 }));
    await settle();
    assert.deepEqual(typesSent(), []);
  });

  test("a customer put on a truck still tells the driver who to deliver to", async () => {
    stepNotices.salesRecorded([sale({ id: 907 })]);
    await settle();
    assert.deepEqual(typesSent(), ["delivery.assigned_customer", "delivery.assigned_driver"]);
  });
});
