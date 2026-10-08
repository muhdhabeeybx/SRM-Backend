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
const { sellableQty } = require("../lib/pfiStock");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Operational loss: product gone from the tank without being sold — the
 * mirror of the evacuation surplus.
 *
 * What has to hold is that it takes from what can be sold and nothing else:
 * never more than is left unsold, it finishes a PFI it empties, taking it back
 * returns the litres and reopens the PFI, and it never moves the landed tank
 * figure or the cargo's cost.
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

describe("PFI operational loss", () => {
  before(async () => {
    token = await staffToken(request, app);
    // Trading, with 400 of 1,000 already on orders.
    [pfi, other, notStarted] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/LOSS/A/${RUN}`, status: "active", startingQtyLitres: 1000, soldQtyLitres: 400, blQtyLitres: 1100, unitPrice: "1000" },
        { pfiNumber: `PFI/LOSS/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/LOSS/C/${RUN}`, status: "not_started", startingQtyLitres: 1000 },
      ])
      .returning();

    const s = await staffTokenWithRoles(["admin"], `loss-${RUN}@soroman.test`);
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

  test("a loss takes from what can be sold", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/losses`, {
      qtyLitres: 150, recordedOn: "2026-10-08", note: "Dip short after evaporation",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.finished, false);

    const row = await reload(pfi.id);
    assert.equal(row.operationalLossLitres, 150);
    assert.equal(row.startingQtyLitres, 1000, "the landed tank figure never moves");
    assert.equal(sellableQty(row), 450, "1000 − 150 lost − 400 sold");
  });

  test("the lost litres cannot be ordered", async () => {
    assert.equal(await pfiRepo.reserveStock(pfi.id, 451), null, "only 450 are left");
    assert.ok(await pfiRepo.reserveStock(pfi.id, 50), "50 of the 450 can be ordered");
    await pfiRepo.releaseStock(pfi.id, 50);
  });

  test("it is stock, not cost: the cargo is costed as it landed", async () => {
    const f = computeFinancials(await reload(pfi.id), { soldQty: 400 });
    assert.equal(f.tankQtyLitres, 1000);
    assert.equal(f.surplusDeficitLitres, -100, "tank minus BL, loss not counted");
    assert.equal(f.operationalLossLitres, 150);
    assert.equal(f.stockQtyLitres, 850);
    assert.equal(f.remaining, 450, "1000 landed − 150 lost − 400 sold");
    assert.equal(f.pfiValue, 1100000, "billed on the BL whatever was lost");
    assert.equal(f.operationalLossCost, 150000, "150 × ₦1,000, named so it can be read");
  });

  test("no more can be lost than is left unsold", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/losses`, {
      qtyLitres: 451, recordedOn: "2026-10-08", note: "Too much",
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Only 450 is left unsold/);
    assert.equal((await reload(pfi.id)).operationalLossLitres, 150, "nothing recorded");
  });

  test("a loss that empties the PFI finishes it", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/losses`, {
      qtyLitres: 450, recordedOn: "2026-10-08", note: "Tank found empty",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.finished, true);
    const row = await reload(pfi.id);
    assert.equal(row.status, "finished");
    assert.equal(row.operationalLossLitres, 600);
  });

  test("taken back, the litres return and the PFI reopens", async () => {
    const [entry] = (await as(token).get(`${API}/${pfi.id}/losses`)).body.data.entries;
    assert.equal(entry.qtyLitres, 450, "newest first");
    const res = await as(token).post(`${API}/${pfi.id}/losses/${entry.id}/void`, { reason: "Mis-dip" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.reopened, true);

    const row = await reload(pfi.id);
    assert.equal(row.operationalLossLitres, 150);
    assert.equal(row.status, "active");

    const list = (await as(token).get(`${API}/${pfi.id}/losses`)).body.data;
    assert.equal(list.totalLitres, 150);
    assert.ok(list.entries[0].voidedAt, "the entry is kept, marked taken back");
    assert.equal(list.entries[0].voidReason, "Mis-dip");

    const again = await as(token).post(`${API}/${pfi.id}/losses/${entry.id}/void`, { reason: "Twice" });
    assert.equal(again.status, 409, "a loss is taken back once");
  });

  test("the PFI file carries its losses", async () => {
    const res = await as(token).get(`${API}/${pfi.id}/file`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.losses.length, 2);
    assert.equal(res.body.data.pfi.financials.operationalLossLitres, 150);
  });

  test("a note and a date are required", async () => {
    const res = await as(token).post(`${API}/${other.id}/losses`, { qtyLitres: 10 });
    assert.equal(res.status, 400);
  });

  test("a PFI that has not started trading is corrected, not given a loss", async () => {
    const res = await as(token).post(`${API}/${notStarted.id}/losses`, {
      qtyLitres: 10, recordedOn: "2026-10-08", note: "x",
    });
    assert.equal(res.status, 409);
  });

  test("a PFI's own staff reach only their PFI", async () => {
    assert.equal((await as(confined).get(`${API}/${pfi.id}/losses`)).status, 404);
    const write = await as(confined).post(`${API}/${pfi.id}/losses`, {
      qtyLitres: 10, recordedOn: "2026-10-08", note: "x",
    });
    assert.equal(write.status, 403);
    assert.equal((await as(confined).get(`${API}/${other.id}/losses`)).status, 200);
  });
});
