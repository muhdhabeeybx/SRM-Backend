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
    await closeDb();
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
