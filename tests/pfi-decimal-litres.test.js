// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq } = require("drizzle-orm");

const app = require("../app");
const { db } = require("../config/db");
const { pfis } = require("../db/schema");
const { closeDb, staffToken } = require("./helpers");
const { isSoldOut, sellableQty } = require("../lib/pfiStock");
const { computeFinancials } = require("../lib/pfiFinance");

/**
 * A PFI's quantity and BL figure carry decimals (0097): the papers say
 * 26,714,386.86 L and the tank 27,090,717.50 L. Saved as typed, read back as
 * numbers, and the half litre that orders in whole litres can never take does
 * not keep the PFI from reading sold out.
 */
const API = "/api/pfis";
const RUN = Date.now();

let token;
let pfiId;

describe("PFI quantities carry decimals", () => {
  before(async () => {
    token = await staffToken(request, app);
  });

  after(async () => {
    if (pfiId) await db.delete(pfis).where(eq(pfis.id, pfiId));
    await closeDb();
  });

  test("raising a PFI keeps the decimals of its quantity and BL figure", async () => {
    const res = await request(app).post(API).set("Authorization", `Bearer ${token}`).send({
      pfiNumber: `PFI/DEC/${RUN}`,
      pfiType: "coastal",
      startingQtyLitres: "27090717.50",
      blQtyLitres: "26714386.86",
      unitPrice: "1228.76",
    });
    assert.equal(res.status, 201, res.body.message);

    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/DEC/${RUN}`));
    pfiId = row.id;
    assert.equal(row.startingQtyLitres, 27090717.5);
    assert.equal(row.blQtyLitres, 26714386.86);
    assert.equal(typeof row.startingQtyLitres, "number", "read as a number, as the integer was");
  });

  test("editing keeps the decimals too", async () => {
    const res = await request(app).patch(`${API}/${pfiId}`).set("Authorization", `Bearer ${token}`).send({
      startingQtyLitres: "27090717.25",
      blQtyLitres: "26714386.5",
    });
    assert.equal(res.status, 200, res.body.message);

    const [row] = await db.select().from(pfis).where(eq(pfis.id, pfiId));
    assert.equal(row.startingQtyLitres, 27090717.25);
    assert.equal(row.blQtyLitres, 26714386.5);
  });

  test("the surplus reads to the two places, not float noise", () => {
    const f = computeFinancials({
      pfiType: "coastal", startingQtyLitres: 27090717, blQtyLitres: 26714386.86, unitPrice: "1228.76",
    });
    assert.equal(f.surplusDeficitLitres, 376330.14);
  });

  test("less than one litre left is sold out — orders are whole litres", () => {
    const pfi = { startingQtyLitres: 100.5, evacuationSurplusLitres: 0, operationalLossLitres: 0, soldQtyLitres: 100 };
    assert.equal(sellableQty(pfi), 0.5, "the half litre is still shown");
    assert.equal(isSoldOut(pfi), true);
    assert.equal(isSoldOut({ ...pfi, soldQtyLitres: 99 }), false);
  });
});
