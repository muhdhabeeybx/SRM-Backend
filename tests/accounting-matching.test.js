require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { run } = require("../services/accounting/posting.service");
const recon = require("../services/accounting/reconciliation.service");
const { ownNames, sentByUs } = require("../services/accounting/bankMatching.service");
const { closeDb } = require("./helpers");

/**
 * Money out recognised by itself (services/accounting/bankMatching, 0085).
 *
 *   transfer   a withdrawal from one of our accounts and the same money into
 *              another is a transfer — out of the first bank, into the second,
 *              neither income nor cost; money in from one of our own names
 *              waits for its other side, and meets it when it comes
 *   expense    the withdrawal that paid an expense: the expense is paid out of
 *              that bank on that day, and the line is not booked twice
 *   charges    the bank's own charge goes to Bank charges — a large payment
 *              that merely says "commission" does not
 *   supplier   a payment to Dangote is paid for cargo
 *   left       a line Finance takes back is left to explain, and never
 *              recognised again
 */
const RUN = String(Date.now()).slice(-6);
const D = (n) => `2026-10-${String(n).padStart(2, "0")}`;

describe("money out recognised by itself", () => {
  const banks = {};
  const lines = { credit: {}, debit: {} };
  let statementIds = [];
  let expenseId;
  let accounts;

  const credit = async (bank, day, amount, depositor) => {
    const [r] = await client`
      INSERT INTO bank_statement_lines (bank_account_id, statement_id, txn_date, amount, depositor, narration, dedup_key)
      VALUES (${banks[bank].id}, ${banks[bank].statement}, ${day}, ${amount}, ${depositor}, ${depositor}, ${`M${RUN}${Math.random()}`.slice(0, 60)})
      RETURNING id`;
    return Number(r.id);
  };
  const debit = async (bank, day, amount, narration) => {
    const [r] = await client`
      INSERT INTO bank_statement_debits (bank_account_id, statement_id, txn_date, amount, beneficiary, narration, dedup_key)
      VALUES (${banks[bank].id}, ${banks[bank].statement}, ${day}, ${amount}, '', ${narration}, ${`M${RUN}${Math.random()}`.slice(0, 60)})
      RETURNING id`;
    return Number(r.id);
  };
  const kindOf = async (direction, id) => (await client`
    SELECT kind, auto, ref_id FROM bank_line_classifications WHERE direction = ${direction} AND line_id = ${id}`)[0] || null;
  const onAccount = async (key, type, id) => {
    const [r] = await client`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS b
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.source_type = ${type} AND e.source_id = ${String(id)}
         AND l.account_id = ${key.startsWith("bank:") ? (await client`SELECT id FROM expense_categories WHERE bank_account_id = ${Number(key.slice(5))}`)[0].id : accounts[key]}`;
    return Number(r.b);
  };

  before(async () => {
    accounts = Object.fromEntries((await client`
      SELECT system_key, id FROM expense_categories WHERE system_key IS NOT NULL`).map((r) => [r.system_key, Number(r.id)]));
    for (const [key, name] of [["warri", `Zq${RUN} Warri`], ["fidelity", `Zq${RUN} Expenses`]]) {
      const [b] = await client`
        INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
        VALUES ('Match Bank', ${name}, ${`55${RUN}${key === "warri" ? "01" : "02"}`}, 'Active') RETURNING id, account_number`;
      const [st] = await client`INSERT INTO bank_statements (bank_account_id, filename) VALUES (${b.id}, ${`m-${RUN}.csv`}) RETURNING id`;
      banks[key] = { id: Number(b.id), number: b.account_number, statement: Number(st.id) };
      statementIds.push(Number(st.id));
    }
    // Warri sends ₦9,000,000 to Fidelity Expenses; it lands the next day.
    lines.debit.transfer = await debit("warri", D(3), 9_000_000, "TRF TO EXPENSES ACCOUNT");
    lines.credit.transfer = await credit("fidelity", D(4), 9_000_000, `ZQ${RUN} WARRI/Sunday exp dept`);
    // Money in from one of our names whose other side is not on file yet.
    lines.credit.waiting = await credit("fidelity", D(5), 4_250_000, `ZQ${RUN} WARRI/second exp`);
    // An expense marked paid from Fidelity on the 6th, its withdrawal on the 7th.
    const [cat] = await client`SELECT id FROM expense_categories WHERE gl_group = 'general' AND NOT COALESCE(is_refund, false) ORDER BY gl_code LIMIT 1`;
    [{ id: expenseId }] = await client`
      INSERT INTO pfi_expenses (category_id, amount, exchange_rate, description, status, expense_date, admin_approved_at,
                                amount_paid, payment_date, paid_at, bank_paid_from)
      VALUES (${cat.id}, 337500, 1, ${`${RUN} diesel`}, 'paid', ${D(6)}, ${`${D(6)}T09:00:00+01:00`},
              337500, ${`${D(6)}T10:00:00+01:00`}, ${`${D(6)}T10:00:00+01:00`}, ${`Match Bank · ${banks.fidelity.number}`})
      RETURNING id`;
    expenseId = Number(expenseId);
    lines.debit.expense = await debit("fidelity", D(7), 337_500, "NIP TO DIESEL VENDOR");
    // The bank's charges, and a commission payment that is not one.
    lines.debit.charge = await debit("fidelity", D(7), 50, "SMS ALERT CHARGES");
    lines.debit.commission = await debit("fidelity", D(8), 4_628_000, "COMMISSION CALABAR");
    // Paid to Dangote for cargo.
    lines.debit.cargo = await debit("warri", D(8), 1_215_000_000, "TRF TO DANGOTE PETROLEUM REFINERY");
    // Something nobody can say: a person will look at it.
    lines.debit.mystery = await debit("warri", D(9), 777_777, "TRANSFER");

    await run({ only: ["bank_line", "bank_debit", "expense_paid"] });
  });

  after(async () => {
    const credits = Object.values(lines.credit);
    const debits = Object.values(lines.debit);
    await client.begin(async (tx) => {
      await tx`SET LOCAL ledger.allow_rewrite = 'on'`;
      const mine = tx`
        SELECT id FROM journal_entries
         WHERE (source_type = 'bank_line' AND source_id = ANY(${credits.map(String)}))
            OR (source_type = 'bank_debit' AND source_id = ANY(${debits.map(String)}))
            OR (source_type IN ('expense_paid', 'expense_bill') AND source_id = ${String(expenseId)})`;
      await tx`DELETE FROM journal_lines WHERE entry_id IN (${mine})`;
      await tx`
        DELETE FROM ledger_postings
         WHERE (source_type = 'bank_line' AND source_id = ANY(${credits.map(String)}))
            OR (source_type = 'bank_debit' AND source_id = ANY(${debits.map(String)}))
            OR (source_type IN ('expense_paid', 'expense_bill') AND source_id = ${String(expenseId)})`;
      await tx`DELETE FROM journal_entries WHERE id IN (${mine})`;
    });
    await client`DELETE FROM bank_line_classifications WHERE (direction = 'credit' AND line_id = ANY(${credits}::int[])) OR (direction = 'debit' AND line_id = ANY(${debits}::int[]))`;
    await client`DELETE FROM bank_statement_lines WHERE id = ANY(${credits}::int[])`;
    await client`DELETE FROM bank_statement_debits WHERE id = ANY(${debits}::int[])`;
    await client`DELETE FROM pfi_expenses WHERE id = ${expenseId}`;
    await client`DELETE FROM bank_statements WHERE id = ANY(${statementIds}::int[])`;
    await client`DELETE FROM expense_categories WHERE bank_account_id IN (${banks.warri.id}, ${banks.fidelity.id})`;
    await client`DELETE FROM bank_accounts WHERE id IN (${banks.warri.id}, ${banks.fidelity.id})`;
    await closeDb();
  });

  test("our own names: the group's, and each account's first two words", () => {
    const names = ownNames([
      { account_name: "SOROMAN NIGERIA LTD CALABAR" }, { account_name: "Soroman Warri" }, { account_name: "Soroman Trucks" },
      { account_name: "ACTION ENERGY LIMITED" },
    ]);
    assert.ok(sentByUs("SOROMAN TRUCKS/Sep SOROMAN eoe Sunday", names));
    assert.ok(sentByUs("ACTION ENERGY L/Exp September", names));
    assert.ok(!sentByUs("ACTION FOODS LTD", names), "a stranger sharing one word is not us");
    assert.ok(!sentByUs("JOHN DOE/TRF TO SOROMAN", names), "a customer paying us is not us");
  });

  test("a transfer between our accounts is out of one and into the other, neither income nor cost", async () => {
    assert.equal((await kindOf("debit", lines.debit.transfer)).kind, "transfer");
    assert.equal((await kindOf("credit", lines.credit.transfer)).kind, "transfer");
    assert.equal(await onAccount(`bank:${banks.warri.id}`, "bank_debit", lines.debit.transfer), -9_000_000);
    assert.equal(await onAccount(`bank:${banks.fidelity.id}`, "bank_line", lines.credit.transfer), 9_000_000);
    assert.equal(await onAccount("transfers_clearing", "bank_debit", lines.debit.transfer)
      + await onAccount("transfers_clearing", "bank_line", lines.credit.transfer), 0);
  });

  test("money in from one of our names waits for its other side, and meets it", async () => {
    const waiting = await kindOf("credit", lines.credit.waiting);
    assert.deepEqual([waiting.kind, waiting.ref_id], ["transfer", null]);
    lines.debit.late = await debit("warri", D(5), 4_250_000, "TRF TO EXPENSES ACCOUNT");
    await run({ only: ["bank_line", "bank_debit"] });
    assert.equal((await kindOf("debit", lines.debit.late)).kind, "transfer");
    assert.equal(Number((await kindOf("credit", lines.credit.waiting)).ref_id), lines.debit.late);
  });

  test("the withdrawal that paid an expense: the expense is paid from that bank, that day, once", async () => {
    const k = await kindOf("debit", lines.debit.expense);
    assert.deepEqual([k.kind, Number(k.ref_id), k.auto], ["expense", expenseId, true]);
    assert.equal(await onAccount(`bank:${banks.fidelity.id}`, "expense_paid", expenseId), -337_500);
    assert.equal(await onAccount("suspense", "expense_paid", expenseId), 0);
    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM journal_entries WHERE source_type = 'bank_debit' AND source_id = ${String(lines.debit.expense)}`;
    assert.equal(n, 0, "not booked a second time as a withdrawal");
    const [day] = await client`SELECT entry_date::text AS d FROM journal_entries WHERE source_type = 'expense_paid' AND source_id = ${String(expenseId)} ORDER BY id DESC LIMIT 1`;
    assert.equal(day.d, D(7));
  });

  test("the bank's charge is a bank charge; a commission payment is not", async () => {
    assert.equal((await kindOf("debit", lines.debit.charge)).kind, "charges");
    assert.equal(await onAccount("bank_charges", "bank_debit", lines.debit.charge), 50);
    assert.equal(await kindOf("debit", lines.debit.commission), null);
  });

  test("a payment to Dangote is paid for cargo", async () => {
    assert.equal((await kindOf("debit", lines.debit.cargo)).kind, "supplier");
    assert.equal(await onAccount("supplier_payables", "bank_debit", lines.debit.cargo), 1_215_000_000);
  });

  test("the Banks page shows each account, and what is still to explain", async () => {
    const { banks: all } = await recon.banks({ from: D(1), to: D(31) });
    const fidelity = all.find((b) => b.bankAccountId === banks.fidelity.id);
    // The commission payment is the one line nobody has said.
    assert.deepEqual(fidelity.toExplain, { count: 1, amount: 4_628_000 });
    const r = await recon.reconciliation({ bankAccountId: banks.warri.id, from: D(1), to: D(31) });
    assert.ok(r.moneyOut.find((l) => l.id === lines.debit.cargo).namedTo.auto);
    assert.equal(r.moneyOut.find((l) => l.id === lines.debit.mystery).namedTo, null);
  });

  test("a line Finance takes back is left to explain, and is not recognised again", async () => {
    await recon.unclassify({ direction: "debit", lineId: lines.debit.charge });
    await run({ only: ["bank_debit"] });
    assert.equal((await kindOf("debit", lines.debit.charge)).kind, "left");
    assert.equal(await onAccount("bank_charges", "bank_debit", lines.debit.charge), 0);
    assert.equal(await onAccount("suspense", "bank_debit", lines.debit.charge), 50);
  });
});
