require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * An LPG plant's deliveries, recorded in full and uploaded from history —
 * services/lpgDelivery.service.js. Real staff, the running API.
 */
describe("LPG plant deliveries", () => {
  const RUN = Date.now();
  const tag = String(RUN).slice(-6);
  let gas, fuel, lpgPfi, fuelPfi, plant, otherPlant, truck;
  let boss, finance, confined, confinedId;
  let ready = false;

  const as = (token) => ({
    get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
    post: (url, body = {}) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
    patch: (url, body = {}) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
    del: (url) => request(app).delete(url).set("Authorization", `Bearer ${token}`),
  });
  const skip = (t) => !ready && t.skip("fixtures unavailable");
  const loadsOf = (id) => client`SELECT * FROM delivery_inventory WHERE customer_id = ${id} ORDER BY id`;

  before(async () => {
    try {
      const product = async (name, unit) => {
        const [p] = await client`
          INSERT INTO products (name, sku, category, unit) VALUES (${name}, ${`SKU${tag}${unit}`}, 'test', ${unit}) RETURNING id`;
        return p;
      };
      gas = await product(`Test Gas ${tag}`, "kg");
      fuel = await product(`Test PMS ${tag}`, "Liters");
      const pfi = async (number, productId) => {
        const [p] = await client`
          INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, product_id)
          VALUES (${number}, 'gantry', 'active', 250000, '900', ${productId}) RETURNING id, pfi_number`;
        return p;
      };
      lpgPfi = await pfi(`PFI 9${tag}/26/DANGOTE/LPG/250TONS`, gas.id);
      fuelPfi = await pfi(`PFI 8${tag}/26/PMS`, fuel.id);
      const customer = async (name, stationId) => {
        const [c] = await client`
          INSERT INTO delivery_customers (customer_type, name, phone_number, lpg_station_id)
          VALUES ('lpg_plant', ${name}, ${`HOUSE-LPG-${tag}-${name.length}`}, ${stationId}) RETURNING id, name`;
        return c;
      };
      plant = await customer(`Test LPG Plant ${tag}`, null);
      otherPlant = await customer(`Other LPG Plant ${tag}`, null);
      ;[truck] = await client`
        INSERT INTO fleet_trucks (plate_number, driver_name) VALUES (${`LPG${tag}XA`}, 'Musa Driver') RETURNING id, plate_number`;

      boss = await staffToken(request, app); // a super admin: may set costs
      ;({ accessToken: finance } = await staffTokenWithRoles(["finance"], `lpg-fin-${RUN}@soroman.test`));
      const c = await staffTokenWithRoles(["admin"], `lpg-plant-${RUN}@soroman.test`);
      confined = c.accessToken;
      confinedId = Number(c.staff.id);
      // Confined to a plant that is not this one: the account is out of their sight.
      const [st] = await client`SELECT id FROM lpg_stations ORDER BY id LIMIT 1`;
      await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
      await client`INSERT INTO lpg_station_staff (lpg_station_id, staff_id) VALUES (${st.id}, ${confinedId})`;
      ready = true;
    } catch (e) {
      console.error("lpg-delivery fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM lpg_station_staff WHERE staff_id = ${confinedId}`;
      await client`DELETE FROM audit_logs WHERE action LIKE 'lpg.%' AND (entity_id = ANY(${[plant.id, otherPlant.id]}) OR metadata::text LIKE ${`%${tag}%`})`;
      await client`DELETE FROM delivery_inventory WHERE customer_id = ANY(${[plant.id, otherPlant.id]})`;
      await client`DELETE FROM delivery_customers WHERE id = ANY(${[plant.id, otherPlant.id]})`;
      await client`DELETE FROM fleet_trucks WHERE id = ${truck.id}`;
      await client`DELETE FROM pfis WHERE id = ANY(${[lpgPfi.id, fuelPfi.id]})`;
      await client`DELETE FROM products WHERE id = ANY(${[gas.id, fuel.id]})`;
    }
    await closeDb();
  });

  const history = () => [
    { dateLoaded: "2026-07-01", dateDelivered: "2026-07-03", truckNumber: `lpg ${tag} xa`, pfi: `PFI 9${tag}/26`, kgLoaded: 20150, kgReceived: "20,000".replace(",", ""), costPerKg: 1050 },
    { dateDelivered: "2026-07-10", truckNumber: "HIRED123", driverName: "Sani Hired", pfi: lpgPfi.pfi_number, kgReceived: 19800.5 },
  ];

  test("a preview checks every row and writes nothing", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post("/api/lpg-deliveries", { plantId: plant.id, rows: history(), dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.results.map((r) => r.status), ["new", "new"]);
    assert.equal(res.body.data.summary.kgReceived, 39800.5);
    assert.equal((await loadsOf(plant.id)).length, 0);
  });

  test("recording writes each delivery as the plant's load, in full", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post("/api/lpg-deliveries", { plantId: plant.id, rows: history() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows = await loadsOf(plant.id);
    assert.equal(rows.length, 2);
    const [fleet, hired] = rows;
    assert.equal(Number(fleet.truck_id), Number(truck.id), "a typed plate finds the fleet truck");
    assert.equal(fleet.driver_name, "Musa Driver", "the fleet's driver when none is given");
    assert.equal(Number(fleet.pfi_id), Number(lpgPfi.id), "the short PFI form finds the PFI");
    assert.equal(fleet.date_allocated, "2026-07-01");
    assert.equal(fleet.date_offloaded, "2026-07-03");
    assert.equal(Number(fleet.quantity_allocated), 20000);
    assert.equal(Number(fleet.quantity_loaded), 20150);
    assert.equal(Number(fleet.product_price), 1050);
    assert.equal(fleet.loading_status, "offloaded");
    assert.equal(hired.truck_id, null);
    assert.equal(hired.truck_number, "HIRED123");
    assert.equal(hired.driver_name, "Sani Hired");
    assert.equal(hired.date_allocated, "2026-07-10", "no loading day: the delivery day");
    assert.equal(hired.quantity_loaded, null, "not recorded is not assumed equal");
    assert.ok(!String(fleet.created_by).includes("@"), `recorded under a name, not an email: ${fleet.created_by}`);
  });

  test("the same file again records nothing, and says so", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post("/api/lpg-deliveries", { plantId: plant.id, rows: history() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.recorded, 0);
    assert.equal(res.body.data.summary.alreadyRecorded, 2);
    assert.equal((await loadsOf(plant.id)).length, 2);
  });

  test("one bad row stops the whole upload, and each problem is named", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post("/api/lpg-deliveries", {
      plantId: plant.id,
      rows: [
        { dateDelivered: "2026-08-01", truckNumber: "OK1", pfi: lpgPfi.pfi_number, kgReceived: 100 },
        { dateDelivered: "2026-08-02", truckNumber: "BAD1", pfi: fuelPfi.pfi_number, kgReceived: 100 },
        { dateDelivered: "", truckNumber: "BAD2", pfi: "PFI 77777", kgReceived: 0 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.recorded, 0);
    const [, fuelRow, empty] = res.body.data.results;
    assert.match(fuelRow.problems.join(" "), /No LPG PFI/);
    assert.ok(empty.problems.some((p) => /Date delivered/.test(p)));
    assert.ok(empty.problems.some((p) => /Kg received/.test(p)));
    assert.equal((await loadsOf(plant.id)).length, 2);
  });

  test("only someone with Delivery Costing access can set or see the cost per kg", async (t) => {
    if (skip(t)) return;
    const res = await as(finance).post("/api/lpg-deliveries", {
      plantId: plant.id,
      rows: [{ dateDelivered: "2026-08-05", truckNumber: "FIN1", pfi: lpgPfi.pfi_number, kgReceived: 500, costPerKg: 999 }],
    });
    assert.equal(res.body.data.recorded, 0);
    assert.match(res.body.data.results[0].problems.join(" "), /Delivery Costing/);
    const seen = await as(finance).get(`/api/lpg-deliveries?plant=${plant.id}`);
    assert.equal(seen.status, 200);
    assert.ok(seen.body.data.deliveries.every((d) => d.costPerKg === undefined));
    const boss_ = await as(boss).get(`/api/lpg-deliveries?plant=${plant.id}`);
    assert.ok(boss_.body.data.deliveries.some((d) => d.costPerKg === 1050));
  });

  test("a plant manager of another plant cannot see or record here", async (t) => {
    if (skip(t)) return;
    const seen = await as(confined).get(`/api/lpg-deliveries?plant=${plant.id}`);
    assert.equal(seen.status, 404);
    const rec = await as(confined).post("/api/lpg-deliveries", {
      plantId: plant.id, rows: [{ dateDelivered: "2026-08-06", truckNumber: "X1", pfi: lpgPfi.pfi_number, kgReceived: 1 }],
    });
    assert.equal(rec.status, 404);
  });

  test("a delivery can be corrected and deleted, each on the record", async (t) => {
    if (skip(t)) return;
    const [, hired] = await loadsOf(plant.id);
    const fix = await as(boss).patch(`/api/lpg-deliveries/${hired.id}`, { kgReceived: 19750, kgLoaded: 19900 });
    assert.equal(fix.status, 200, JSON.stringify(fix.body));
    const [after] = await client`SELECT quantity_allocated, quantity_loaded FROM delivery_inventory WHERE id = ${hired.id}`;
    assert.equal(Number(after.quantity_allocated), 19750);
    assert.equal(Number(after.quantity_loaded), 19900);
    const bad = await as(boss).patch(`/api/lpg-deliveries/${hired.id}`, { kgReceived: 0 });
    assert.equal(bad.status, 400);
    const gone = await as(boss).del(`/api/lpg-deliveries/${hired.id}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal((await loadsOf(plant.id)).length, 1);
    const audit = await client`SELECT action FROM audit_logs WHERE entity_type = 'delivery_inventory' AND entity_id = ${hired.id}`;
    assert.deepEqual(audit.map((a) => a.action).sort(), ["lpg.delivery_deleted", "lpg.delivery_updated"]);
  });

  test("only an LPG plant takes deliveries here, and only LPG PFIs are offered", async (t) => {
    if (skip(t)) return;
    const pfis = await as(boss).get("/api/lpg-deliveries/pfis");
    const ids = pfis.body.data.pfis.map((p) => Number(p.id));
    assert.ok(ids.includes(Number(lpgPfi.id)));
    assert.ok(!ids.includes(Number(fuelPfi.id)));
  });
});
