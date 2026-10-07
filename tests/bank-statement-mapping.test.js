require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");

/**
 * A statement whose heading row has a blank cell still saves its format.
 *
 * The dashboard read an .xlsx heading row with holes where a cell was empty,
 * and a hole goes over the wire as null. sampleHeaders refused anything but
 * text, so the whole format answered 400 and the account could not be set up
 * (bank account 54, October 2026).
 */
describe("saving a bank account's statement format", () => {
  let token, accountId;
  let ready = false;

  before(async () => {
    try {
      const stamp = Date.now().toString().slice(-8);
      const [a] = await client`
        INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
        VALUES ('Test Bank', 'MAPPING TEST', ${`91${stamp}`}, 'Active') RETURNING id`;
      accountId = Number(a.id);
      token = await staffToken(request, app);
      ready = true;
    } catch (e) {
      console.error("mapping fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM bank_statement_column_mappings WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    }
    await closeDb();
  });

  const put = (body) => request(app)
    .put(`/api/bank-statements/mapping/${accountId}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);

  test("a blank heading is saved as an unnamed column", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await put({
      headerRow: 0, dateColumn: 0, creditColumn: 3, narrationColumn: 2,
      sampleHeaders: ["Date", null, "Narration", "Credit"],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const got = await request(app).get(`/api/bank-statements/mapping/${accountId}`).set("Authorization", `Bearer ${token}`);
    assert.equal(got.status, 200);
    const headers = got.body.data.mapping.sample_headers ?? got.body.data.mapping.sampleHeaders;
    assert.deepEqual(headers, ["Date", "", "Narration", "Credit"]);
  });

  test("a format with no date column is still refused, and says why", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await put({ headerRow: 0, dateColumn: null, creditColumn: 3, sampleHeaders: ["Date"] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /date column/i);
  });
});
