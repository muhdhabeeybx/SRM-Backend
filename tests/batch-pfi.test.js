require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * A truck added or edited with only a batch code still lands on its PFI.
 *
 * Allocate Trucks sends the code and no PFI, and a PFI-assigned person's
 * Delivery Inventory is filtered by the row's PFI. So a truck added to PFI-47B
 * after it started selling was saved with no PFI and was seen by super admins
 * only (BWR831XB, October 2026). lib/batchPfi reads the PFI off the code.
 */
describe("a truck's PFI follows its batch code", () => {
  const RUN = Date.now();
  const tag = String(RUN).slice(-7);
  // Below PFI-47 on purpose: a batch from 47B on reads its station rows the
  // new way (lib/deliveryBook), which nothing here is about.
  const CODE_TRUCKING = `PFI-9${tag}B`;
  const CODE_DRAWN = `PFI-8${tag}B`;
  const CODE_NOBODY = `PFI-7${tag}B`;
  let trucking, cargo, confined, confinedId, admin;
  let ready = false;

  before(async () => {
    try {
      ;[trucking] = await client`
        INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, allocation_code)
        VALUES (${`PFI 9${tag}B`}, 'trucking', 'active', 100000, '300', ${CODE_TRUCKING}) RETURNING id, pfi_number`;
      ;[cargo] = await client`
        INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
        VALUES (${`PFI/8${tag}/COASTAL`}, 'coastal', 'active', 1000000, '300') RETURNING id, pfi_number`;
      // The batch's first trucks, as starting it writes them.
      await client`
        INSERT INTO delivery_inventory (allocation_code, truck_number, pfi_id, pfi_number, quantity_allocated, loading_status, date_allocated)
        VALUES (${CODE_TRUCKING}, 'BPA001XB', ${trucking.id}, ${trucking.pfi_number}, 50000, 'loaded', '2026-10-01'),
               (${CODE_DRAWN}, 'BPA002XB', ${cargo.id}, ${cargo.pfi_number}, 50000, 'loaded', '2026-10-01')`;

      admin = await staffToken(request, app);
      const s = await staffTokenWithRoles(["admin"], `batch-pfi-${RUN}@soroman.test`);
      confinedId = Number(s.staff.id);
      confined = s.accessToken;
      await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
      await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${trucking.id}, ${confinedId})`;
      ready = true;
    } catch (e) {
      console.error("batch-pfi fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
      await client`DELETE FROM delivery_inventory WHERE allocation_code = ANY(${[CODE_TRUCKING, CODE_DRAWN, CODE_NOBODY]})`;
      await client`DELETE FROM pfis WHERE id = ANY(${[trucking.id, cargo.id]})`;
    }
    await closeDb();
  });

  const as = (token) => ({
    get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
    post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
    patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
  });
  const skip = (t) => !ready && t.skip("fixtures unavailable");
  const confinedSees = async (truck) => {
    const res = await as(confined).get("/api/delivery-inventory?limit=1000");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.loadings.some((l) => l.truckNumber === truck);
  };

  test("a truck added with only a trucking PFI's code is on that PFI, and its staff see it", async (t) => {
    if (skip(t)) return;
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE_TRUCKING, truckNumber: "BPA003XB", quantityAllocated: 50000, loadingStatus: "loaded",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = res.body.data.inventoryRecord;
    assert.equal(Number(row.pfiId), Number(trucking.id));
    assert.equal(row.pfiNumber, trucking.pfi_number);
    assert.ok(await confinedSees("BPA003XB"));
  });

  test("a truck added to a batch drawn off a cargo takes the cargo its trucks point at", async (t) => {
    if (skip(t)) return;
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE_DRAWN.toLowerCase(), truckNumber: "BPA004XB", quantityAllocated: 50000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(Number(res.body.data.inventoryRecord.pfiId), Number(cargo.id));
  });

  test("a code nobody holds saves with no PFI, as before", async (t) => {
    if (skip(t)) return;
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE_NOBODY, truckNumber: "BPA005XB", quantityAllocated: 50000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.inventoryRecord.pfiId, null);
  });

  test("editing a truck saved with no PFI puts it on its batch's PFI", async (t) => {
    if (skip(t)) return;
    const [row] = await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, quantity_allocated, loading_status, date_allocated)
      VALUES (${CODE_TRUCKING}, 'BPA006XB', 50000, 'loaded', '2026-10-05') RETURNING id`;
    assert.equal(await confinedSees("BPA006XB"), false);
    // What the edit form sends: the code, and the row's PFI — none.
    const res = await as(admin).patch(`/api/delivery-inventory/${row.id}`, { allocationCode: CODE_TRUCKING, depot: "Kano" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body.data.inventoryRecord.pfiId), Number(trucking.id));
    assert.equal(res.body.data.inventoryRecord.pfiNumber, trucking.pfi_number);
    assert.ok(await confinedSees("BPA006XB"));
  });

  test("moving a truck to another batch moves it to that batch's PFI", async (t) => {
    if (skip(t)) return;
    const [row] = await client`
      INSERT INTO delivery_inventory (allocation_code, truck_number, pfi_id, quantity_allocated, loading_status)
      VALUES (${CODE_DRAWN}, 'BPA007XB', ${cargo.id}, 50000, 'loaded') RETURNING id`;
    const res = await as(admin).patch(`/api/delivery-inventory/${row.id}`, { allocationCode: CODE_TRUCKING, pfiId: Number(cargo.id) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number(res.body.data.inventoryRecord.pfiId), Number(trucking.id));
  });

  test("a PFI somebody chose on purpose is kept", async (t) => {
    if (skip(t)) return;
    const res = await as(admin).post("/api/delivery-inventory", {
      allocationCode: CODE_TRUCKING, pfiId: Number(cargo.id), truckNumber: "BPA008XB", quantityAllocated: 50000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(Number(res.body.data.inventoryRecord.pfiId), Number(cargo.id));
  });
});
