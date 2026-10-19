require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");
const { paymentReference } = require("../repositories/bankStatement.repository");

/**
 * A reference is the same reference with its spaces taken out, and an
 * all-digit one with its leading zeros taken off.
 *
 * FCMB's .xlsx wraps long references inside the cell, so one export read
 * "NIP/261016161 0090002467353 42" and the next "NIP/261016161009000246735342".
 * Upload 841 on account 18 (19 Oct 2026) brought 80 credits in twice that way,
 * and 4 more whose all-digit reference had lost its "00" to Excel in the
 * earlier file — ₦6,187,148,000 sitting unmatched beside matched twins.
 */
describe("a reference written with spaces or without its leading zeros is the same payment", () => {
  test("spaces, case and leading zeros do not change a reference", () => {
    assert.equal(paymentReference("NIP/261016161 0090002467353 42"), paymentReference("NIP/261016161009000246735342"));
    assert.equal(paymentReference("NIP/261016161\n0090002467353\t42"), paymentReference("nip/261016161009000246735342"));
    assert.equal(paymentReference("1203255970/S8 0611550"), paymentReference("1203255970/S80611550"));
    assert.equal(paymentReference("001202710327"), paymentReference("1202710327"));
    assert.equal(paymentReference("0"), "0");
    assert.equal(paymentReference("   "), null);
    // Only an all-digit reference loses its zeros.
    assert.notEqual(paymentReference("00AB12"), paymentReference("AB12"));
  });

  const stamp = Date.now().toString().slice(-8);
  let token, accountId;
  let ready = false;

  const row = (date, ref, amount) => ({
    txnDate: date, amount: String(amount), depositor: "NIP FRM REHOBOTH ENERGY GLOBAL", narration: "NIP FRM REHOBOTH ENERGY GLOBAL", bankRef: ref,
    rawRow: [date, "NIP FRM REHOBOTH ENERGY GLOBAL", ref, date, String(amount), "0"],
  });
  const SPACED = `NIP/261018092 2130757${stamp} 40`;
  const TIGHT = `NIP/2610180922130757${stamp}40`;
  const DIGITS = `12${stamp}`;

  before(async () => {
    try {
      const [a] = await client`
        INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
        VALUES ('FCMB', 'REF SPACING TEST', ${`93${stamp}`}, 'Active') RETURNING id`;
      accountId = Number(a.id);
      await client`
        INSERT INTO bank_statement_column_mappings (bank_account_id, header_row, date_column, credit_column, depositor_column, reference_column, narration_column)
        VALUES (${accountId}, 0, 0, 4, 1, 2, 1)`;
      token = await staffToken(request, app);
      const res = await request(app).post("/api/bank-statements").set("Authorization", `Bearer ${token}`).send({
        bankAccountId: accountId, filename: "fcmb 3245.xlsx",
        rows: [row("2026-10-18", SPACED, 67275000), row("2026-10-17", DIGITS, 50000000)],
      });
      if (res.status !== 200) throw new Error(`first upload: ${res.status} ${JSON.stringify(res.body)}`);
      ready = true;
    } catch (e) {
      console.error("reference-spacing fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (accountId) {
      await client`DELETE FROM bank_statement_lines WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_statement_column_mappings WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    }
    await closeDb();
  });

  const post = (url, rows) => request(app).post(url).set("Authorization", `Bearer ${token}`)
    .send({ bankAccountId: accountId, filename: "2005263797-19124023299.xlsx", rows });
  const skip = (t) => !ready && t.skip("fixtures unavailable");

  test("the preview calls both credits already on file, and imports only the new one", async (t) => {
    if (skip(t)) return;
    const res = await post("/api/bank-statements/preview", [
      row("2026-10-18", TIGHT, 67275000),
      row("2026-10-17", `00${DIGITS}`, 50000000),
      row("2026-10-19", `NIP/261018210342${stamp}02`, 60525000),
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.importing, 1);
    assert.deepEqual(res.body.data.skipped.map((r) => r.reason), ["reference", "reference"]);
  });

  test("the upload brings in only the new credit, and the lines on file keep the reference as printed", async (t) => {
    if (skip(t)) return;
    const res = await post("/api/bank-statements", [
      row("2026-10-18", TIGHT, 67275000),
      row("2026-10-17", `00${DIGITS}`, 50000000),
      row("2026-10-19", `NIP/261018210342${stamp}02`, 60525000),
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.added, 1);
    const refs = (await client`SELECT bank_ref FROM bank_statement_lines WHERE bank_account_id = ${accountId} ORDER BY id`).map((l) => l.bank_ref);
    assert.deepEqual(refs, [SPACED, DIGITS, `NIP/261018210342${stamp}02`]);
  });

  test("two rows in one file that differ only by spaces are one credit", async (t) => {
    if (skip(t)) return;
    const res = await post("/api/bank-statements/preview", [
      row("2026-10-16", `NIP/2610192 00${stamp}`, 1000000),
      row("2026-10-16", `NIP/261019200${stamp}`, 1000000),
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.importing, 1);
    assert.equal(res.body.data.skipped[0].reason, "reference in this file");
  });
});
