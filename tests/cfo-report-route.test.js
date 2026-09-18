// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");
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
 *
 * ── The report is allowlisted ─────────────────────────────────────────────
 *
 * Every case below needs a caller who has been GRANTED the page, because the
 * report is restricted to three named people and nothing else opens it — not
 * admin, not super_admin, which is what the fixture staff holds. So the grant
 * is written in `before` and removed in `after`, and the rule itself is tested
 * once, over HTTP, against a caller who does not have it. The rule's own
 * edge cases live in tests/cfo-report-access.test.js, which needs no database.
 */
describe("CFO report endpoint", () => {
  let grantedStaffId;

  before(async () => {
    // Log in first so the fixture row exists, then grant it the page.
    await staffToken(request, app);
    const [row] = await client`SELECT id FROM staff WHERE email = 'test-staff@soroman.test'`;
    grantedStaffId = Number(row.id);
    await client`
      INSERT INTO staff_page_overrides (staff_id, route_path, allowed)
      VALUES (${grantedStaffId}, '/cfo-report', TRUE)
      ON CONFLICT (staff_id, route_path) DO UPDATE SET allowed = TRUE`;
  });

  after(async () => {
    await client`DELETE FROM cfo_report_entries WHERE report_date = '2026-01-03'`.catch(() => {});
    // Leave no standing grant behind — the allowlist in migration 0041 is the
    // record of who may see this report, and a fixture must not add to it.
    if (grantedStaffId) {
      await client`
        DELETE FROM staff_page_overrides
         WHERE staff_id = ${grantedStaffId} AND route_path = '/cfo-report'`.catch(() => {});
    }
    await closeDb();
  });

  test("a staff member who has not been granted the page is refused", async () => {
    // admin + super_admin and still out: only an explicit grant opens this.
    const { accessToken } = await staffTokenWithRoles(["admin", "super_admin"]);
    const res = await request(app)
      .get(URL)
      .query({ dateFrom: "2026-09-15", dateTo: "2026-09-17" })
      .set("Authorization", `Bearer ${accessToken}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.message, /CFO report/i);
  });

  test("a granted staff member can reach it", async () => {
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

    // includeAll, because the PFI may not have been trading on that date —
    // a saved correction must pull its row onto the sheet regardless.
    const read = await request(app)
      .get(URL)
      .query({ dateFrom: "2026-01-03", dateTo: "2026-01-03" })
      .set("Authorization", `Bearer ${token}`);
    assert.equal(read.status, 200);
    const row = read.body.data.days[0].rows.find((r) => r.pfiId === pfiId);
    assert.ok(row, "a corrected row is listed even on a day the PFI did not trade");
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
