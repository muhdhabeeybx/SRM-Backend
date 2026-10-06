require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");
const { readBookOf, bookForWrite } = require("../lib/deliveryBook");
const { summariseBatches } = require("../lib/deliveryBatches");
const { buildStationRestocks } = require("../lib/stationAccounts");

/**
 * The sales ledger and a station's own record, from PFI-47B on — migration
 * 0070, lib/deliveryBook.js.
 *
 * A station's load on PFI-47B or after is a sale like any other on the
 * ledger; its pump sales, expenses and deposits are its separate record.
 * Every row on an earlier batch keeps reading as it always did.
 */
const RUN = `BK${Date.now()}`.slice(-10);
const PLATE = `BK${RUN.slice(-6)}`;
const OLD_DAY = "2026-09-20";
const NEW_DAY = "2026-09-24";
const OLD = `PFI-43B-${RUN}`;
const NEW = `PFI-47B-${RUN}`;

describe("the sales ledger and a station's own record", () => {
  let admin;
  let stationId;
  let customerId;

  const list = async () => {
    const res = await request(app)
      .get("/api/delivery-sales")
      .query({ truck_number: PLATE, limit: 1000 })
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.sales;
  };
  const standing = async (dateLoaded, customer = stationId) => {
    const res = await request(app)
      .get("/api/delivery-sales/cycle-standing")
      .query({ truckNumber: PLATE, dateLoaded, customerId: customer })
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
  };

  before(async () => {
    admin = await staffToken(request, app);
    const made = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code) VALUES
        (${`${RUN} Kano FS`}, 'filling_station', '0800000301', ${`STN-${RUN}`}),
        (${`${RUN} Musa Trading`}, 'customer', '0800000302', ${`CUST-${RUN}`})
      RETURNING id, customer_type`;
    stationId = Number(made.find((c) => c.customer_type === "filling_station").id);
    customerId = Number(made.find((c) => c.customer_type === "customer").id);

    // Rows as they stand before the column: no book at all.
    await client`
      INSERT INTO delivery_sales (truck_number, date_loaded, customer_id, allocation_code, quantity, rate, sales_value, payment_amount) VALUES
        (${PLATE}, ${OLD_DAY}, ${stationId}, ${OLD}, 33000, 0, 0, 0),
        (${PLATE}, ${OLD_DAY}, ${stationId}, ${OLD}, 9000, 1000, 9000000, 0),
        (${PLATE}, ${OLD_DAY}, ${stationId}, ${OLD}, 0, 0, 0, 8500000),
        (${PLATE}, ${NEW_DAY}, ${stationId}, ${NEW}, 30000, 0, 0, 0),
        (${PLATE}, ${NEW_DAY}, ${stationId}, ${NEW}, 7000, 1000, 7000000, 0),
        (${PLATE}, ${NEW_DAY}, ${stationId}, NULL, 0, 0, 0, 500000),
        (${PLATE}, ${NEW_DAY}, ${customerId}, ${NEW}, 15000, 965, 14475000, 14475000)`;
    // The load behind the new rows, so a row with no code of its own reads its load's.
    await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, customer_id, quantity_allocated, loading_status, date_allocated)
      VALUES (${NEW}, ${PLATE}, ${stationId}, 30000, 'offloaded', ${NEW_DAY})`;
  });

  after(async () => {
    const ids = [stationId, customerId];
    await client`DELETE FROM station_entry_staff WHERE delivery_customer_id = ANY(${ids})`;
    await client`DELETE FROM delivery_sales WHERE customer_id = ANY(${ids})`;
    await client`DELETE FROM delivery_inventory WHERE truck_number = ${PLATE}`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${ids})`;
    await closeDb();
  });

  test("the rule, row by row", () => {
    const s = (o) => ({ truckNumber: PLATE, dateLoaded: NEW_DAY, ...o });
    // Before PFI-47B a station's rows are read as they always were.
    assert.equal(readBookOf(s({ allocationCode: "PFI-43B", salesValue: 100 }), "filling_station"), "legacy");
    assert.equal(readBookOf(s({ allocationCode: "PFI-47", paymentAmount: 1 }), "filling_station"), "legacy");
    assert.equal(readBookOf(s({ allocationCode: "", paymentAmount: 1 }), "filling_station"), "legacy");
    assert.equal(readBookOf(s({ truckNumber: "", salesValue: 1 }), "lpg_plant"), "legacy");
    // From it, a station's money is its own record and its share is the ledger's.
    assert.equal(readBookOf(s({ allocationCode: "PFI-47B", paymentAmount: 1 }), "filling_station"), "station");
    assert.equal(readBookOf(s({ allocationCode: "PFI/47C", salesValue: 1 }), "filling_station"), "station");
    assert.equal(readBookOf(s({ allocationCode: "PFI 48", quantity: 30000 }), "lpg_plant"), "trucking");
    assert.equal(readBookOf(s({ allocationCode: "", paymentAmount: 1 }), "filling_station", "PFI-47B"), "station", "the load's code stands in");
    // A customer is the ledger's, whatever the batch; a named record is never second-guessed.
    assert.equal(readBookOf(s({ allocationCode: "PFI-43B", paymentAmount: 1 }), "customer"), "trucking");
    assert.equal(readBookOf(s({ allocationCode: "PFI-43B", paymentAmount: 1, book: "station" }), "filling_station"), "station");
    assert.equal(readBookOf(s({ allocationCode: "PFI-47B", paymentAmount: 1, book: "trucking" }), "filling_station"), "trucking");
    // Unnamed writes: a station's money is its own; anything else the ledger's.
    assert.equal(bookForWrite(s({ dateLoaded: OLD_DAY, paymentAmount: 1 }), "filling_station"), "station");
    assert.equal(bookForWrite(s({ dateLoaded: NEW_DAY, quantity: 30000 }), "filling_station"), "trucking");
    assert.equal(bookForWrite(s({ paymentAmount: 1 }), "customer"), "trucking");
  });

  test("the list says how every row is read, and changes none of them", async () => {
    const rows = await list();
    const by = (day, cid, f) => rows.filter((r) => r.dateLoaded === day && Number(r.customerId) === cid && f(r));
    assert.ok(by(OLD_DAY, stationId, () => true).every((r) => r.readBook === "legacy" && r.book === null));
    assert.equal(by(NEW_DAY, stationId, (r) => Number(r.quantity) === 30000)[0].readBook, "trucking");
    assert.equal(by(NEW_DAY, stationId, (r) => Number(r.salesValue) > 0)[0].readBook, "station");
    assert.equal(by(NEW_DAY, stationId, (r) => !r.allocationCode)[0].readBook, "station", "no code of its own: its load is on 47B");
    assert.equal(by(NEW_DAY, customerId, () => true)[0].readBook, "trucking");
    const [{ tagged }] = await client`
      SELECT count(book)::int AS tagged FROM delivery_sales WHERE truck_number = ${PLATE}`;
    assert.equal(tagged, 0, "reading is not writing: no old row was tagged");
  });

  test("an old load's ledger standing is what it always was", async () => {
    const s = await standing(OLD_DAY);
    assert.equal(s.paid, 8500000, "the station's deposit still pays its old load");
  });

  test("a new load's ledger standing leaves out the station's own record", async () => {
    let s = await standing(NEW_DAY);
    assert.equal(s.paid, 0);
    assert.equal(s.expected, 0, "a pump sale is not what the load was sold for");

    // The desk prices the station's load and takes a payment, like any customer's.
    const res = await request(app).post("/api/delivery-sales").set("Authorization", `Bearer ${admin}`).send({
      truckNumber: PLATE, dateLoaded: NEW_DAY, customerId: stationId, allocationCode: NEW,
      quantity: 30000, rate: 950, salesValue: 28500000, paymentAmount: 10000000, book: "trucking",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.sale.book, "trucking");
    s = await standing(NEW_DAY);
    assert.equal(s.expected, 28500000);
    assert.equal(s.paid, 10000000);
  });

  test("setting a 47B station's rate keeps its row on the ledger; an old row stays unmarked", async () => {
    const [share] = await client`
      SELECT id FROM delivery_sales WHERE truck_number = ${PLATE} AND date_loaded = ${NEW_DAY}
         AND customer_id = ${stationId} AND quantity = 30000 AND book IS NULL`;
    const res = await request(app).patch(`/api/delivery-sales/${share.id}`).set("Authorization", `Bearer ${admin}`)
      .send({ rate: 950, salesValue: 28500000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.sale.book, "trucking", "priced on the ledger, still the ledger's");
    const listed = (await list()).find((r) => r.id === share.id);
    assert.equal(listed.readBook, "trucking");

    const [old] = await client`
      SELECT id FROM delivery_sales WHERE truck_number = ${PLATE} AND date_loaded = ${OLD_DAY} AND payment_amount > 0`;
    const edited = await request(app).patch(`/api/delivery-sales/${old.id}`).set("Authorization", `Bearer ${admin}`)
      .send({ remarks: "corrected" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.sale.book, null, "an old row keeps reading as it always has");
    // Put the share back as the tests below expect it.
    await client`UPDATE delivery_sales SET rate = 0, sales_value = 0, book = NULL WHERE id = ${share.id}`;
  });

  test("a station page's day goes on its own record, whatever the load's day", async () => {
    const res = await request(app).post("/api/delivery-sales/bulk").set("Authorization", `Bearer ${admin}`).send({
      sales: [
        { truckNumber: PLATE, dateLoaded: OLD_DAY, customerId: stationId, allocationCode: OLD, quantity: 2000, rate: 1000, salesValue: 2000000, dateOfPayment: NEW_DAY },
        { truckNumber: PLATE, dateLoaded: NEW_DAY, customerId: stationId, allocationCode: NEW, paymentAmount: 6500000, dateOfPayment: NEW_DAY },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.sales.map((r) => r.book), ["station", "station"]);
    // An old load stops taking new station entries on the ledger.
    assert.equal((await standing(OLD_DAY)).paid, 8500000);
  });

  test("who enters a station's deposits does not hold up the ledger", async () => {
    const enterer = await staffTokenWithRoles(["accountant"], `books-enterer-${RUN}@soroman.test`);
    const desk = await staffTokenWithRoles(["accountant"], `books-desk-${RUN}@soroman.test`);
    await client`
      INSERT INTO station_entry_staff (delivery_customer_id, pfi_id, entry_kind, staff_id)
      VALUES (${stationId}, NULL, 'deposits', ${enterer.staff.id}), (${stationId}, NULL, 'sales', ${enterer.staff.id})`;
    const post = (body) => request(app).post("/api/delivery-sales").set("Authorization", `Bearer ${desk.accessToken}`)
      .send({ truckNumber: PLATE, dateLoaded: NEW_DAY, customerId: stationId, allocationCode: NEW, ...body });

    assert.equal((await post({ paymentAmount: 1000 })).status, 403, "the station's own deposit is not theirs");
    assert.equal((await post({ paymentAmount: 1000, book: "trucking" })).status, 201, "a ledger payment is the desk's");
  });

  test("a batch reads an old station load as before, and a new one like any customer's", () => {
    const customers = [{ id: stationId, customerType: "filling_station" }, { id: customerId, customerType: "customer" }];
    const entries = [
      { id: 1, truckNumber: "OLD1", dateAllocated: OLD_DAY, allocationCode: NEW, quantityAllocated: 33000, customerId: stationId },
      { id: 2, truckNumber: "NEW1", dateAllocated: NEW_DAY, allocationCode: NEW, quantityAllocated: 30000, customerId: stationId },
    ];
    const r = (o) => ({ customerId: stationId, ...o });
    const b = summariseBatches({
      entries, customers,
      sales: [
        r({ id: 1, truckNumber: "OLD1", dateLoaded: OLD_DAY, readBook: "legacy", quantity: 33000 }),
        r({ id: 2, truckNumber: "OLD1", dateLoaded: OLD_DAY, readBook: "legacy", quantity: 9000, rate: 1000, salesValue: 9000000 }),
        r({ id: 3, truckNumber: "OLD1", dateLoaded: OLD_DAY, readBook: "legacy", quantity: 8000, rate: 1000, salesValue: 8000000 }),
        r({ id: 4, truckNumber: "OLD1", dateLoaded: OLD_DAY, readBook: "legacy", paymentAmount: 15000000 }),
        r({ id: 5, truckNumber: "OLD1", dateLoaded: OLD_DAY, readBook: "station", paymentAmount: 2000000 }),
        r({ id: 6, truckNumber: "NEW1", dateLoaded: NEW_DAY, readBook: "trucking", quantity: 30000, rate: 950, salesValue: 28500000 }),
        r({ id: 7, truckNumber: "NEW1", dateLoaded: NEW_DAY, readBook: "trucking", quantity: 30000, rate: 950, salesValue: 28500000, paymentAmount: 28500000 }),
        r({ id: 8, truckNumber: "NEW1", dateLoaded: NEW_DAY, readBook: "station", quantity: 7000, rate: 1000, salesValue: 7000000 }),
      ],
    }).get(NEW);
    // Old load: its pump sales summed, its deposits paid it — and the new
    // station deposit is on the station page only.
    // New load: billed once at its rate, paid by the ledger payment.
    assert.equal(b.salesValue, 17000000 + 28500000);
    assert.equal(b.paid, 15000000 + 28500000);
  });

  test("a 47B station load nobody has priced is pending at 0, alone or split; an older one is priced as before", () => {
    const customers = [{ id: stationId, customerType: "filling_station" }, { id: customerId, customerType: "customer" }];
    const entries = [
      { id: 1, truckNumber: "ALONE", dateAllocated: NEW_DAY, allocationCode: NEW, quantityAllocated: 33000, customerId: stationId, rate: "900" },
      { id: 2, truckNumber: "SPLIT", dateAllocated: NEW_DAY, allocationCode: NEW, quantityAllocated: 33000, customerId: customerId },
      { id: 3, truckNumber: "OLDER", dateAllocated: OLD_DAY, allocationCode: OLD, quantityAllocated: 33000, customerId: stationId, rate: "900" },
    ];
    const r = (o) => ({ dateLoaded: NEW_DAY, readBook: "trucking", ...o });
    const batches = summariseBatches({
      entries, customers,
      sales: [
        r({ id: 1, truckNumber: "SPLIT", customerId: stationId, quantity: 17000 }),
        r({ id: 2, truckNumber: "SPLIT", customerId, quantity: 16000, rate: 965, salesValue: 15440000, paymentAmount: 15440000 }),
      ],
    });
    const b = batches.get(NEW);
    assert.equal(b.salesValue, 15440000, "only the buyer's sale; the station's share is pending");
    assert.equal(b.unpaid, 0);
    assert.equal(batches.get(OLD).salesValue, 33000 * 900, "an older batch is priced as it always was");
  });

  test("a station's position reads its own record, and its share off the ledger", () => {
    const loading = { id: 1, truckNumber: "NEW1", dateAllocated: NEW_DAY, allocationCode: NEW, quantityAllocated: 45000, customerId: stationId };
    const r = (o) => ({ truckNumber: "NEW1", dateLoaded: NEW_DAY, customerId: stationId, ...o });
    const [p] = buildStationRestocks([loading], [
      r({ id: 1, readBook: "trucking", quantity: 30000, rate: 950, salesValue: 28500000, paymentAmount: 28500000 }),
      r({ id: 2, readBook: "station", quantity: 7000, rate: 1000, salesValue: 7000000, dateOfPayment: NEW_DAY }),
      r({ id: 3, readBook: "station", paymentAmount: 6500000, dateOfPayment: NEW_DAY }),
    ], NEW_DAY);
    assert.equal(p.quantity, 30000, "its share of a split truck");
    assert.equal(p.salesValue, 7000000, "the ledger's sale is not a pump sale");
    assert.equal(p.deposits, 6500000, "the ledger's payment is not a deposit");
    assert.equal(p.stockLeft, 23000);
  });
});
