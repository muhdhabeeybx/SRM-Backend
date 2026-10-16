require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const repo = require("../repositories/bankStatement.repository");
const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * Reversals and bank charges never enter the pool.
 *
 * They arrive in the credit column looking exactly like a customer's money, so
 * left alone they sit UNMATCHED waiting for somebody to attach one to an order
 * — which invents a payment. Production had nine of them in the pool when this
 * was written, including a ₦129,870,000 reversal.
 *
 * The rows below are the real wording off Soroman's statements, including the
 * two near-misses that a naive rule gets wrong: a payer whose NAME contains
 * "VAT", and a genuine refund of VAT.
 */
describe("bank statement upload — the bank's own entries are left out", () => {
  const RUN = Date.now();
  let accountId = null;

  let seq = 0;
  const row = (depositor, amount, narration = depositor) => {
    seq += 1;
    return {
      txnDate: "2026-09-18",
      amount,
      depositor,
      narration,
      bankRef: `OWN${RUN}${seq}`,
      rawRow: [],
    };
  };

  // Real payments — every one of these must import.
  const PAYMENTS = [
    row("3LCINOVATE ENERGY LIMITED/PRV: To Access Bank | SOROMAN", 250000000),
    row("PP_3LCINOVATE/PMS 2000000/ACB /SOROMAN NIGERIA LIMITED", 220000000),
    row("STERNOM CONSULT/ Refund of VAT", 1376250),
    row("COMMERCIAL AVENUE VENTURES", 5000000),
    row("REVENUE HOUSE LTD", 7500000),
  ];

  // The bank talking to itself — none of these may import.
  const BANK_OWN = [
    row("***RSVL Diesel for truck refinery /CIB//NIP TFR", 129870000),
    row("***RSVL NIP CHARGE + VAT", 53.75),
    row("***RSVL FGN Stamp Duty//NIP CR/MOB/PAYSTACK CHECKOUT", 50),
    row("RVSL NIP TRANSFER", 18131380),
    row("REVSL:TRANSFER RETURNED 05-08-2026", 14609068.4),
    row("NIP CHARGE + VAT", 53.75),
    row("FGN Stamp Duty", 50),
    row("SMS ALERT CHARGE", 400),
  ];

  before(async () => {
    const [a] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
      VALUES ('Own Entry Bank', ${"Own Entry " + RUN}, ${String(RUN).slice(-10)}, 'Active')
      RETURNING id`;
    accountId = Number(a.id);
  });

  after(async () => {
    await client`DELETE FROM bank_statements WHERE bank_account_id = ${accountId}`;
    await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    // The connection is closed by the last describe in this file.
  });

  test("the preview offers the payments and names every bank entry it left out", async () => {
    const result = await repo.previewIngest({
      bankAccountId: accountId,
      rows: [...PAYMENTS, ...BANK_OWN],
    });

    assert.deepEqual(
      result.fresh.map((r) => r.depositor).sort(),
      PAYMENTS.map((r) => r.depositor).sort(),
      "exactly the real payments are offered for import",
    );
    assert.equal(result.excluded, BANK_OWN.length);
    assert.equal(result.duplicates, 0, "a reversal is not reported as a duplicate");

    for (const r of result.skipped) {
      assert.ok(
        r.reason === "reversal" || r.reason === "bank charge",
        `${r.depositor} is left out with a reason the screen can show (got ${r.reason})`,
      );
    }
  });

  test("the reversal marker wins over the charge wording", async () => {
    const { skipped } = await repo.previewIngest({
      bankAccountId: accountId,
      rows: [row("***RSVL NIP CHARGE + VAT", 53.75), row("NIP CHARGE + VAT", 53.75)],
    });
    assert.deepEqual(skipped.map((r) => r.reason), ["reversal", "bank charge"]);
  });

  /**
   * The case that shaped the rule. A substring match on "vat" drops every
   * payment from 3LCINOVATE — ten real credits, over ₦2.2bn on the book — and
   * "Refund of VAT" is money that genuinely arrived.
   */
  test("a payer whose name contains a fee word is not mistaken for a fee", async () => {
    const { fresh, excluded } = await repo.previewIngest({
      bankAccountId: accountId,
      rows: [
        row("3LCINOVATE ENERGY LTD/pms 2000000", 37500000),
        row("STERNOM CONSULT/ Refund of VAT", 1376250),
        row("Recharge of wallet float", 250000),
      ],
    });
    assert.equal(excluded, 0);
    assert.equal(fresh.length, 3);
  });

  test("the wording is found wherever the bank put it — depositor, narration or reference", async () => {
    const inRef = { ...row("ORDINARY DEPOSITOR", 53.75, "ordinary narration"), bankRef: "***RSVL NIP CHARGE" };
    const inNarration = row("ORDINARY DEPOSITOR", 50, "FGN Stamp Duty");
    const { excluded } = await repo.previewIngest({ bankAccountId: accountId, rows: [inRef, inNarration] });
    assert.equal(excluded, 2);
  });

  test("an upload stores the payments and nothing else", async () => {
    const result = await repo.ingest({
      bankAccountId: accountId,
      filename: `own-${RUN}.xlsx`,
      rows: [...PAYMENTS, ...BANK_OWN],
    });

    assert.equal(result.added, PAYMENTS.length);
    assert.equal(result.excluded, BANK_OWN.length);
    assert.equal(result.excludedRows.length, BANK_OWN.length, "the caller is handed the rows, not just a count");

    const stored = await client`
      SELECT depositor FROM bank_statement_lines WHERE bank_account_id = ${accountId}`;
    assert.equal(stored.length, PAYMENTS.length);
    assert.ok(
      stored.every((s) => !/rsvl|rvsl|stamp duty|nip charge|sms alert/i.test(s.depositor)),
      "no reversal or charge reached the pool",
    );
  });

  /**
   * The bank's entries found on the live book on 16 Oct 2026: a fee taken
   * back (Keystone), interest the bank charged, and an SMS charge whose
   * wording only reached the row's own cells (account 14 maps depositor and
   * narration onto "-").
   */
  test("fee recoveries, debit interest and wording only in the row's cells are left out", async () => {
    const tns = row("TNS Recovery SEPT 28-30 2026 TNS Recovery SEPT 28-30 2026 Txn Amount - NGN108.00 VATMAIN - NGN8.10 - VAT -", 108);
    const vatOnFee = row("AC-PL52063 TNS Recovery SEPT 28-30 2026 Txn Amount - NGN108.00 VATMAIN - NGN8.10 - VAT -", 8.1);
    const debitInterest = row("DEBIT INT ACQUIRED", 195708.76);
    const inCells = { ...row("-", 640, "-"), rawRow: ["259QRTY26", "26/09/2026", "-", "SMS CHARGE 28AUG TO 24SEP 2026 NGN", "640", "0"] };
    const { fresh, skipped } = await repo.previewIngest({
      bankAccountId: accountId,
      rows: [tns, vatOnFee, debitInterest, inCells],
    });
    assert.equal(fresh.length, 0);
    assert.deepEqual(skipped.map((r) => r.reason), ["bank charge", "bank charge", "bank charge", "bank charge"]);
  });

  /**
   * A row kept as an object is keyed by the file's headings. "Amount Credit"
   * is on 278 real payments as a heading; a "Charges" column would be on every
   * row. Headings are not the bank speaking.
   */
  test("a file's column headings are not read as wording", async () => {
    const keyed = {
      ...row("ZARANDA MULTI BUSINESS", 21000000, "Trf for Customer"),
      rawRow: { "Amount Credit": "21,000,000.00", Charges: "0.00", Narration: "Trf for Customer", "Credit Interest": "" },
    };
    const { fresh, excluded } = await repo.previewIngest({ bankAccountId: accountId, rows: [keyed] });
    assert.equal(excluded, 0);
    assert.equal(fresh.length, 1);
  });

  test("a file of nothing but bank entries imports nothing", async () => {
    const result = await repo.ingest({
      bankAccountId: accountId,
      filename: `charges-only-${RUN}.xlsx`,
      rows: [row("***RSVL NIP CHARGE + VAT", 53.75), row("FGN Stamp Duty", 50)],
    });
    assert.equal(result.added, 0);
    assert.equal(result.excluded, 2);
    assert.equal(result.statement, null, "no empty statement is recorded");
  });
});

/**
 * Interest the bank PAID is real money in — the books reconcile every bank to
 * its printed balance, so it is imported — but it is never a payment: off the
 * pool and the payment lists, and refused by every claim (lib/bankEntries).
 */
describe("bank statement — interest paid by the bank is kept, and never a payment", () => {
  const { db } = require("../config/db");
  const { assertNotBankEntries } = require("../lib/bankEntries");
  const RUN = Date.now();
  let accountId = null;
  let interestId = null;
  let paymentId = null;

  const row = (depositor, amount, ref) => ({
    txnDate: "2026-09-30", amount, depositor, narration: depositor, bankRef: ref, rawRow: [],
  });

  before(async () => {
    const [a] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
      VALUES ('Interest Bank', ${"Interest " + RUN}, ${String(RUN + 7).slice(-10)}, 'Active')
      RETURNING id`;
    accountId = Number(a.id);
    const result = await repo.ingest({
      bankAccountId: accountId,
      filename: `interest-${RUN}.xlsx`,
      rows: [row("Credit Interest", 673529.67, `INT${RUN}`), row("NIAN OIL NIGERIA LIMITED", 20000000, `PAY${RUN}`)],
    });
    assert.equal(result.added, 2, "interest is imported with the payment");
    const lines = await client`SELECT id, depositor FROM bank_statement_lines WHERE bank_account_id = ${accountId}`;
    interestId = Number(lines.find((l) => l.depositor === "Credit Interest").id);
    paymentId = Number(lines.find((l) => l.depositor !== "Credit Interest").id);
  });

  after(async () => {
    await client`DELETE FROM bank_statements WHERE bank_account_id = ${accountId}`;
    await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    await closeDb();
  });

  test("the payment pickers do not offer it", async () => {
    const pool = await repo.searchUnmatched({ bankAccountId: accountId, limit: "all" });
    assert.deepEqual(pool.map((l) => Number(l.id)), [paymentId]);
  });

  test("the statement's payments leave it out; the Bank's own entries view shows it", async () => {
    const payments = await repo.accountLines({ bankAccountId: accountId });
    assert.deepEqual(payments.lines.map((l) => Number(l.id)), [paymentId]);
    assert.equal(Number(payments.totals.total_amount), 20000000);
    assert.equal(payments.totals.unmatched, 1);
    assert.equal(payments.totals.bank_count, 1, "the page is told it is there");
    assert.equal(Number(payments.totals.bank_amount), 673529.67);

    const unmatched = await repo.accountLines({ bankAccountId: accountId, status: "UNMATCHED" });
    assert.deepEqual(unmatched.lines.map((l) => Number(l.id)), [paymentId]);

    const own = await repo.accountLines({ bankAccountId: accountId, status: "BANK" });
    assert.deepEqual(own.lines.map((l) => Number(l.id)), [interestId]);
    assert.equal(own.lines[0].bank_entry, "interest");
    assert.equal(own.totals.unmatched, 0);

    const [day] = await repo.accountDays({ bankAccountId: accountId });
    assert.equal(day.line_count, 1);
    assert.equal(Number(day.total_amount), 20000000);
  });

  test("a claim naming it is refused; the payment beside it is not", async () => {
    await assert.rejects(assertNotBankEntries(db, [paymentId, interestId]), (err) =>
      err.status === 409 && /bank's own entry: Credit Interest/.test(err.message));
    await assertNotBankEntries(db, [paymentId]);
  });

  test("a line already matched is left as it was", async () => {
    await client`UPDATE bank_statement_lines SET status = 'MATCHED' WHERE id = ${interestId}`;
    try {
      await assertNotBankEntries(db, [interestId]);
      const all = await repo.accountLines({ bankAccountId: accountId, status: "MATCHED" });
      assert.deepEqual(all.lines.map((l) => Number(l.id)), [interestId]);
      assert.equal(all.lines[0].bank_entry, null);
    } finally {
      await client`UPDATE bank_statement_lines SET status = 'UNMATCHED' WHERE id = ${interestId}`;
    }
  });
});
