// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { staffToken, closeDb } = require("./helpers");

const URL = "/api/daily-reports/email";

/**
 * What the Reports Hub's "Email report" button answers when the send fails.
 *
 * The endpoint deliberately waits for the dispatch so it can hand the operator
 * the provider's own reason — "The soromannl.com domain is not verified" —
 * rather than a generic apology. That whole design was defeated by the status
 * it used to answer with: 502. The edge in front of the API reads 502 as "the
 * origin is broken", discards the response and serves its own error page,
 * which has no CORS headers on it. The dashboard logged a CORS violation, and
 * axios — never having seen a response — reported "Network Error". Four
 * thousand refused emails, and the one screen that could have said why showed
 * a browser networking error instead.
 *
 * So the status is pinned. Any 4xx survives the hop; 502 does not.
 *
 * The suite runs with EMAIL_ENABLED=false, so the send is refused before any
 * network call — the recipient is on a reserved domain besides, which the
 * email channel blocks outright. Nothing here can post mail.
 */
describe("reports hub email — a refused send must reach the operator", () => {
  after(async () => {
    await closeDb();
  });

  test("answers a failed send with 422 and the reason, never 502", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .post(URL)
      .set("Authorization", `Bearer ${token}`)
      .send({
        recipients: ["reports-hub@soroman.test"],
        reportDate: new Date().toISOString().slice(0, 10),
      });

    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    // The provider's words, not the "could not be sent" fallback that is only
    // reached when nothing said anything at all.
    assert.ok(
      typeof res.body.message === "string" && res.body.message.length > 0,
      JSON.stringify(res.body)
    );
    assert.notEqual(res.body.message, "The report could not be sent");
  });

  test("every address is sent to on its own and answered for by name", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .post(URL)
      .set("Authorization", `Bearer ${token}`)
      .send({
        recipients: ["one@soroman.test", "TWO@soroman.test", "one@soroman.test"],
        reportDate: new Date().toISOString().slice(0, 10),
      });
    const results = res.body.data?.results || [];
    // Deduplicated, case-folded, and one outcome per address with its reason.
    assert.deepEqual(results.map((r) => r.email), ["one@soroman.test", "two@soroman.test"]);
    for (const r of results) {
      assert.equal(r.status, "failed");
      assert.ok(r.error, "a failed address says why");
    }
  });

  test("the preview is the email as it would arrive, with the sender's note", async () => {
    const token = await staffToken(request, app);
    const res = await request(app)
      .post(`${URL}/preview`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reportDate: new Date().toISOString().slice(0, 10), note: "Figures confirmed." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.subject, /^SOROMAN Sales & Operations Report for /);
    assert.match(res.body.data.html, /DEPOT SALES/);
    assert.match(res.body.data.html, /Figures confirmed\./);
    assert.match(res.body.data.html, /Note from /);
  });

  test("requires authentication", async () => {
    const res = await request(app).post(URL).send({
      recipients: ["reports-hub@soroman.test"],
      reportDate: new Date().toISOString().slice(0, 10),
    });
    assert.equal(res.status, 401);
  });
});
