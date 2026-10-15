require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const reports = require("../services/accounting/reports.service");
const opening = require("../services/accounting/opening.service");
const { staffToken, staffTokenWithRoles, grantPage, closeDb } = require("./helpers");

/** A finance member of staff the books were opened to — they are the admins' otherwise (middleware/accountsAccess). */
const grantedFinance = async () => {
  const { staff, accessToken } = await staffTokenWithRoles(["finance"], "test-accounts-finance@soroman.test");
  await grantPage(staff.id, "/accounts");
  return accessToken;
};

/**
 * What the books print (services/accounting/reports, opening).
 *
 *   tie        the trial balance's two sides agree; assets equal liabilities
 *              plus equity; opening cash plus the flows is closing cash
 *   opening    the opening balances post once, balanced by Opening balance
 *              equity, and are replaced by a reversal, never edited
 *   months     closed in order and only once ended; reopened by a super
 *              admin only, latest first
 */
describe("the books' reports", () => {
  after(async () => {
    await client`DELETE FROM accounting_periods WHERE period >= '2026-10'`;
    await closeDb();
  });

  test("the trial balance, balance sheet and cash flow all tie after a run", async () => {
    await run();
    const tb = await reports.trialBalance({});
    assert.equal(tb.totals.debit, tb.totals.credit);
    assert.equal(tb.totals.closingDebit, tb.totals.closingCredit);
    const bs = await reports.balanceSheet({});
    assert.equal(bs.difference, 0);
    const cf = await reports.cashFlow({ from: "2026-10-01", to: "2026-10-31" });
    assert.equal(cf.difference, 0);
    const pl = await reports.profitAndLoss({ from: "2026-10-01", to: "2026-10-31" });
    assert.equal(pl.current.grossProfit, Math.round((pl.current.sales.total - pl.current.costOfSales.total) * 100) / 100);
  });

  test("opening balances post balanced, and a second posting reverses the first", async () => {
    const first = await opening.post({ amounts: {} });
    const [e1] = await client`SELECT COALESCE(SUM(debit), 0) AS d, COALESCE(SUM(credit), 0) AS c FROM journal_lines WHERE entry_id = ${first.entryId}`;
    assert.equal(Number(e1.d), Number(e1.c));
    const second = await opening.post({ amounts: {} });
    const [rev] = await client`SELECT id FROM journal_entries WHERE reverses_entry_id = ${first.entryId}`;
    assert.ok(rev, "the first opening entry is reversed");
    assert.equal((await opening.current()).id, second.entryId);

    // Two at once: one posts, the other is told to look again.
    const both = await Promise.allSettled([opening.post({ amounts: {} }), opening.post({ amounts: {} })]);
    assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(both.find((r) => r.status === "rejected").reason.status, 409);
    const [{ n }] = await client`
      SELECT COUNT(*)::int AS n FROM journal_entries e
       WHERE e.kind = 'opening' AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)`;
    assert.equal(n, 1, "one opening entry in force");
  });

  test("what the books still need is listed, each item counted, the done ones left off", async () => {
    const token = await grantedFinance();
    const res = await request(app).get("/api/accounts/readiness").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { items } = res.body.data;
    assert.ok(items.every((i) => (i.count === null || i.count > 0) && i.label));
    assert.equal(items.some((i) => i.key === "automatic"), process.env.LEDGER_POSTING_ENABLED !== "true");
    // Posted by the first test above, so not on the list.
    assert.equal(items.some((i) => i.key === "posted"), false);
  });

  test("Post now answers, and says so when a run is already going", async () => {
    const finance = await grantedFinance();
    const ok = await request(app).post("/api/accounts/post-now").set("Authorization", `Bearer ${finance}`);
    assert.ok([200, 202].includes(ok.status), JSON.stringify(ok.body));

    // Somebody else's run holds the lock.
    const conn = await client.reserve();
    try {
      await conn`SELECT pg_advisory_lock(7340081)`;
      const busy = await request(app).post("/api/accounts/post-now").set("Authorization", `Bearer ${finance}`);
      assert.equal(busy.status, 409);
    } finally {
      await conn`SELECT pg_advisory_unlock(7340081)`;
      conn.release();
    }
  });

  test("months close in order, once ended; reopening is a super admin's, latest first", async () => {
    await client`DELETE FROM accounting_periods WHERE period >= '2026-10'`;
    const finance = await grantedFinance();
    const superToken = await staffToken(request, app);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
    const list = await opening.periods(today);
    const ended = list.filter((p) => p.ended);
    if (ended.length < 1) return; // The books' first month has not ended yet on this clock.

    if (ended.length > 1) {
      const outOfOrder = await request(app).post(`/api/accounts/periods/${ended[1].period}/close`).set("Authorization", `Bearer ${finance}`);
      assert.equal(outOfOrder.status, 400);
    }
    const closed = await request(app).post(`/api/accounts/periods/${ended[0].period}/close`).set("Authorization", `Bearer ${finance}`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    const byFinance = await request(app).post(`/api/accounts/periods/${ended[0].period}/reopen`).set("Authorization", `Bearer ${finance}`);
    assert.equal(byFinance.status, 403);
    const bySuper = await request(app).post(`/api/accounts/periods/${ended[0].period}/reopen`).set("Authorization", `Bearer ${superToken}`);
    assert.equal(bySuper.status, 200, JSON.stringify(bySuper.body));
  });
});
