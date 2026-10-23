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
 * A PFI's figures carry three places (0097), as the papers print them: BL
 * 26,714,386.863 L at ₦1,228.765 a litre. Saved as typed, quantities read back
 * as numbers, the cargo cost runs off the price as printed, and the half litre
 * that orders in whole litres can never take does not keep the PFI from
 * reading sold out.
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

  test("raising a PFI keeps three places on its quantities, tonnage and price", async () => {
    const res = await request(app).post(API).set("Authorization", `Bearer ${token}`).send({
      pfiNumber: `PFI/DEC/${RUN}`,
      pfiType: "coastal",
      startingQtyLitres: "27090717.5",
      qtyVolumeMt: "20201.873",
      blQtyLitres: "26714386.863",
      blQtyMt: "19921.243",
      unitPrice: "1228.765",
    });
    assert.equal(res.status, 201, res.body.message);

    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/DEC/${RUN}`));
    pfiId = row.id;
    assert.equal(row.startingQtyLitres, 27090717.5);
    assert.equal(row.blQtyLitres, 26714386.863);
    assert.equal(typeof row.startingQtyLitres, "number", "read as a number, as the integer was");
    assert.equal(Number(row.qtyVolumeMt), 20201.873);
    assert.equal(Number(row.blQtyMt), 19921.243);
    assert.equal(Number(row.unitPrice), 1228.765, "not cut to the kobo");

    // The cost the papers print, not ₦133k off it.
    assert.equal(computeFinancials(row).pfiValue, 32825703573.71);
  });

  test("editing keeps the decimals too", async () => {
    const res = await request(app).patch(`${API}/${pfiId}`).set("Authorization", `Bearer ${token}`).send({
      startingQtyLitres: "27090717.125",
      blQtyLitres: "26714386.5",
    });
    assert.equal(res.status, 200, res.body.message);

    const [row] = await db.select().from(pfis).where(eq(pfis.id, pfiId));
    assert.equal(row.startingQtyLitres, 27090717.125);
    assert.equal(row.blQtyLitres, 26714386.5);
  });

  test("the surplus reads to the three places, not float noise", () => {
    const f = computeFinancials({
      pfiType: "coastal", startingQtyLitres: 27090717, blQtyLitres: 26714386.863, unitPrice: "1228.765",
    });
    assert.equal(f.surplusDeficitLitres, 376330.137);
  });

  test("less than one litre left is sold out — orders are whole litres", () => {
    const pfi = { startingQtyLitres: 100.5, evacuationSurplusLitres: 0, operationalLossLitres: 0, soldQtyLitres: 100 };
    assert.equal(sellableQty(pfi), 0.5, "the half litre is still shown");
    assert.equal(isSoldOut(pfi), true);
    assert.equal(isSoldOut({ ...pfi, soldQtyLitres: 99 }), false);
  });
});
