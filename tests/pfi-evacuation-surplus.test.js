// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq, inArray } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { pfiRepo } = require("../repositories");
const { computeFinancials } = require("../lib/pfiFinance");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Evacuation surplus: product found when a PFI is run down.
 *
 * What has to hold is that it is stock and nothing else — it raises what can
 * be sold and reopens a sold-out PFI, it cannot be taken back once any of it
 * is on an order, and it never moves the landed tank figure the cargo is
 * costed on.
 */
const API = "/api/pfis";
const RUN = Date.now();

let token;
let pfi;
let other;
let notStarted;
let confined;
let confinedId;

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${t}`).send(body),
});
const reload = async (id) => (await db.select().from(pfis).where(eq(pfis.id, id)))[0];

describe("PFI evacuation surplus", () => {
  before(async () => {
    token = await staffToken(request, app);
    // Sold out and finished: the state a surplus is normally found in.
    [pfi, other, notStarted] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/SURPLUS/A/${RUN}`, status: "finished", startingQtyLitres: 1000, soldQtyLitres: 1000, blQtyLitres: 1100, unitPrice: "1000" },
        { pfiNumber: `PFI/SURPLUS/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/SURPLUS/C/${RUN}`, status: "not_started", startingQtyLitres: 1000 },
      ])
      .returning();

    const s = await staffTokenWithRoles(["admin"], `surplus-${RUN}@soroman.test`);
    confinedId = Number(s.staff.id);
    confined = s.accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${other.id}, ${confinedId})`;
  });

  after(async () => {
    await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
    await db.delete(pfis).where(inArray(pfis.id, [pfi.id, other.id, notStarted.id]));
    await closeDb();
  });

  test("a surplus on a finished PFI adds stock and reopens it", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/surpluses`, {
      qtyLitres: 500, recordedOn: "2026-09-22", note: "Dip on evacuation",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.reopened, true);

    const row = await reload(pfi.id);
    assert.equal(row.status, "active");
    assert.equal(row.evacuationSurplusLitres, 500);
    assert.equal(row.startingQtyLitres, 1000, "the landed tank figure never moves");
  });

  test("the surplus can be sold, and no more than it", async () => {
    assert.ok(await pfiRepo.reserveStock(pfi.id, 300), "300 of the 500 can be ordered");
    assert.equal(await pfiRepo.reserveStock(pfi.id, 300), null, "only 200 are left");
  });

  test("it is stock, not cost: BL deficit stays on the landed figure", async () => {
    const f = computeFinancials(await reload(pfi.id), { soldQty: 1300 });
    assert.equal(f.tankQtyLitres, 1000);
    assert.equal(f.surplusDeficitLitres, -100, "tank minus BL, surplus not counted");
    assert.equal(f.evacuationSurplusLitres, 500);
    assert.equal(f.remaining, 200, "1000 landed + 500 surplus − 1300 sold");
  });

  test("it cannot be taken back once part of it is on orders", async () => {
    const [entry] = (await as(token).get(`${API}/${pfi.id}/surpluses`)).body.data.entries;
    const res = await as(token).post(`${API}/${pfi.id}/surpluses/${entry.id}/void`, { reason: "Mis-dip" });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /300 of these litres/);
  });

  test("taken back once the orders are off, the PFI is finished again", async () => {
    await pfiRepo.releaseStock(pfi.id, 300);
    const [entry] = (await as(token).get(`${API}/${pfi.id}/surpluses`)).body.data.entries;
    const res = await as(token).post(`${API}/${pfi.id}/surpluses/${entry.id}/void`, { reason: "Mis-dip" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await reload(pfi.id);
    assert.equal(row.evacuationSurplusLitres, 0);
    assert.equal(row.status, "finished", "1000 sold of 1000 is sold out");

    const list = (await as(token).get(`${API}/${pfi.id}/surpluses`)).body.data.entries;
    assert.ok(list[0].voidedAt, "the entry is kept, marked taken back");
    assert.equal(list[0].voidReason, "Mis-dip");
  });

  test("a note and a date are required", async () => {
    const res = await as(token).post(`${API}/${other.id}/surpluses`, { qtyLitres: 10 });
    assert.equal(res.status, 400);
  });

  test("a PFI that has not started trading is corrected, not given a surplus", async () => {
    const res = await as(token).post(`${API}/${notStarted.id}/surpluses`, {
      qtyLitres: 10, recordedOn: "2026-09-22", note: "x",
    });
    assert.equal(res.status, 409);
  });

  test("a PFI's own staff reach only their PFI", async () => {
    assert.equal((await as(confined).get(`${API}/${pfi.id}/surpluses`)).status, 404);
    const write = await as(confined).post(`${API}/${pfi.id}/surpluses`, {
      qtyLitres: 10, recordedOn: "2026-09-22", note: "x",
    });
    assert.equal(write.status, 403);
    assert.equal((await as(confined).get(`${API}/${other.id}/surpluses`)).status, 200);
  });
});
