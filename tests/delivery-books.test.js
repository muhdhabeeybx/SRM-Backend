require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, staffTokenWithRoles, closeDb, makeStatementLine } = require("./helpers");
const { bookOf } = require("../lib/deliveryBook");
const { summariseBatches } = require("../lib/deliveryBatches");
const { buildStationRestocks } = require("../lib/stationAccounts");

/**
 * The truck sale and a station's own trade, kept in two books — migration 0070.
 *
 * A station is charged for its share of a load on the truck sale and settles
 * it there like any customer, from the station account; its pump sales and
 * deposits stay on its own book and never count as the load's payment.
 */
const RUN = `BK${Date.now()}`.slice(-10);
const PLATE = `BK${RUN.slice(-6)}`;
const DAY = "2026-09-20";
const CODE = `PFI-${RUN}`;

describe("two books on one load", () => {
  let admin;
  let stationId;
  let plantId;
  let customerId;

  const post = (path, body, token = admin) =>
    request(app).post(`/api/delivery-sales${path}`).set("Authorization", `Bearer ${token}`).send(body);
  const rowsOf = (id) => client`
    SELECT id, book, quantity, rate::numeric AS rate, sales_value::numeric AS sales_value,
           payment_amount::numeric AS payment_amount, payment_method
      FROM delivery_sales WHERE customer_id = ${id} ORDER BY id`;

  before(async () => {
    admin = await staffToken(request, app);
    const made = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code) VALUES
        (${`${RUN} Kano FS`}, 'filling_station', '0800000201', ${`STN-${RUN}`}),
        (${`${RUN} Damaturu LPG`}, 'lpg_plant', '0800000202', ${`LPG-${RUN}`}),
        (${`${RUN} Musa Trading`}, 'customer', '0800000203', ${`CUST-${RUN}`})
      RETURNING id, customer_type`;
    stationId = Number(made.find((c) => c.customer_type === "filling_station").id);
    plantId = Number(made.find((c) => c.customer_type === "lpg_plant").id);
    customerId = Number(made.find((c) => c.customer_type === "customer").id);
  });

  after(async () => {
    const ids = [stationId, plantId, customerId];
    await client`DELETE FROM station_entry_staff WHERE delivery_customer_id = ANY(${ids})`;
    await client`DELETE FROM delivery_sales WHERE customer_id = ANY(${ids})`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${ids})`;
    await closeDb();
  });

  test("the rule: a station's money is its own book, its share of a load is the truck sale's", () => {
    assert.equal(bookOf({ truckNumber: PLATE, salesValue: 100 }, "filling_station"), "station");
    assert.equal(bookOf({ truckNumber: PLATE, paymentAmount: 100 }, "lpg_plant"), "station");
    assert.equal(bookOf({ truckNumber: PLATE, expensesAmount: 100 }, "filling_station"), "station");
    assert.equal(bookOf({ truckNumber: "", buyerClass: "dealer" }, "lpg_plant"), "station");
    assert.equal(bookOf({ truckNumber: PLATE, quantity: 30000 }, "filling_station"), "trucking");
    assert.equal(bookOf({ truckNumber: PLATE, paymentAmount: 100 }, "customer"), "trucking");
    // Named, it is never second-guessed.
    assert.equal(bookOf({ truckNumber: PLATE, paymentAmount: 100, book: "trucking" }, "filling_station"), "trucking");
  });

  test("a station's day goes on its own book, and its share on the truck sale", async () => {
    const load = { truckNumber: PLATE, dateLoaded: DAY, allocationCode: CODE, customerId: stationId };
    let res = await post("/", { ...load, quantity: 30000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.sale.book, "trucking", "the load share");

    res = await post("/bulk", {
      sales: [
        { ...load, quantity: 8000, rate: 1000, salesValue: 8000000, dateOfPayment: DAY },
        { ...load, paymentAmount: 7500000, dateOfPayment: DAY },
        { ...load, expensesAmount: 40000, remarks: "Generator diesel", dateOfPayment: DAY },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.sales.map((s) => s.book), ["station", "station", "station"]);
  });

  test("the truck sale's standing for a station ignores what it banked", async () => {
    const res = await request(app)
      .get("/api/delivery-sales/cycle-standing")
      .query({ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId })
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.paid, 0, "₦7.5m of deposits is not the load's payment");

    const own = await request(app)
      .get("/api/delivery-sales/cycle-standing")
      .query({ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, book: "station" })
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(own.body.data.paid, 7500000);
  });

  test("an unpriced share cannot be settled", async () => {
    const res = await post("/settle-station", {
      loads: [{ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, allocationCode: CODE }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /give a rate/);
  });

  test("charge and settle: the share is priced, then paid from the station account", async () => {
    const res = await post("/settle-station", {
      loads: [{ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, allocationCode: CODE, rate: 950 }],
      note: "September loads",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.loads[0], {
      truckNumber: PLATE, customerId: stationId, charged: 28500000, alreadyPaid: 0, settled: 28500000,
    });

    const rows = await rowsOf(stationId);
    const trucking = rows.filter((r) => r.book === "trucking");
    assert.equal(trucking.length, 2, "the share, and one settlement");
    assert.equal(Number(trucking[0].rate), 950);
    assert.equal(Number(trucking[0].sales_value), 28500000);
    assert.equal(trucking[1].payment_method, "station_account");
    assert.equal(Number(trucking[1].payment_amount), 28500000);
    // The station's own rows are exactly as they were.
    const own = rows.filter((r) => r.book === "station");
    assert.equal(own.length, 3);
    assert.equal(Number(own[0].rate), 1000, "the pump rate is not the truck sale's rate");
  });

  test("settling again settles nothing", async () => {
    const res = await post("/settle-station", {
      loads: [{ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, allocationCode: CODE }],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.settled, 0);
    assert.equal((await rowsOf(stationId)).filter((r) => r.payment_method === "station_account").length, 1);
  });

  test("a share with no row yet is written at the quantity the screen read, then settled", async () => {
    const res = await post("/settle-station", {
      loads: [{
        truckNumber: PLATE, dateLoaded: "2026-09-25", customerId: plantId, allocationCode: CODE,
        quantity: 20000, rate: 1200,
      }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows = await rowsOf(plantId);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.book === "trucking"));
    assert.equal(Number(rows[0].quantity), 20000);
    assert.equal(Number(rows[1].payment_amount), 24000000);
  });

  test("an ordinary customer is not settled from a station account", async () => {
    const res = await post("/settle-station", {
      loads: [{ truckNumber: PLATE, dateLoaded: DAY, customerId, allocationCode: CODE, rate: 900, quantity: 1000 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not a filling station or LPG plant/);
  });

  test("a credit claimed for a station with no book named is its deposit; named, the truck sale's", async () => {
    const own = await makeStatementLine(1200000, "KANO FS TELLER");
    let res = await post("/", {
      truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, allocationCode: CODE,
      bankAccountId: own.bankAccountId, lineIds: own.lineIds,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.sale.book, "station");

    const desk = await makeStatementLine(500000, "KANO FS TO PFI");
    res = await post("/", {
      truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, allocationCode: CODE,
      bankAccountId: desk.bankAccountId, lineIds: desk.lineIds, book: "trucking",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.sale.book, "trucking");
  });

  test("whoever enters a station's deposits does not hold up the delivery desk", async () => {
    const enterer = await staffTokenWithRoles(["accountant"], `books-enterer-${RUN}@soroman.test`);
    const desk = await staffTokenWithRoles(["accountant"], `books-desk-${RUN}@soroman.test`);
    await client`
      INSERT INTO station_entry_staff (delivery_customer_id, pfi_id, entry_kind, staff_id)
      VALUES (${stationId}, NULL, 'deposits', ${enterer.staff.id}), (${stationId}, NULL, 'sales', ${enterer.staff.id})`;

    // The station's own deposit: refused to anybody else.
    let res = await post("/", {
      truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, allocationCode: CODE, paymentAmount: 1000,
    }, desk.accessToken);
    assert.equal(res.status, 403);

    // Its share of a new load and the settlement of it: the desk's.
    res = await post("/settle-station", {
      loads: [{ truckNumber: PLATE, dateLoaded: "2026-09-28", customerId: stationId, allocationCode: CODE, quantity: 5000, rate: 950 }],
    }, desk.accessToken);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test("a batch counts the station's charge, never its pump sales or deposits", () => {
    const customers = [
      { id: stationId, customerType: "filling_station" },
      { id: customerId, customerType: "customer" },
    ];
    const entries = [{ id: 1, truckNumber: PLATE, dateAllocated: DAY, allocationCode: CODE, quantityAllocated: 30000, customerId: stationId }];
    const sale = (o) => ({ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, ...o });
    const sales = [
      sale({ id: 1, book: "trucking", quantity: 30000, rate: 950, salesValue: 28500000 }),
      sale({ id: 2, book: "trucking", paymentAmount: 10000000, paymentMethod: "station_account" }),
      sale({ id: 3, book: "station", quantity: 8000, rate: 1000, salesValue: 8000000 }),
      sale({ id: 4, book: "station", quantity: 9000, rate: 1000, salesValue: 9000000 }),
      sale({ id: 5, book: "station", paymentAmount: 16000000 }),
    ];
    const b = summariseBatches({ entries, sales, customers }).get(CODE);
    assert.equal(b.salesValue, 28500000);
    assert.equal(b.paid, 10000000);
    assert.equal(b.unpaid, 18500000);
  });

  test("a station's share nobody has charged owes nothing, even on a split truck priced for another buyer", () => {
    const customers = [
      { id: stationId, customerType: "filling_station" },
      { id: customerId, customerType: "customer" },
    ];
    const entries = [{ id: 1, truckNumber: PLATE, dateAllocated: DAY, allocationCode: CODE, quantityAllocated: 33000, customerId: stationId }];
    const sale = (o) => ({ truckNumber: PLATE, dateLoaded: DAY, book: "trucking", ...o });
    const b = summariseBatches({
      entries,
      sales: [
        sale({ id: 1, customerId: stationId, quantity: 17000 }),
        sale({ id: 2, customerId, quantity: 16000, rate: 965, salesValue: 15440000, paymentAmount: 15440000 }),
      ],
      customers,
    }).get(CODE);
    assert.equal(b.salesValue, 15440000);
    assert.equal(b.unpaid, 0);
  });

  test("a station's position reads its own days, and its share off the truck sale", () => {
    const loading = { id: 1, truckNumber: PLATE, dateAllocated: DAY, allocationCode: CODE, quantityAllocated: 45000, customerId: stationId };
    const sale = (o) => ({ truckNumber: PLATE, dateLoaded: DAY, customerId: stationId, ...o });
    const [r] = buildStationRestocks([loading], [
      sale({ id: 1, book: "trucking", quantity: 30000, rate: 950, salesValue: 28500000 }),
      sale({ id: 2, book: "trucking", paymentAmount: 28500000, paymentMethod: "station_account" }),
      sale({ id: 3, book: "station", quantity: 8000, rate: 1000, salesValue: 8000000, dateOfPayment: DAY }),
      sale({ id: 4, book: "station", paymentAmount: 7500000, dateOfPayment: DAY }),
    ], DAY);
    assert.equal(r.quantity, 30000, "its share of a split truck, not the truck");
    assert.equal(r.quantitySold, 8000);
    assert.equal(r.salesValue, 8000000, "the charge is not a pump sale");
    assert.equal(r.deposits, 7500000, "the settlement is not a deposit");
    assert.equal(r.stockLeft, 22000);
  });
});
