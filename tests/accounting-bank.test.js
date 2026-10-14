require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const recon = require("../services/accounting/reconciliation.service");
const { staffToken, closeDb } = require("./helpers");

/**
 * Money out of the bank, and what Finance says a line was (0083).
 *
 *   kept       a statement's withdrawals are stored apart from its credits,
 *              once each, and never offered as payments
 *   booked     a withdrawal is Dr Suspense / Cr the bank until named; named,
 *              it books to that account instead
 *   reconciled the reconciliation lists it, and says what it was named to
 *   supplier   a PFI keeps the vendor its cargo was bought from
 */
const RUN = String(Date.now()).slice(-7);
const DAY = "2026-10-06";

describe("money out of the bank", () => {
  let token;
  let bankId;
  let loansId;
  let vendorId;

  const account = async (key) => Number((await client`SELECT id FROM expense_categories WHERE system_key = ${key}`)[0].id);
  const booked = async (type, id, accountId) => {
    const [r] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.source_type = ${type} AND e.source_id = ${String(id)} AND l.account_id = ${accountId}`;
    return Number(r.b);
  };

  before(async () => {
    token = await staffToken(request, app);
    const [b] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
      VALUES ('Debit Test Bank', ${`DEBITS ${RUN}`}, ${`77${RUN}`}, 'Active') RETURNING id`;
    bankId = Number(b.id);
    loansId = await account("loans");
    const [v] = await client`INSERT INTO vendors (name) VALUES (${`Supplier ${RUN}`}) RETURNING id`;
    vendorId = Number(v.id);
    const map = await request(app)
      .put(`/api/bank-statements/mapping/${bankId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ headerRow: 0, dateColumn: 0, creditColumn: 3, debitColumn: 2, depositorColumn: 1, narrationColumn: 1 });
    assert.equal(map.status, 200, JSON.stringify(map.body));
  });

  after(async () => {
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      const debitIds = (await tx`SELECT id FROM bank_statement_debits WHERE bank_account_id = ${bankId}`).map((r) => String(r.id));
      const lineIds = (await tx`SELECT id FROM bank_statement_lines WHERE bank_account_id = ${bankId}`).map((r) => String(r.id));
      const entries = await tx`SELECT id FROM journal_entries WHERE (source_type = 'bank_debit' AND source_id = ANY(${debitIds})) OR (source_type = 'bank_line' AND source_id = ANY(${lineIds}))`;
      const ids = entries.map((e) => e.id);
      await tx`DELETE FROM journal_lines WHERE entry_id = ANY(${ids}::int[])`;
      await tx`DELETE FROM journal_lines WHERE bank_account_id = ${bankId}`;
      await tx`DELETE FROM ledger_postings WHERE (source_type = 'bank_debit' AND source_id = ANY(${debitIds})) OR (source_type = 'bank_line' AND source_id = ANY(${lineIds}))`;
      await tx`DELETE FROM journal_entries WHERE id = ANY(${ids}::int[])`;
    });
    await client`DELETE FROM bank_line_classifications WHERE direction = 'debit' AND line_id IN (SELECT id FROM bank_statement_debits WHERE bank_account_id = ${bankId})`;
    await client`DELETE FROM bank_line_classifications WHERE direction = 'credit' AND line_id IN (SELECT id FROM bank_statement_lines WHERE bank_account_id = ${bankId})`;
    await client`DELETE FROM bank_statement_debits WHERE bank_account_id = ${bankId}`;
    await client`DELETE FROM bank_statement_lines WHERE bank_account_id = ${bankId}`;
    await client`DELETE FROM bank_statements WHERE bank_account_id = ${bankId}`;
    await client`DELETE FROM bank_statement_column_mappings WHERE bank_account_id = ${bankId}`;
    await client`DELETE FROM pfis WHERE pfi_number = ${`PFI/SUP/${RUN}`}`;
    await client`DELETE FROM bank_accounts WHERE id = ${bankId}`;
    await client`DELETE FROM vendors WHERE id = ${vendorId}`;
    await closeDb();
  });

  test("an upload keeps its withdrawals apart from its credits, once each", async () => {
    const send = () => request(app)
      .post("/api/bank-statements")
      .set("Authorization", `Bearer ${token}`)
      .send({
        bankAccountId: bankId,
        filename: `debits-${RUN}.csv`,
        rows: [{ txnDate: DAY, amount: 500000, depositor: `PAYER ${RUN}`, bankRef: `IN${RUN}`, narration: "in" }],
        debits: [{ txnDate: DAY, amount: 200000, depositor: `FIRST BANK LOAN ${RUN}`, bankRef: `OUT${RUN}`, narration: "loan repayment" }],
      });
    const first = await send();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(first.body.message, /1 withdrawal kept for the books/);
    const again = await send();
    assert.equal(again.status, 409);
    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM bank_statement_debits WHERE bank_account_id = ${bankId}`;
    assert.equal(n, 1);
    const [{ c }] = await client`SELECT COUNT(*)::int AS c FROM bank_statement_lines WHERE bank_account_id = ${bankId}`;
    assert.equal(c, 1, "the withdrawal is not among the credits");
  });

  test("two withdrawals alike in every particular are both kept — and still once each", async () => {
    const charge = { txnDate: DAY, amount: 50, depositor: "", bankRef: "", narration: `SMS ALERT ${RUN}` };
    const send = (debits) => request(app)
      .post("/api/bank-statements")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankId, filename: `charges-${RUN}.csv`, rows: [], debits });
    const first = await send([charge, charge]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const count = async () => (await client`
      SELECT COUNT(*)::int AS n FROM bank_statement_debits WHERE bank_account_id = ${bankId} AND narration = ${charge.narration}`)[0].n;
    assert.equal(await count(), 2);
    // The same statement again adds nothing; a third charge that day is new.
    assert.equal((await send([charge, charge])).status, 409);
    assert.equal((await send([charge, charge, charge])).status, 200);
    assert.equal(await count(), 3);
    // Not posted yet; the tests below expect the one withdrawal above alone.
    await client`DELETE FROM bank_statement_debits WHERE bank_account_id = ${bankId} AND narration = ${charge.narration}`;
  });

  test("a withdrawal goes through Suspense until named, then to the account it was", async () => {
    await run({ only: ["bank_debit"] });
    const [d] = await client`SELECT id FROM bank_statement_debits WHERE bank_account_id = ${bankId}`;
    const bank = Number((await client`SELECT id FROM expense_categories WHERE bank_account_id = ${bankId}`)[0].id);
    assert.equal(await booked("bank_debit", d.id, bank), -200000);
    assert.equal(await booked("bank_debit", d.id, await account("suspense")), 200000);

    const named = await request(app)
      .post(`/api/accounts/bank-lines/debit/${d.id}/classify`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: loansId, note: "Loan repaid to First Bank" });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    await run({ only: ["bank_debit"] });
    assert.equal(await booked("bank_debit", d.id, await account("suspense")), 0);
    assert.equal(await booked("bank_debit", d.id, loansId), 200000);

    const r = await recon.reconciliation({ bankAccountId: bankId, from: DAY, to: DAY });
    assert.equal(r.moneyOut.length, 1);
    assert.equal(r.moneyOut[0].namedTo.accountId, loansId);
    assert.equal(r.totals.outUnexplained, 0);
  });

  test("money between our own banks is not named — it clears itself", async () => {
    const [d] = await client`SELECT id FROM bank_statement_debits WHERE bank_account_id = ${bankId}`;
    const otherBank = Number((await client`SELECT id FROM expense_categories WHERE bank_account_id IS NOT NULL AND bank_account_id <> ${bankId} LIMIT 1`)[0].id);
    const refused = await request(app)
      .post(`/api/accounts/bank-lines/debit/${d.id}/classify`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: otherBank });
    assert.equal(refused.status, 400);
  });

  test("a PFI keeps the supplier its cargo was bought from", async () => {
    const created = await request(app)
      .post("/api/pfis")
      .set("Authorization", `Bearer ${token}`)
      .send({ pfi_number: `PFI/SUP/${RUN}`, pfi_type: "gantry", starting_qty_litres: 1000, unit_price: 900, supplierVendorId: vendorId });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const [p] = await client`SELECT supplier_vendor_id FROM pfis WHERE pfi_number = ${`PFI/SUP/${RUN}`}`;
    assert.equal(Number(p.supplier_vendor_id), vendorId);
  });
});
