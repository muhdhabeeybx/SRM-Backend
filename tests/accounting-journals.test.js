require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * Journals written by hand (services/accounting/journals).
 *
 *   two people   written by one, posted only when somebody else approves it
 *   balanced     refused when debits and credits differ
 *   banks        never to a bank or Suspense — those move with statements
 *   months       never before the books start or in a closed month
 *   reversed     put right by a reversal with the sides swapped, once
 *   Finance's    refused to anybody but finance, audit or an admin
 */
const MEMO = `Truck depreciation, October ${Date.now()}`;

describe("journals written by hand", () => {
  let token;
  let weak;
  let approver;
  let depreciation;
  let accumulated;
  let bank;
  const written = [];
  const DAY = "2026-10-31";

  const post = (body, t = token) => request(app).post("/api/accounts/journals").set("Authorization", `Bearer ${t}`).send(body);
  const lines = (amount) => [
    { accountId: depreciation, debit: amount, unit: "fleet" },
    { accountId: accumulated, credit: amount, unit: "fleet" },
  ];

  before(async () => {
    token = await staffToken(request, app);
    weak = (await staffTokenWithRoles(["expenditure_officer"], "test-journal-weak@soroman.test")).accessToken;
    approver = (await staffTokenWithRoles(["finance"], "test-journal-approver@soroman.test")).accessToken;
    depreciation = Number((await client`SELECT id FROM expense_categories WHERE gl_code = '6260'`)[0].id);
    accumulated = Number((await client`SELECT id FROM expense_categories WHERE system_key = 'accumulated_depreciation'`)[0].id);
    bank = Number((await client`SELECT id FROM expense_categories WHERE bank_account_id IS NOT NULL LIMIT 1`)[0].id);
    await client`DELETE FROM accounting_periods WHERE period >= '2026-10'`;
  });

  after(async () => {
    await client`DELETE FROM accounting_periods WHERE period >= '2026-10'`;
    // The drafts point at what they posted, so they go first.
    await client`DELETE FROM journal_drafts WHERE memo IN (${MEMO}, 'Off', 'Cash', 'Weak', 'Too early', 'Closed month')`;
    if (written.length) {
      await client.begin(async (tx) => {
        await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
        const all = (await tx`SELECT id FROM journal_entries WHERE id = ANY(${written}::int[]) OR reverses_entry_id = ANY(${written}::int[])`).map((r) => r.id);
        await tx`DELETE FROM journal_lines WHERE entry_id = ANY(${all}::int[])`;
        await tx`DELETE FROM journal_entries WHERE reverses_entry_id = ANY(${written}::int[])`;
        await tx`DELETE FROM journal_entries WHERE id = ANY(${written}::int[])`;
      });
    }
    await closeDb();
  });

  test("a journal waits until somebody else approves it — never its own writer", async () => {
    const ok = await post({ day: DAY, memo: MEMO, lines: lines(150000) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const draftId = ok.body.data.draftId;
    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM journal_entries WHERE memo = ${MEMO}`;
    assert.equal(n, 0, "nothing is in the books until it is approved");

    const own = await request(app).post(`/api/accounts/journal-drafts/${draftId}/approve`).set("Authorization", `Bearer ${token}`);
    assert.equal(own.status, 403);

    const approved = await request(app).post(`/api/accounts/journal-drafts/${draftId}/approve`).set("Authorization", `Bearer ${approver}`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    written.push(approved.body.data.entryId);
    const [l] = await client`SELECT unit FROM journal_lines WHERE entry_id = ${approved.body.data.entryId} LIMIT 1`;
    assert.equal(l.unit, "fleet");
    const [posted] = await client`SELECT entry_date::text AS day FROM journal_entries WHERE id = ${approved.body.data.entryId}`;
    assert.equal(posted.day, DAY, "posted on the day it was written for");
    const again = await request(app).post(`/api/accounts/journal-drafts/${draftId}/approve`).set("Authorization", `Bearer ${approver}`);
    assert.equal(again.status, 409);

    const off = await post({ day: DAY, memo: "Off", lines: [{ accountId: depreciation, debit: 100 }, { accountId: accumulated, credit: 90 }] });
    assert.equal(off.status, 400);
  });

  test("a bank account takes no journal, and nor does anybody outside finance", async () => {
    const toBank = await post({ day: DAY, memo: "Cash", lines: [{ accountId: bank, debit: 100 }, { accountId: accumulated, credit: 100 }] });
    assert.equal(toBank.status, 400);
    assert.match(toBank.body.message, /statement/);
    const weakTry = await post({ day: DAY, memo: "Weak", lines: lines(100) }, weak);
    assert.equal(weakTry.status, 403);
  });

  test("never before the books start, never in a closed month", async () => {
    const early = await post({ day: "2026-09-15", memo: "Too early", lines: lines(100) });
    assert.equal(early.status, 400);
    await client`INSERT INTO accounting_periods (period, status, closed_at) VALUES ('2026-10', 'closed', now())`;
    const closed = await post({ day: DAY, memo: "Closed month", lines: lines(100) });
    assert.equal(closed.status, 400);
    await client`DELETE FROM accounting_periods WHERE period = '2026-10'`;
  });

  test("reversed once, with the sides swapped — even when asked twice at once", async () => {
    const id = written[0];
    const both = await Promise.all([1, 2].map(() =>
      request(app).post(`/api/accounts/journals/${id}/reverse`).set("Authorization", `Bearer ${token}`).send({})));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)));
    const rev = both.find((r) => r.status === 200);
    const [net] = await client`
      SELECT SUM(l.debit - l.credit) AS n FROM journal_lines l
       WHERE l.entry_id IN (${id}, ${rev.body.data.entryId}) AND l.account_id = ${depreciation}`;
    assert.equal(Number(net.n), 0);
    const twice = await request(app).post(`/api/accounts/journals/${id}/reverse`).set("Authorization", `Bearer ${token}`).send({});
    assert.equal(twice.status, 409);
  });
});
