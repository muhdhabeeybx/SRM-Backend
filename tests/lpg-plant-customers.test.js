require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffScopeRepo } = require("../repositories");
const { isStationType, CUSTOMER_TYPES } = require("../lib/customerTypes");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * LPG plants as delivery customers — migration 0061.
 *
 * A plant registers through /delivery-customers like a filling station does,
 * may be linked to the lpg_stations plant it is (one account per plant), and
 * is read back through /lpg-plants — narrowed, for someone assigned plants,
 * to the plants they hold.
 */
const RUN = `LP${Date.now()}`.slice(-10);

describe("LPG plant customers", () => {
  let admin;
  let scoped;
  let staffId;
  let plantA;
  let plantB;
  const customerIds = [];

  const auth = (req, token = admin) => req.set("Authorization", `Bearer ${token}`);
  const get = (url, token) => auth(request(app).get(url), token);
  const post = (url, body) => auth(request(app).post(url)).send(body);
  const patch = (url, body) => auth(request(app).patch(url)).send(body);

  before(async () => {
    admin = await staffToken(request, app);
    const plants = await client`
      INSERT INTO lpg_stations (name, code, address, city, state, country, postcode, lpg_capacity_kg, established_year)
      VALUES (${`${RUN} Kano Plant`}, ${`${RUN}K`}, 'x', 'Kano', 'Kano', 'NG', '0', 20000, '2020'),
             (${`${RUN} Bauchi Plant`}, ${`${RUN}B`}, 'x', 'Bauchi', 'Bauchi', 'NG', '0', 20000, '2020')
      RETURNING id`;
    plantA = Number(plants[0].id);
    plantB = Number(plants[1].id);

    const weak = await staffTokenWithRoles(["admin"], `lpg-plant-scope-${RUN}@soroman.test`);
    staffId = weak.staff.id;
    scoped = weak.accessToken;
  });

  after(async () => {
    if (customerIds.length) await client`DELETE FROM delivery_customers WHERE id = ANY(${customerIds})`;
    await client`DELETE FROM delivery_customers WHERE name LIKE ${`${RUN}%`}`;
    if (staffId) await client`DELETE FROM lpg_station_staff WHERE staff_id = ${staffId}`;
    await client`DELETE FROM lpg_stations WHERE id = ANY(${[plantA, plantB].filter(Boolean)})`;
    await closeDb();
  });

  test("an LPG plant is a station type, and the API accepts it", () => {
    assert.ok(CUSTOMER_TYPES.includes("lpg_plant"));
    assert.equal(isStationType("lpg_plant"), true);
    assert.equal(isStationType("filling_station"), true);
    assert.equal(isStationType("customer"), false);
  });

  test("registering a plant keeps its site fields, its link and an LPG code", async () => {
    const res = await post("/api/delivery-customers", {
      customerType: "lpg_plant",
      name: `${RUN} Kano LPG`,
      phoneNumber: "0800000001",
      contactPerson: "Plant Manager",
      stationAddress: "Sharada, Kano",
      tankCapacity: 20000,
      pumpCount: 4,
      lpgStationId: plantA,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const c = res.body.data;
    customerIds.push(Number(c.id));
    assert.equal(c.customerType, "lpg_plant");
    assert.match(c.customerCode, /^LPG-/);
    assert.equal(c.lpgStationId, plantA);
    assert.equal(c.stationAddress, "Sharada, Kano");
    assert.equal(c.tankCapacity, 20000);
    assert.equal(c.pumpCount, 4);
    assert.match(res.body.message, /LPG Plant/);
  });

  test("a filling station saves with the capacity the form sends — 0 when blank", async () => {
    // Regression: validation turned the capacity into "0.00", which the
    // integer column refused, so no station could be saved through the form.
    for (const tankCapacity of [0, 45000]) {
      const res = await post("/api/delivery-customers", {
        customerType: "filling_station", name: `${RUN} Fuel ${tankCapacity}`, phoneNumber: "0800000004", tankCapacity,
      });
      // Not kept in customerIds, which the tests below index by position;
      // `after` removes every customer named for this run.
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.tankCapacity, tankCapacity);
      assert.equal(res.body.data.lpgStationId, null, "only a plant is linked to a plant");
    }
  });

  test("a settlement account is kept, on registering and on editing", async () => {
    // Regression: bankDetails was not in the validation list, so it was
    // dropped on the way in and never saved.
    const res = await post("/api/delivery-customers", {
      customerType: "customer", name: `${RUN} Banked`, phoneNumber: "0800000005",
      bankDetails: { bankName: "Zenith Bank", accountNumber: "0123456789", accountName: "Musa Ali" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.bankDetails, { bankName: "Zenith Bank", accountNumber: "0123456789", accountName: "Musa Ali" });

    const changed = await patch(`/api/delivery-customers/${res.body.data.id}`, {
      bankDetails: { bankName: "Access Bank", accountNumber: "9876543210", accountName: "Musa Ali" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.bankDetails.bankName, "Access Bank");
  });

  test("a customer's totals count each load once, however many instalments paid it", async () => {
    // Regression: the totals were a plain SUM over sale rows, and every
    // instalment row repeats the load — a ₦70m truck paid in three parts
    // came back as ₦210m sold.
    const made = await post("/api/delivery-customers", {
      customerType: "customer", name: `${RUN} Instalments`, phoneNumber: "0800000006",
    });
    const cid = Number(made.body.data.id);
    const truck = `${RUN}T`;
    for (const paid of [25_000_000, 30_000_000, 10_000_000]) {
      await client`
        INSERT INTO delivery_sales (customer_id, customer_name, truck_number, date_loaded, quantity, rate, sales_value, payment_amount)
        VALUES (${cid}, ${`${RUN} Instalments`}, ${truck}, '2026-09-14', 50000, 1400, 70000000, ${paid})`;
    }
    const res = await get(`/api/delivery-customers/${cid}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body.data.totalSalesValue), 70_000_000);
    assert.equal(Number(res.body.data.totalQty), 50_000);
    assert.equal(Number(res.body.data.totalPayments), 65_000_000);
    assert.equal(Number(res.body.data.outstanding), 5_000_000);
    await client`DELETE FROM delivery_sales WHERE customer_id = ${cid}`;
  });

  test("a plant already registered cannot be registered again", async () => {
    const res = await post("/api/delivery-customers", {
      customerType: "lpg_plant", name: `${RUN} Duplicate`, phoneNumber: "0800000002", lpgStationId: plantA,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /already registered/);
  });

  test("a plant that is not ours registers with no link", async () => {
    const res = await post("/api/delivery-customers", {
      customerType: "lpg_plant", name: `${RUN} Third Party`, phoneNumber: "0800000003",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    customerIds.push(Number(res.body.data.id));
    assert.equal(res.body.data.lpgStationId, null);
  });

  test("a customer opens by id, with its sales totals", async () => {
    const res = await get(`/api/delivery-customers/${customerIds[0]}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.name, `${RUN} Kano LPG`);
    assert.equal(res.body.data.totalQty, 0);
    assert.equal((await get("/api/delivery-customers/999999999")).status, 404);
  });

  test("the plant register lists plants alone, each naming its linked plant", async () => {
    const res = await get(`/api/lpg-plants?search=${RUN}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.data.plants;
    assert.deepEqual(rows.map((r) => Number(r.id)).sort(), [...customerIds].sort());
    const kano = rows.find((r) => Number(r.id) === customerIds[0]);
    assert.equal(kano.lpgStation.name, `${RUN} Kano Plant`);

    const byType = await get(`/api/delivery-customers?type=lpg_plant&search=${RUN}`);
    assert.equal(byType.body.data.customers.length, 2);

    // …and the filling-station register lists its own stations, not them.
    const stations = await get(`/api/filing-stations?search=${RUN}`);
    const stationIds = stations.body.data.stations.map((r) => Number(r.id));
    assert.equal(stationIds.length, 2, "the two stations saved above");
    assert.ok(customerIds.every((id) => !stationIds.includes(id)));
  });

  test("someone assigned a plant sees that plant's account and no other", async () => {
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${staffId}`;
    await staffScopeRepo.setScope(staffId, { lpgStationIds: [plantA] });

    const res = await get(`/api/lpg-plants?search=${RUN}`, scoped);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.plants.map((r) => Number(r.id)), [customerIds[0]]);

    assert.equal((await get(`/api/lpg-plants/${customerIds[0]}`, scoped)).status, 200);
    // The unlinked plant is not theirs, and says "not found" rather than "forbidden".
    assert.equal((await get(`/api/lpg-plants/${customerIds[1]}`, scoped)).status, 404);
  });

  test("a filling station is not an LPG plant, by id", async () => {
    const [fs] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`${RUN} Fuel`}, '0800000009') RETURNING id`;
    customerIds.push(Number(fs.id));
    assert.equal((await get(`/api/lpg-plants/${fs.id}`)).status, 404);
  });

  test("moving the link checks the new plant; reclassifying away frees it", async () => {
    const third = customerIds[1];
    const taken = await patch(`/api/delivery-customers/${third}`, { lpgStationId: plantA });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));

    const moved = await patch(`/api/delivery-customers/${third}`, { lpgStationId: plantB });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.lpgStationId, plantB);

    const away = await patch(`/api/delivery-customers/${third}`, { customerType: "customer" });
    assert.equal(away.status, 200, JSON.stringify(away.body));
    assert.equal(away.body.data.lpgStationId, null, "a customer that is no longer a plant lets the plant go");
  });
});
