// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq, inArray } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { computeFinancials } = require("../lib/pfiFinance");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Price reviews: a PFI's price per unit changed after it was raised.
 *
 * What has to hold is that the reviewed price becomes the PFI's price — so the
 * cargo value and landing cost move with it — while every earlier price stays
 * on record; that only the latest review can be taken back, which restores the
 * price it replaced; and that once reviewed, the price cannot be typed over on
 * the edit form.
 */
const API = "/api/pfis";
const RUN = Date.now();

let token;
let pfi;
let unpriced;
let trucking;
let other;
let confined;
let confinedId;

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${t}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${t}`).send(body),
});
const reload = async (id) => (await db.select().from(pfis).where(eq(pfis.id, id)))[0];

describe("PFI price review", () => {
  before(async () => {
    token = await staffToken(request, app);
    [pfi, unpriced, trucking, other] = await db
      .insert(pfis)
      .values([
        // 1,000 on the BL at ₦1,000: a ₦1,000,000 cargo.
        { pfiNumber: `PFI/PRICE/A/${RUN}`, status: "active", startingQtyLitres: 990, blQtyLitres: 1000, unitPrice: "1000" },
        { pfiNumber: `PFI/PRICE/B/${RUN}`, status: "active", startingQtyLitres: 1000, blQtyLitres: 1000 },
        { pfiNumber: `PFI/PRICE/C/${RUN}`, pfiType: "trucking", status: "active", startingQtyLitres: 1000, unitPrice: "900" },
        { pfiNumber: `PFI/PRICE/D/${RUN}`, status: "active", startingQtyLitres: 1000, blQtyLitres: 1000, unitPrice: "800" },
      ])
      .returning();

    const s = await staffTokenWithRoles(["admin"], `price-${RUN}@soroman.test`);
    confinedId = Number(s.staff.id);
    confined = s.accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${other.id}, ${confinedId})`;
  });

  after(async () => {
    await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
    await db.delete(pfis).where(inArray(pfis.id, [pfi.id, unpriced.id, trucking.id, other.id]));
    await closeDb();
  });

  test("a reviewed price becomes the PFI's price, and every cost moves with it", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/prices`, {
      price: 1100, effectiveOn: "2026-10-01", note: "Supplier review letter SR-114",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.entry.price, 1100);
    assert.equal(res.body.data.entry.previousPrice, 1000, "the price it replaced is kept");
    assert.match(res.body.message, /from ₦1,000\.00 to ₦1,100\.00/);

    const row = await reload(pfi.id);
    assert.equal(Number(row.unitPrice), 1100);
    const f = computeFinancials(row, {});
    assert.equal(f.pricePerLitre, 1100);
    assert.equal(f.pfiValue, 1100000, "BL × the reviewed price");
    assert.equal(f.landingCostPerLitre, 1100);
  });

  test("a second review chains from the first", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/prices`, {
      price: "1250.50", effectiveOn: "2026-10-12", note: "Second review",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.entry.previousPrice, 1100);
    assert.equal(Number((await reload(pfi.id)).unitPrice), 1250.5);

    const list = (await as(token).get(`${API}/${pfi.id}/prices`)).body.data;
    assert.deepEqual(list.entries.map((e) => e.price), [1250.5, 1100], "latest first");
    assert.equal(list.currentPrice, 1250.5);
  });

  test("a review cannot take effect before the one it replaces", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/prices`, {
      price: 1300, effectiveOn: "2026-10-11", note: "Backdated",
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /2026-10-12/);
  });

  test("the same price is not a review", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/prices`, {
      price: 1250.5, effectiveOn: "2026-10-13", note: "Same",
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /already ₦1,250\.50/);
  });

  test("once reviewed, the edit form cannot type over the price — but may resend it", async () => {
    const changed = await as(token).patch(`${API}/${pfi.id}`, { unitPrice: 999 });
    assert.equal(changed.status, 409);
    assert.match(changed.body.message, /Review price/);
    assert.equal(Number((await reload(pfi.id)).unitPrice), 1250.5);

    const same = await as(token).patch(`${API}/${pfi.id}`, { unitPrice: 1250.5, description: "kept" });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal((await reload(pfi.id)).description, "kept");
  });

  test("only the latest review can be taken back, and that restores the price it replaced", async () => {
    const [latest, first] = (await as(token).get(`${API}/${pfi.id}/prices`)).body.data.entries;

    const early = await as(token).post(`${API}/${pfi.id}/prices/${first.id}/void`, { reason: "Wrong" });
    assert.equal(early.status, 409);
    assert.match(early.body.message, /latest/);

    const res = await as(token).post(`${API}/${pfi.id}/prices/${latest.id}/void`, { reason: "Letter withdrawn" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /₦1,100\.00 again/);
    assert.equal(Number((await reload(pfi.id)).unitPrice), 1100);

    const again = await as(token).post(`${API}/${pfi.id}/prices/${latest.id}/void`, { reason: "Twice" });
    assert.equal(again.status, 409, "taken back once");

    const list = (await as(token).get(`${API}/${pfi.id}/prices`)).body.data.entries;
    assert.equal(list.length, 2, "the taken-back review stays on record");
    assert.ok(list[0].voidedAt);
    assert.equal(list[0].voidReason, "Letter withdrawn");
  });

  test("the file carries every review, and its workings name each price", async () => {
    const res = await as(token).get(`${API}/${pfi.id}/file`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.priceReviews.length, 2);
    const line = res.body.data.explain.find((e) => e.key === "pricePerLitre");
    assert.ok(line, "a price line once reviewed");
    assert.equal(line.workings, "Initial ₦1,000.00 → ₦1,100.00 from 1 Oct 2026", "the taken-back review is not a price the PFI had");
  });

  test("the register says which PFIs were reviewed and what they started at", async () => {
    const res = await as(token).get(`${API}/register`);
    assert.equal(res.status, 200);
    const reg = res.body.data.register;
    assert.deepEqual(reg[pfi.id].prices, { reviews: 1, initialPrice: 1000, lastReviewedOn: "2026-10-01" });
    assert.equal(reg[other.id].prices, null, "never reviewed");
  });

  test("a PFI with no price is given one on the form, not reviewed", async () => {
    const res = await as(token).post(`${API}/${unpriced.id}/prices`, {
      price: 1000, effectiveOn: "2026-10-08", note: "x",
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /no price yet/);
  });

  test("a trucking batch is priced in Delivery Costing, not here", async () => {
    const res = await as(token).post(`${API}/${trucking.id}/prices`, {
      price: 950, effectiveOn: "2026-10-08", note: "x",
    });
    assert.equal(res.status, 409);
    assert.equal(Number((await reload(trucking.id)).unitPrice), 900);
  });

  test("a price, a date and a reason are required", async () => {
    assert.equal((await as(token).post(`${API}/${other.id}/prices`, { price: 900, effectiveOn: "2026-10-08" })).status, 400);
    assert.equal((await as(token).post(`${API}/${other.id}/prices`, { price: 0, effectiveOn: "2026-10-08", note: "x" })).status, 400);
    assert.equal((await as(token).post(`${API}/${other.id}/prices`, { price: 900, note: "x" })).status, 400);
  });

  test("a PFI's own staff reach only their PFI", async () => {
    assert.equal((await as(confined).get(`${API}/${pfi.id}/prices`)).status, 404);
    const write = await as(confined).post(`${API}/${pfi.id}/prices`, {
      price: 1500, effectiveOn: "2026-10-20", note: "x",
    });
    assert.equal(write.status, 403);
    const own = await as(confined).post(`${API}/${other.id}/prices`, {
      price: 850, effectiveOn: "2026-10-08", note: "Reviewed up",
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
  });
});
