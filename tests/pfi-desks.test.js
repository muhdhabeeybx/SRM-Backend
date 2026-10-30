require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffScopeRepo } = require("../repositories");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");
const { doubleDeskRefusal } = require("../lib/pfiDesks");

/**
 * Who sells a trucking batch and who takes its money, off its PFI's officers
 * (lib/pfiDesks.js) — and what a station's or plant's finance desk sees
 * (lib/saleReach.js). The owner, 30 Oct 2026.
 */
const RUN = `PD${Date.now()}`.slice(-10);
const CODE = `PFI-61D-${RUN}`;
const OTHER_CODE = `PFI-61E-${RUN}`;
const OPEN_CODE = `PFI-61F-${RUN}`;
const DAY = "2026-10-21";
const PLATE = `PD${RUN.slice(-6)}`;

describe("the batch's own desks", () => {
  let admin;
  const tokens = {};
  const ids = {};
  let pfiId;
  let otherPfiId;
  let openPfiId;
  let loadId;
  let customer;
  let station;
  let otherStation;
  let account;

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const post = (who, url, body) => request(app).post(url).set(as(who)).send(body);

  before(async () => {
    admin = await staffToken(request, app);
    for (const [who, roles] of [
      ["seller", ["truck_sales"]],
      ["finance", ["finance"]],
      ["otherFinance", ["finance"]],
      ["stationsDesk", ["finance"]],
    ]) {
      const made = await staffTokenWithRoles(roles, `pfi-desks-${who.toLowerCase()}-${RUN}@soroman.test`);
      tokens[who] = made.accessToken;
      ids[who] = Number(made.staff.id);
    }

    const pfis = await client`
      INSERT INTO pfis (pfi_number, status, pfi_type, starting_qty_litres, allocation_code, audit_officer_id, sales_manager_id)
      VALUES (${`${RUN} 61D`}, 'active', 'trucking', 60000, ${CODE}, ${ids.finance}, ${ids.seller}),
             (${`${RUN} 61E`}, 'active', 'trucking', 60000, ${OTHER_CODE}, ${ids.otherFinance}, ${ids.seller}),
             (${`${RUN} 61F`}, 'active', 'trucking', 60000, ${OPEN_CODE}, NULL, NULL)
      RETURNING id`;
    [pfiId, otherPfiId, openPfiId] = pfis.map((p) => Number(p.id));

    const made = await client`
      INSERT INTO delivery_customers (name, customer_type, phone_number, customer_code) VALUES
        (${`${RUN} Musa`}, 'customer', '0800000501', ${`CUST-${RUN}-1`}),
        (${`${RUN} Dambam FS`}, 'filling_station', '0800000502', ${`STN-${RUN}-1`}),
        (${`${RUN} Ningi FS`}, 'filling_station', '0800000503', ${`STN-${RUN}-2`})
      RETURNING id`;
    [customer, station, otherStation] = made.map((c) => Number(c.id));

    const [load] = await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, quantity_allocated, loading_status, date_allocated, depot, pfi_id)
      VALUES (${CODE}, ${PLATE}, 45000, 'loaded', ${DAY}, 'Calabar', ${pfiId})
      RETURNING id`;
    loadId = Number(load.id);

    // A station truck on another batch, and its pump sales there.
    await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, quantity_allocated, loading_status, date_allocated, depot, pfi_id, customer_id)
      VALUES (${OTHER_CODE}, ${`${PLATE}S`}, 33000, 'offloaded', ${DAY}, 'Calabar', ${otherPfiId}, ${station})`;
    await client`
      INSERT INTO delivery_sales (customer_id, customer_name, truck_number, date_loaded, allocation_code, quantity, sales_value, book)
      VALUES (${station}, ${`${RUN} Dambam FS`}, ${`${PLATE}S`}, ${DAY}, ${OTHER_CODE}, 1000, 1000000, 'station'),
             (${otherStation}, ${`${RUN} Ningi FS`}, ${`${PLATE}N`}, ${DAY}, ${OTHER_CODE}, 1000, 1000000, 'station'),
             (${customer}, ${`${RUN} Musa`}, ${`${PLATE}C`}, ${DAY}, ${CODE}, 1000, 1000000, 'trucking')`;

    const [acct] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status, pfi_ids, filling_station_ids)
      VALUES ('Zenith Bank', ${`${RUN} Stations`}, ${`9${RUN.slice(-9)}`}, 'Active', ${JSON.stringify([otherPfiId])}::jsonb, ${JSON.stringify([station])}::jsonb)
      RETURNING id`;
    account = Number(acct.id);

    // The stations' finance desk: one PFI of their own, and the station.
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${ids.stationsDesk}`;
    await staffScopeRepo.setScope(ids.stationsDesk, { pfiIds: [pfiId], fillingStationIds: [station] });
  });

  after(async () => {
    const people = Object.values(ids);
    const customers = [customer, station, otherStation];
    await client`DELETE FROM delivery_sales WHERE customer_id = ANY(${customers})`;
    await client`DELETE FROM delivery_inventory WHERE allocation_code = ANY(${[CODE, OTHER_CODE, OPEN_CODE]})`;
    await client`DELETE FROM bank_accounts WHERE id = ${account}`;
    await client`DELETE FROM filling_station_staff WHERE staff_id = ANY(${people})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${people})`;
    await client`DELETE FROM pfis WHERE id = ANY(${[pfiId, otherPfiId, openPfiId]})`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${customers})`;
    await closeDb();
  });

  test("the list names each batch's sellers and finance officer", async () => {
    const res = await request(app).get("/api/delivery-sales/desks").set(as("seller"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const desk = res.body.data.desks.find((d) => d.code === CODE);
    assert.equal(desk.pfiId, pfiId);
    assert.deepEqual(desk.sellers.map((p) => p.id), [ids.seller]);
    assert.deepEqual(desk.finance.map((p) => p.id), [ids.finance]);
    const open = res.body.data.desks.find((d) => d.code === OPEN_CODE);
    assert.deepEqual([open.sellers, open.finance], [[], []]);
  });

  test("only the batch's sales manager sells its trucks; admins always may", async () => {
    const line = [{ customerId: customer, quantity: 10000, rate: "1350", location: "Kano" }];
    let res = await post("finance", "/api/delivery-sales/sell-truck", { loadingId: loadId, lines: line });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.message, new RegExp(`${CODE}'s trucks are sold by Weak Staff`));

    res = await post("seller", "/api/delivery-sales/sell-truck", { loadingId: loadId, lines: line });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    res = await request(app).post("/api/delivery-sales/sell-truck").set("Authorization", `Bearer ${admin}`).send({
      loadingId: loadId,
      lines: [{ customerId: station, quantity: 5000, rate: "1332" }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test("only the batch's finance officer takes its money, not any finance", async () => {
    const payment = {
      truckNumber: PLATE, dateLoaded: DAY, customerId: customer, allocationCode: CODE, paymentAmount: "500000", book: "trucking",
    };
    let res = await post("otherFinance", "/api/delivery-sales", payment);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.message, new RegExp(`Payments on ${CODE}'s trucks are confirmed by`));

    res = await post("seller", "/api/delivery-sales", payment);
    assert.equal(res.status, 403, JSON.stringify(res.body));

    res = await post("finance", "/api/delivery-sales", payment);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const paymentId = res.body.data.sale.id;

    res = await request(app).patch(`/api/delivery-sales/${paymentId}`).set(as("otherFinance")).send({ paymentAmount: "1" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    res = await request(app).delete(`/api/delivery-sales/${paymentId}`).set(as("otherFinance"));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    res = await request(app).delete(`/api/delivery-sales/${paymentId}`).set(as("finance"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("the sale itself is the seller's to correct, its money finance's", async () => {
    const [share] = await client`
      SELECT id FROM delivery_sales WHERE truck_number = ${PLATE} AND customer_id = ${customer} AND book = 'trucking' LIMIT 1`;
    let res = await request(app).patch(`/api/delivery-sales/${share.id}`).set(as("finance")).send({ rate: "1400", salesValue: "14000000" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.message, /are sold by/);
    // Resending a field unchanged is not a change.
    res = await request(app).patch(`/api/delivery-sales/${share.id}`).set(as("finance")).send({ rate: "1350", remarks: "checked" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await request(app).patch(`/api/delivery-sales/${share.id}`).set(as("seller")).send({ rate: "1400", salesValue: "14000000" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("a batch naming nobody keeps the old rule: anyone sells, any finance takes the money", async () => {
    const payment = {
      truckNumber: `${PLATE}O`, dateLoaded: DAY, customerId: customer, allocationCode: OPEN_CODE, paymentAmount: "1000", book: "trucking",
    };
    let res = await post("seller", "/api/delivery-sales", payment);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.message, /Only finance/);
    res = await post("otherFinance", "/api/delivery-sales", payment);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test("a station's desk sees the station on every batch, and its own PFI's customers", async () => {
    const res = await request(app).get(`/api/delivery-sales?search=${RUN}&limit=200`).set(as("stationsDesk"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const seen = new Set(res.body.data.sales.map((s) => Number(s.customerId)));
    assert.ok(seen.has(station), "the station's rows on another batch");
    assert.ok(seen.has(customer), "a customer on their own PFI's batch");
    assert.ok(!seen.has(otherStation), "not another station on a batch that is not theirs");

    const loads = await request(app).get(`/api/delivery-inventory?search=${PLATE}&limit=200`).set(as("stationsDesk"));
    assert.equal(loads.status, 200, JSON.stringify(loads.body));
    const plates = loads.body.data.loadings.map((l) => l.truckNumber);
    assert.ok(plates.includes(`${PLATE}S`), "the station's truck off another batch");
    assert.ok(plates.includes(PLATE), "their own PFI's truck");
  });

  test("a station's desk may open the station's bank account", async () => {
    const res = await request(app).get(`/api/bank-statements/accounts/${account}/lines`).set(as("stationsDesk"));
    assert.notEqual(res.status, 403, JSON.stringify(res.body));
    const other = await request(app).get(`/api/bank-statements/accounts/${account}/lines`).set(as("otherFinance"));
    assert.ok([200, 403].includes(other.status));
  });

  test("a PFI cannot name one person for its money and its selling", async () => {
    assert.match(doubleDeskRefusal({ auditOfficerId: 7, salesManagerId: 7 }), /Finance \/ Audit Officer and the Sales Manager/);
    assert.match(doubleDeskRefusal({ auditOfficerId: 7, truckSalesOfficerId: "7" }), /Truck Sales Officer/);
    assert.equal(doubleDeskRefusal({ auditOfficerId: 7, salesManagerId: 8 }), null);
    assert.equal(doubleDeskRefusal({ salesManagerId: 8 }), null);

    let res = await request(app).patch(`/api/pfis/${pfiId}`).set("Authorization", `Bearer ${admin}`).send({ salesManagerId: ids.finance });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /cannot be both/);

    // A PFI already naming one person for both still saves its other edits.
    await client`UPDATE pfis SET sales_manager_id = ${ids.finance} WHERE id = ${pfiId}`;
    res = await request(app).patch(`/api/pfis/${pfiId}`).set("Authorization", `Bearer ${admin}`).send({
      description: "edited", auditOfficerId: ids.finance, salesManagerId: ids.finance,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await client`UPDATE pfis SET sales_manager_id = ${ids.seller} WHERE id = ${pfiId}`;
  });
});
