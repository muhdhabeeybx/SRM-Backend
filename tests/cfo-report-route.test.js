// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { staffToken, closeDb } = require("./helpers");
const { client } = require("../config/db");

const URL = "/api/cfo-report";

/**
 * The CFO report over HTTP.
 *
 * The one failure this exists to catch is invisible from the code: a new
 * mount that nobody added to config/apiPermissions.js is CLOSED BY DEFAULT,
 * so the page loads, the request 403s, and the screen shows an error that
 * looks like a permissions problem with the user rather than a missing line
 * in a table. Everything else here is the validation contract.
 */
describe("CFO report endpoint", () => {
  after(async () => {
    await client`DELETE FROM cfo_report_entries WHERE report_date = '2026-01-03'`.catch(() => {});
    await closeDb();
  });

  test("a signed-in staff member can reach it", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .get(URL)
      .query({ dateFrom: "2026-09-15", dateTo: "2026-09-17" })
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.days.length, 3, "one block per day, both ends included");
    assert.deepEqual(res.body.data.days.map((d) => d.date), [
      "2026-09-15", "2026-09-16", "2026-09-17",
    ]);
    assert.equal(res.body.data.meta.timezone, "Africa/Lagos");
  });

  test("it refuses a request with no dates rather than inventing a range", async () => {
    const token = await staffToken(request, app);
    const res = await request(app).get(URL).set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400);
  });

  test("it refuses a reversed range", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .get(URL)
      .query({ dateFrom: "2026-09-17", dateTo: "2026-09-15" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400, "an empty report would read as 'no trading'");
  });

  test("it refuses a range wider than a year", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .get(URL)
      .query({ dateFrom: "2020-01-01", dateTo: "2026-09-17" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400);
  });

  test("it is closed to an unauthenticated caller", async () => {
    const res = await request(app).get(URL).query({ dateFrom: "2026-09-15", dateTo: "2026-09-15" });
    assert.equal(res.status, 401);
  });

  test("a correction saves, comes back on the report, and can be removed", async () => {
    const token = await staffToken(request, app);
    const rows = await client`SELECT id FROM pfis ORDER BY id LIMIT 1`;
    if (!rows.length) return;
    const pfiId = Number(rows[0].id);

    const save = await request(app)
      .put(`${URL}/entries`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reportDate: "2026-01-03", pfiId, bankInflow: 250000, remarks: "Paid by cheque" });
    assert.equal(save.status, 200, JSON.stringify(save.body));

    // includeAll, because the batch may not have been trading on that date —
    // a saved correction must pull its row onto the sheet regardless.
    const read = await request(app)
      .get(URL)
      .query({ dateFrom: "2026-01-03", dateTo: "2026-01-03" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(read.status, 200);
    const row = read.body.data.days[0].rows.find((r) => r.pfiId === pfiId);
    assert.ok(row, "a corrected row is listed even on a day the batch did not trade");
    assert.equal(row.bankInflow, 250000);
    assert.deepEqual(row.edited, ["bankInflow"]);
    assert.equal(row.remarks, "Paid by cheque");
    assert.equal(
      row.surplusDeficit, row.bankInflow - row.salesValue,
      "the derived figure follows the correction"
    );

    const gone = await request(app)
      .delete(`${URL}/entries`)
      .query({ reportDate: "2026-01-03", pfiId })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
  });

  test("a derived column cannot be written even if it is sent", async () => {
    // Zod strips unknown keys, which is what stops a request smuggling in a
    // stock balance that does not equal initial minus cumulative.
    const token = await staffToken(request, app);
    const rows = await client`SELECT id FROM pfis ORDER BY id LIMIT 1`;
    if (!rows.length) return;
    const pfiId = Number(rows[0].id);

    const res = await request(app)
      .put(`${URL}/entries`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reportDate: "2026-01-03", pfiId, stockBalance: 1, surplusDeficit: 2 });
    assert.equal(res.status, 200);
    assert.ok(!("stockBalance" in res.body.data), "no such column exists to write");
    assert.ok(!("surplusDeficit" in res.body.data));

    await request(app)
      .delete(`${URL}/entries`)
      .query({ reportDate: "2026-01-03", pfiId })
      .set("Authorization", `Bearer ${token}`);
  });
});
