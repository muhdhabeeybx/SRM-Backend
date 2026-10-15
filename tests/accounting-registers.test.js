require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { db, client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const assetsSvc = require("../services/accounting/assets.service");
const loansSvc = require("../services/accounting/loans.service");
const { report } = require("../services/accounting/businessReport.service");
const { closeDb } = require("./helpers");

/**
 * The Fixed Assets and Loans registers in the books (0088), and the Report
 * that reads them.
 *
 *   loan          money lent lands in the bank, owed to the lender; its
 *                 statement line is matched to it and not booked twice
 *   repayment     the part off the loan and the interest, out of the bank
 *   asset         bought from a bank: owned, and out of that bank
 *   hire purchase the asset is owned in full; the loan carries what it
 *                 financed, the bank only the deposit
 *   expense       an asset first entered as an expense is owned, not spent
 *   sold          the asset leaves, what it fetched is in the bank, and the
 *                 difference is a gain or a loss
 *   report        money in and out of a bank counts each naira once, even
 *                 when its line was booked unmatched first and matched later
 */
const RUN = String(Date.now()).slice(-6);
const D = (n) => `2026-10-${String(n).padStart(2, "0")}`;
const TYPES = ["bank_line", "bank_debit", "expense_bill", "asset_bought", "asset_wear", "asset_sold", "loan_received", "loan_repayment"];

describe("fixed assets and loans in the books", () => {
  let bank;
  let bankAccountId;
  let statementId;
  let expenseId;
  const credits = {};
  const debits = {};
  const ids = { assets: [], loans: [], repayments: [] };
  let accounts;
  let before1;

  const credit = async (day, amount, depositor) => {
    const [r] = await client`
      INSERT INTO bank_statement_lines (bank_account_id, statement_id, txn_date, amount, depositor, narration, dedup_key)
      VALUES (${bank.id}, ${statementId}, ${day}, ${amount}, ${depositor}, ${depositor}, ${`R${RUN}${Math.random()}`.slice(0, 60)})
      RETURNING id`;
    return Number(r.id);
  };
  const debit = async (day, amount, narration) => {
    const [r] = await client`
      INSERT INTO bank_statement_debits (bank_account_id, statement_id, txn_date, amount, beneficiary, narration, dedup_key)
      VALUES (${bank.id}, ${statementId}, ${day}, ${amount}, '', ${narration}, ${`R${RUN}${Math.random()}`.slice(0, 60)})
      RETURNING id`;
    return Number(r.id);
  };
  const kindOf = async (direction, id) => (await client`
    SELECT kind, ref_id FROM bank_line_classifications WHERE direction = ${direction} AND line_id = ${id}`)[0] || null;
  /** What our records booked to an account, debit-positive. */
  const booked = async (accountId, { partyId = null } = {}) => {
    const [r] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS b
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = ${accountId}
         AND (${partyId}::int IS NULL OR (l.party_type = 'loan' AND l.party_id = ${partyId}))
         AND ((e.source_type IN ('asset_bought', 'asset_wear', 'asset_sold') AND split_part(e.source_id, ':', 1)::int = ANY(${ids.assets}::int[]))
           OR (e.source_type = 'loan_received' AND e.source_id::int = ANY(${ids.loans}::int[]))
           OR (e.source_type = 'loan_repayment' AND e.source_id::int = ANY(${ids.repayments}::int[]))
           OR (e.source_type = 'expense_bill' AND e.source_id = ${String(expenseId)})
           OR (e.source_type = 'bank_line' AND e.source_id = ANY(${Object.values(credits).map(String)}))
           OR (e.source_type = 'bank_debit' AND e.source_id = ANY(${Object.values(debits).map(String)})))`;
    return Number(r.b);
  };
  const bankRow = (rep) => rep.banks.find((b) => b.bankAccountId === bank.id) || { moneyIn: 0, moneyOut: 0, atStart: 0, atEnd: 0 };
  const flow = (rep, direction, label) => rep.flows[direction].find((f) => f.label === label)?.amount || 0;

  before(async () => {
    accounts = Object.fromEntries((await client`
      SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`).map((r) => [r.system_key, Number(r.id)]));
    // Whatever else is waiting is booked first, so what follows is ours alone.
    await run({ only: TYPES });
    before1 = await report({ from: D(1), to: D(15) });

    const [b] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
      VALUES ('Register Bank', ${`Zr${RUN} Ops`}, ${`77${RUN}01`}, 'Active') RETURNING id`;
    bank = { id: Number(b.id) };
    const [st] = await client`INSERT INTO bank_statements (bank_account_id, filename) VALUES (${bank.id}, ${`r-${RUN}.csv`}) RETURNING id`;
    statementId = Number(st.id);

    // A ₦50m bank loan on the 3rd, landing on the 4th; ₦4m back with ₦0.5m interest on the 10th.
    const l1 = await loansSvc.create({ kind: "bank_loan", lender: `Zr${RUN} Bank`, amount: 50_000_000, receivedOn: D(3), bankAccountId: bank.id });
    ids.loans.push(l1.id);
    credits.loan = await credit(D(4), 50_000_000, "LOAN DISBURSEMENT");
    const r1 = await loansSvc.addRepayment(l1.id, { paidOn: D(10), principal: 4_000_000, interest: 500_000, bankAccountId: bank.id });
    ids.repayments.push(r1.id);
    debits.repayment = await debit(D(10), 4_500_000, "LOAN REPAYMENT");

    // A ₦12m generator paid from the bank on the 5th, out on the 6th; sold on the 12th for ₦11m.
    const a1 = await assetsSvc.create({ name: `Zr${RUN} generator`, kind: "generator", boughtOn: D(5), cost: 12_000_000, lifeMonths: 60, paidHow: "bank", bankAccountId: bank.id });
    ids.assets.push(a1.id);
    debits.generator = await debit(D(6), 12_000_000, "GENERATOR PURCHASE");
    credits.sale = await credit(D(12), 11_000_000, "GENERATOR BUYER");

    // An ₦80m truck on hire purchase: ₦60m financed, ₦20m deposit from the bank.
    const l2 = await loansSvc.create({ kind: "hire_purchase", lender: `Zr${RUN} Truck Finance` });
    ids.loans.push(l2.id);
    const a2 = await assetsSvc.create({
      name: `Zr${RUN} truck`, kind: "truck", boughtOn: D(7), cost: 80_000_000, lifeMonths: 60,
      paidHow: "loan", loanId: l2.id, financed: 60_000_000, bankAccountId: bank.id,
    });
    ids.assets.push(a2.id);
    debits.deposit = await debit(D(7), 20_000_000, "TRUCK DEPOSIT");

    // Office equipment first entered as an expense, then put on the register.
    const [cat] = await client`SELECT id FROM expense_categories WHERE gl_code = '6100'`;
    [{ id: expenseId }] = await client`
      INSERT INTO pfi_expenses (category_id, amount, exchange_rate, description, status, expense_date, admin_approved_at)
      VALUES (${cat.id}, 3000000, 1, ${`${RUN} office printers`}, 'admin_approved', ${D(8)}, ${`${D(8)}T09:00:00+01:00`})
      RETURNING id`;
    expenseId = Number(expenseId);
    const a3 = await assetsSvc.create({ name: `Zr${RUN} printers`, kind: "equipment", paidHow: "expense", expenseId, lifeMonths: 36 });
    ids.assets.push(a3.id);

    // Money in, booked before anyone knew what it was: a ₦7m loan entered after the first run.
    credits.late = await credit(D(9), 7_000_000, "OTHER LENDER");

    await run({ only: TYPES });
    await assetsSvc.dispose(a1.id, { disposedOn: D(12), disposedFor: 11_000_000, bankAccountId: bank.id });
    const l3 = await loansSvc.create({ kind: "other_lender", lender: `Zr${RUN} Uncle`, amount: 7_000_000, receivedOn: D(9), bankAccountId: bank.id });
    ids.loans.push(l3.id);
    await run({ only: TYPES });
  });

  after(async () => {
    const creditIds = Object.values(credits);
    const debitIds = Object.values(debits);
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      const mine = tx`
        SELECT id FROM journal_entries
         WHERE (source_type IN ('asset_bought', 'asset_wear', 'asset_sold') AND split_part(source_id, ':', 1)::int = ANY(${ids.assets}::int[]))
            OR (source_type = 'loan_received' AND source_id::int = ANY(${ids.loans}::int[]))
            OR (source_type = 'loan_repayment' AND source_id::int = ANY(${ids.repayments}::int[]))
            OR (source_type = 'expense_bill' AND source_id = ${String(expenseId)})
            OR (source_type = 'bank_line' AND source_id = ANY(${creditIds.map(String)}))
            OR (source_type = 'bank_debit' AND source_id = ANY(${debitIds.map(String)}))`;
      await tx`DELETE FROM journal_lines WHERE entry_id IN (${mine})`;
      await tx`
        DELETE FROM ledger_postings
         WHERE (source_type IN ('asset_bought', 'asset_sold') AND source_id::int = ANY(${ids.assets}::int[]))
            OR (source_type = 'asset_wear' AND split_part(source_id, ':', 1)::int = ANY(${ids.assets}::int[]))
            OR (source_type = 'loan_received' AND source_id::int = ANY(${ids.loans}::int[]))
            OR (source_type = 'loan_repayment' AND source_id::int = ANY(${ids.repayments}::int[]))
            OR (source_type = 'expense_bill' AND source_id = ${String(expenseId)})
            OR (source_type = 'bank_line' AND source_id = ANY(${creditIds.map(String)}))
            OR (source_type = 'bank_debit' AND source_id = ANY(${debitIds.map(String)}))`;
      await tx`DELETE FROM journal_entries WHERE id IN (${mine})`;
    });
    await client`DELETE FROM bank_line_classifications WHERE (direction = 'credit' AND line_id = ANY(${creditIds}::int[])) OR (direction = 'debit' AND line_id = ANY(${debitIds}::int[]))`;
    await client`DELETE FROM bank_statement_lines WHERE id = ANY(${creditIds}::int[])`;
    await client`DELETE FROM bank_statement_debits WHERE id = ANY(${debitIds}::int[])`;
    await client`DELETE FROM fixed_assets WHERE id = ANY(${ids.assets}::int[])`;
    await client`DELETE FROM loan_repayments WHERE loan_id = ANY(${ids.loans}::int[])`;
    await client`DELETE FROM loans WHERE id = ANY(${ids.loans}::int[])`;
    await client`DELETE FROM pfi_expenses WHERE id = ${expenseId}`;
    await client`DELETE FROM bank_statements WHERE id = ${statementId}`;
    await client`DELETE FROM expense_categories WHERE bank_account_id = ${bank.id}`;
    await client`DELETE FROM bank_accounts WHERE id = ${bank.id}`;
    await closeDb();
  });

  test("each register record finds its line on the statement", async () => {
    assert.equal((await kindOf("credit", credits.loan))?.kind, "loan");
    assert.equal((await kindOf("debit", debits.repayment))?.kind, "loan_repayment");
    assert.equal((await kindOf("debit", debits.generator))?.kind, "asset");
    assert.equal((await kindOf("debit", debits.deposit))?.kind, "asset");
    assert.equal((await kindOf("credit", credits.sale))?.kind, "asset_sale");
    assert.equal((await kindOf("credit", credits.late))?.kind, "loan", "a line booked unmatched is matched once its loan is entered");
  });

  test("the bank holds exactly its statement: 50 + 7 + 11 in, 4.5 + 12 + 20 out", async () => {
    [{ id: bankAccountId }] = await client`SELECT id FROM expense_categories WHERE bank_account_id = ${bank.id}`;
    assert.equal(await booked(Number(bankAccountId)), 50_000_000 + 7_000_000 + 11_000_000 - 4_500_000 - 12_000_000 - 20_000_000);
    assert.equal(await booked(accounts.suspense), 0, "nothing of ours is left to match");
  });

  test("each loan is owed lender by lender, less what was paid off it", async () => {
    assert.equal(await booked(accounts.loans, { partyId: ids.loans[0] }), -46_000_000);
    assert.equal(await booked(accounts.loans, { partyId: ids.loans[1] }), -60_000_000, "the hire purchase carries what it financed");
    assert.equal(await booked(accounts.loans, { partyId: ids.loans[2] }), -7_000_000);
    assert.equal(await booked(accounts.loan_interest), 500_000);
    const { loans } = await loansSvc.list({ at: D(15) });
    const hp = loans.find((n) => n.id === ids.loans[1]);
    assert.equal(hp.borrowed, 60_000_000);
    assert.equal(loans.find((n) => n.id === ids.loans[0]).stillOwed, 46_000_000);
  });

  test("assets are owned at cost; the expense one is owned, not spent", async () => {
    // 12 + 80 + 3 bought, 12 gone with the generator.
    assert.equal(await booked(accounts.fixed_assets), 83_000_000);
    const [cat] = await client`SELECT id FROM expense_categories WHERE gl_code = '6100'`;
    assert.equal(await booked(Number(cat.id)), 0, "office equipment is not a cost once it is on the register");
    // Sold for ₦11m having worn nothing: a ₦1m loss.
    assert.equal(await booked(accounts.asset_disposals), 1_000_000);
  });

  test("wear: a month at a time once it has ended, never before the books for a cost", async () => {
    const wear = require("../lib/accounting/postingSources/assets").find((s) => s.type === "asset_wear");
    const records = (await wear.load(db, { today: "2026-12-31" })).filter((r) => ids.assets.includes(Number(r.id.split(":")[0])));
    const truck = records.filter((r) => r.id.startsWith(`${ids.assets[1]}:`));
    assert.deepEqual(truck.map((r) => r.date), ["2026-11-30", "2026-12-31"]);
    assert.equal(truck[0].lines[0].debit, 1_333_333.33);
    assert.equal(truck[0].lines[0].key, "depreciation");
    assert.ok(!records.some((r) => r.id.startsWith(`${ids.assets[0]}:`)), "the generator, sold in October, never wears");
  });

  test("the report counts each naira in and out of the bank once", async () => {
    const rep = await report({ from: D(1), to: D(15) });
    const row = bankRow(rep);
    assert.equal(row.moneyIn, 68_000_000, "the ₦7m booked unmatched then matched is in once, not twice");
    assert.equal(row.moneyOut, 36_500_000);
    assert.equal(row.atEnd, 31_500_000);
    const delta = (direction, label) => Math.round((flow(rep, direction, label) - flow(before1, direction, label)) * 100) / 100;
    assert.equal(delta("in", "Loans received"), 57_000_000);
    assert.equal(delta("in", "Assets sold"), 11_000_000);
    assert.equal(delta("out", "Loans repaid"), 4_000_000);
    assert.equal(delta("out", "Interest on loans"), 500_000);
    assert.equal(delta("out", "Assets bought"), 32_000_000, "the hire purchase reads as its deposit, not its cost");
    assert.equal(delta("in", "Not yet explained"), 0);
    // The interest is a head-office cost, on no PFI: its row says so.
    assert.equal(rep.byPfi.find((r) => r.key === "")?.label, "Not tied to a PFI");
  });

  test("taking an asset off the register gives its expense back to the expense", async () => {
    await assetsSvc.remove(ids.assets[2]);
    await run({ only: TYPES });
    const [cat] = await client`SELECT id FROM expense_categories WHERE gl_code = '6100'`;
    assert.equal(await booked(Number(cat.id)), 3_000_000);
    assert.equal(await booked(accounts.fixed_assets), 80_000_000);
  });
});
