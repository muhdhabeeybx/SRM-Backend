require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { db } = require("../config/db");
const { sql } = require("drizzle-orm");
const { staffToken, closeDb } = require("./helpers");

/**
 * Saving a vendor whose name is already on file returns that vendor rather
 * than a copy — whatever the case, spacing or punctuation it was typed in.
 */

const RUN = `Dedupe ${String(Date.now()).slice(-6)}`;
let token;

describe("vendor names", () => {
  before(async () => { token = await staffToken(request, app); });
  after(async () => {
    await db.execute(sql`DELETE FROM vendors WHERE name ILIKE ${`%${RUN.split(" ")[1]}%`}`);
    await closeDb();
  });

  test("the same name typed differently is the same vendor", async () => {
    const first = await request(app).post("/api/vendors").set("Authorization", `Bearer ${token}`)
      .send({ name: `${RUN} Marine Services Ltd.` });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const again = await request(app).post("/api/vendors").set("Authorization", `Bearer ${token}`)
      .send({ name: `  ${RUN.toUpperCase()}  marine services, ltd ` });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.vendor.id, first.body.data.vendor.id);
  });
});
