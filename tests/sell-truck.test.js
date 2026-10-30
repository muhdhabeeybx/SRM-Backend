require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");
const { CATALOG } = require("../notifications/catalog");

/**
 * Selling a truck, and who takes its money — the Sell truck dialog
 * (POST /api/delivery-sales/sell-truck) and the finance-only payment rule.
 *
 * A truck is sold to one or more customers at their own rates; more can be
 * sold off it later while litres remain. Its payments are finance's.
 */
const RUN = `ST${Date.now()}`.slice(-10);
const PLATE = `ST${RUN.slice(-6)}`;
const DAY = "2026-10-20";
const CODE = `PFI-60B-${RUN}`;

describe("selling a truck", () => {
  let admin;
  let seller;
  let loadId;
  let musa;
  let ali;
  let bala;
  let station;

  const sell = (token, lines, id = loadId) =>
    request(app)
      .post("/api/delivery-sales/sell-truck")
      .set("Authorization", `Bearer ${token}`)
      .send({ loadingId: id, lines });

  before(async () => {
    admin = await staffToken(request, app);
    ({ accessToken: seller } = await staffTokenWithRoles(["truck_sales"], "test-truck-seller@soroman.test"));
    const made = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code) VALUES
        (${`${RUN} Musa`}, 'customer', '0800000401', ${`CUST-${RUN}-1`}),
        (${`${RUN} Ali`}, 'customer', '0800000402', ${`CUST-${RUN}-2`}),
        (${`${RUN} Bala`}, 'customer', '0800000403', ${`CUST-${RUN}-3`}),
        (${`${RUN} Kano FS`}, 'filling_station', '0800000404', ${`STN-${RUN}`})
      RETURNING id, name`;
    [musa, ali, bala, station] = made.map((c) => Number(c.id));
    const [load] = await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, quantity_allocated, loading_status, date_allocated, depot)
      VALUES (${CODE}, ${PLATE}, 50000, 'loaded', ${DAY}, 'Dangote Lekki')
      RETURNING id`;
    loadId = Number(load.id);
  });

  after(async () => {
    const ids = [musa, ali, bala, station];
    await client`DELETE FROM delivery_sales WHERE customer_id = ANY(${ids})`;
    await client`DELETE FROM delivery_inventory WHERE id = ${loadId}`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${ids})`;
    await closeDb();
  });

  test("one truck to two customers, each at their own rate", async () => {
    const res = await sell(seller, [
      { customerId: musa, quantity: 30000, rate: "1350", location: "Kano" },
      { customerId: ali, quantity: 15000, rate: 1340.5, location: "Potiskum", phoneNumber: "0800000999" },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { sales, load } = res.body.data;
    assert.equal(sales.length, 2);
    const byCustomer = new Map(sales.map((s) => [Number(s.customerId), s]));
    const m = byCustomer.get(musa);
    assert.equal(m.truckNumber, PLATE);
    assert.equal(m.dateLoaded, DAY);
    assert.equal(m.depotLoaded, "Dangote Lekki");
    assert.equal(m.allocationCode, CODE);
    assert.equal(m.location, "Kano");
    assert.equal(Number(m.rate), 1350);
    assert.equal(Number(m.salesValue), 40_500_000);
    assert.equal(Number(m.paymentAmount), 0);
    assert.equal(m.book, "trucking");
    assert.equal(Number(byCustomer.get(ali).salesValue), 20_107_500);
    assert.equal(byCustomer.get(ali).phoneNumber, "0800000999");
    assert.deepEqual([load.total, load.sold, load.left], [50000, 45000, 5000]);

    // The load names its first buyer, as the old assign page did, and is
    // offloaded the moment it is sold.
    const [row] = await client`
      SELECT customer_id, location, loading_status::text AS status, date_offloaded, offloaded_by
        FROM delivery_inventory WHERE id = ${loadId}`;
    assert.equal(Number(row.customer_id), musa);
    assert.equal(row.location, "Kano");
    assert.equal(row.status, "offloaded");
    assert.match(row.date_offloaded, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.offloaded_by);
  });

  test("never more than is left on the truck", async () => {
    const res = await sell(seller, [{ customerId: bala, quantity: 6000, rate: "1350", location: "Gombe" }]);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /Only 5,000 Litres are left/);
  });

  test("a customer already on the truck is changed from Edit, not sold twice", async () => {
    const res = await sell(seller, [{ customerId: musa, quantity: 1000, rate: "1350", location: "Kano" }]);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /already on this truck/);
  });

  test("a customer needs a rate and a destination; the same customer twice is refused", async () => {
    let res = await sell(seller, [{ customerId: bala, quantity: 1000, location: "Gombe" }]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body.errors), /rate/);
    res = await sell(seller, [{ customerId: bala, quantity: 1000, rate: "0", location: "Gombe" }]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /rate/);
    res = await sell(seller, [{ customerId: bala, quantity: 1000, rate: "1350" }]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /where/);
    res = await sell(seller, [
      { customerId: bala, quantity: 1000, rate: "1350", location: "Gombe" },
      { customerId: bala, quantity: 1000, rate: "1350", location: "Gombe" },
    ]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  test("the rest sold later, to one of our stations, priced like any customer", async () => {
    let res = await sell(seller, [{ customerId: station, quantity: 5000 }]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    res = await sell(seller, [{ customerId: station, quantity: 5000, rate: "1332", location: "ignored" }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [sale] = res.body.data.sales;
    assert.equal(sale.location, `${RUN} Kano FS`);
    assert.equal(Number(sale.salesValue), 6_660_000);
    assert.equal(sale.book, "trucking");
    assert.equal(res.body.data.load.left, 0);
  });

  test("an unknown truck is not found", async () => {
    const res = await sell(seller, [{ customerId: bala, quantity: 1, rate: "1", location: "x" }], 2_000_000_000);
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  test("its payments are finance's", async () => {
    const payment = {
      truckNumber: PLATE,
      dateLoaded: DAY,
      customerId: musa,
      allocationCode: CODE,
      paymentAmount: "1000000",
      book: "trucking",
    };
    let res = await request(app).post("/api/delivery-sales").set("Authorization", `Bearer ${seller}`).send(payment);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.message, /finance/);

    const { accessToken: finance } = await staffTokenWithRoles(["finance"], "test-truck-finance@soroman.test");
    res = await request(app).post("/api/delivery-sales").set("Authorization", `Bearer ${finance}`).send(payment);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const paymentId = res.body.data.sale.id;

    // Nor slipped in as an edit, taken off, or moved to another truck.
    res = await request(app)
      .patch(`/api/delivery-sales/${paymentId}`)
      .set("Authorization", `Bearer ${seller}`)
      .send({ paymentAmount: "2000000" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    res = await request(app).delete(`/api/delivery-sales/${paymentId}`).set("Authorization", `Bearer ${seller}`);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    res = await request(app)
      .post("/api/delivery-sales/transfer")
      .set("Authorization", `Bearer ${seller}`)
      .send({
        from: { truckNumber: PLATE, dateLoaded: DAY, customerId: musa },
        to: [{ truckNumber: PLATE, dateLoaded: DAY, customerId: ali, amount: "1000" }],
      });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    res = await request(app).delete(`/api/delivery-sales/${paymentId}`).set("Authorization", `Bearer ${finance}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // A sale with no money on it stays open to the seller.
    res = await request(app)
      .post("/api/delivery-sales")
      .set("Authorization", `Bearer ${seller}`)
      .send({ ...payment, paymentAmount: undefined, remarks: "note" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });
});

describe("the texts a sale sends", () => {
  const base = {
    truckNumber: "BWR835XB",
    product: "PMS",
    allocationCode: "PFI-38B",
    driverName: "Musa Ali",
    driverPhone: "08031234567",
  };

  test("the customer: what they bought, from which truck, and where to pay", () => {
    const sms = CATALOG["delivery.sold_customer"].sms({
      ...base,
      customerName: "Bello Trading",
      quantity: 30000,
      rate: 1350,
      value: 40500000,
      destination: "Kano",
      account: { accountName: "SOROMAN NIGERIA LTD", accountNumber: "1234567890", bankName: "Zenith Bank" },
    });
    assert.match(sms, /Good day Bello Trading\. You have bought 30,000 Litres of PMS on truck BWR835XB at N1,350 per litre, N40,500,000 in total, for delivery to Kano\./);
    assert.match(sms, /Your driver is Musa Ali on 08031234567\./);
    assert.match(sms, /Kindly pay into SOROMAN NIGERIA LTD 1234567890 - Zenith Bank\./);
  });

  test("one of our stations is told the same, and where to pay", () => {
    const sms = CATALOG["delivery.sold_customer"].sms({
      ...base, customerName: "Kano FS", quantity: 5000, rate: 1332, value: 6660000, destination: "Kano FS",
      account: { accountName: "SOROMAN", accountNumber: "1", bankName: "Zenith Bank" },
    });
    assert.match(sms, /You have bought 5,000 Litres of PMS on truck BWR835XB at N1,332 per litre, N6,660,000 in total, for delivery to Kano FS\./);
    assert.match(sms, /Kindly pay into SOROMAN 1 - Zenith Bank\./);
  });

  test("the driver: every drop and how to reach them", () => {
    const sms = CATALOG["delivery.sold_driver"].sms({
      ...base,
      lines: [
        { customerName: "Bello", customerPhone: "0802", quantity: 30000, destination: "Kano" },
        { customerName: "Ali", customerPhone: "", quantity: 20000, destination: "Potiskum" },
      ],
    });
    assert.equal(
      sms,
      "Good day Musa Ali. Your truck BWR835XB has been sold. " +
        "Please deliver 30,000 Litres to Bello at Kano, phone 0802 and 20,000 Litres to Ali at Potiskum.",
    );
  });

});
