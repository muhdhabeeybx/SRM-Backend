// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");

/**
 * Third-party trucks (0094).
 *
 * A hired truck is added where it is first needed — allocating trucks off a
 * PFI — and goes on the fleet register marked as the third party's, so every
 * screen that names a truck names it the same way. A plate already on the
 * register is never duplicated. Its trips are costed as haulage: the owner
 * buys AGO out of it and is paid haulage − AGO, and haulage never lands on
 * one of our own trucks.
 */
const RUN = Date.now();
const PLATE = `TP${RUN % 1000000}XB`;

let token;
let pfi;
let ours;
let hired;
let ourTrip;
let hiredTrip;

const as = () => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
});
const tripRow = async (id) => {
  const res = await as().get("/api/delivery-inventory?limit=1000");
  return res.body.data.inventory.find((r) => r.id === id);
};

describe("third-party trucks", () => {
  before(async () => {
    token = await staffToken(request, app);
    [pfi] = await client`
      INSERT INTO pfis (pfi_number, status, starting_qty_litres)
      VALUES (${`PFI/TP/${RUN}`}, 'active', 100000) RETURNING id, pfi_number`;
    [ours] = await client`
      INSERT INTO fleet_trucks (plate_number, max_capacity) VALUES (${`OWN${RUN % 1000000}XB`}, 45000) RETURNING id, plate_number`;
  });

  after(async () => {
    await client`DELETE FROM delivery_inventory WHERE id = ANY(${[ourTrip, hiredTrip].filter(Boolean)}::int[])`;
    await client`DELETE FROM fleet_trucks WHERE id = ANY(${[ours?.id, hired?.id].filter(Boolean)}::int[])`;
    await client`DELETE FROM pfis WHERE id = ${pfi.id}`;
    await closeDb();
  });

  test("a hired truck goes on the fleet marked as the third party's", async () => {
    const res = await as().post("/api/fleet/third-party", {
      plateNumber: `${PLATE.slice(0, 3).toLowerCase()} ${PLATE.slice(3)}`,
      maxCapacity: 40000,
      driverName: "Musa Bello",
      driverPhone: "08030000000",
      ownerName: "Bello Haulage",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    hired = res.body.data.truck;
    assert.equal(hired.plateNumber, PLATE, "written the way the register writes plates");
    assert.equal(hired.isThirdParty, true);
    assert.equal(hired.ownerName, "Bello Haulage");
    assert.equal(hired.driverName, "Musa Bello");
    assert.equal(res.body.data.existed, false);
  });

  test("the same plate typed again is the same truck, not a second one", async () => {
    const res = await as().post("/api/fleet/third-party", { plateNumber: `${PLATE.slice(0, 3)}-${PLATE.slice(3)}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.truck.id, hired.id);
    assert.equal(res.body.data.existed, true);
    const [{ n }] = await client`SELECT count(*)::int AS n FROM fleet_trucks WHERE plate_number = ${PLATE}`;
    assert.equal(n, 1);
  });

  test("one of our own plates is handed back as ours", async () => {
    const res = await as().post("/api/fleet/third-party", { plateNumber: ours.plate_number, ownerName: "Somebody" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.truck.id, ours.id);
    assert.equal(res.body.data.truck.isThirdParty, false, "never turned into a hired truck");
    assert.match(res.body.message, /one of our own/);
  });

  test("a hired truck stays off the papers watchlist", async () => {
    await client`UPDATE fleet_trucks SET insurance_expiry = '2020-01-01' WHERE id = ${hired.id}`;
    const res = await as().get("/api/fleet/compliance");
    assert.equal(res.status, 200);
    assert.ok(!res.body.data.trucks.some((t) => t.id === hired.id));
  });

  test("haulage lands on the hired truck's trip only, and the owner is paid haulage − AGO", async () => {
    const trip = (truck) => client`
      INSERT INTO delivery_inventory (truck_id, truck_number, pfi_id, pfi_number, quantity_allocated, rate, product_price)
      VALUES (${truck.id}, ${truck.plate_number ?? truck.plateNumber}, ${pfi.id}, ${pfi.pfi_number}, 40000, 1400, 1300)
      RETURNING id`.then((r) => Number(r[0].id));
    ourTrip = await trip(ours);
    hiredTrip = await trip(hired);

    const res = await as().post("/api/delivery-inventory/costs", {
      ids: [ourTrip, hiredTrip],
      haulageAmount: 2_400_000,
      agoLitres: 1000,
      agoPrice: 1700,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.haulageSkipped, 1);
    assert.match(res.body.message, /third-party trucks only/);

    const h = await tripRow(hiredTrip);
    assert.equal(h.truckThirdParty, true);
    assert.equal(h.truckOwner, "Bello Haulage");
    assert.equal(h.thirdParty, true);
    assert.equal(h.haulageAmount, 2_400_000);
    assert.equal(h.agoValue, 1_700_000);
    assert.equal(h.haulageBalance, 700_000, "₦2.4m haulage less ₦1.7m of AGO");
    assert.equal(h.totalExpenses, 2_400_000, "the carriage is the haulage");
    assert.equal(h.costPerLitre, 60);

    const o = await tripRow(ourTrip);
    assert.equal(o.thirdParty, false);
    assert.equal(o.haulageAmount, null, "never on our own truck");
    assert.equal(o.totalExpenses, 1_700_000, "our truck's diesel is still our cost");
  });

  test("haulage sent for our trucks alone is refused, not quietly dropped", async () => {
    const res = await as().post("/api/delivery-inventory/costs", { ids: [ourTrip], haulageAmount: 1_000_000 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /third-party trucks only/);
  });

  test("haulage on a hired trip can be cleared again", async () => {
    const res = await as().post("/api/delivery-inventory/costs", { ids: [hiredTrip], haulageAmount: null, clearBlank: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const h = await tripRow(hiredTrip);
    assert.equal(h.haulageAmount, null);
    assert.equal(h.thirdParty, true, "still the third party's truck");
    assert.equal(h.totalExpenses, null, "carriage unknown until haulage is entered");
  });
});
