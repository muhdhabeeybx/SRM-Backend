require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");

/**
 * A credit uploaded once without its reference, and again with it, is one
 * credit — and the second upload gives the first its reference.
 *
 * Union Bank exports two layouts: one without a reference column, one with.
 * The same credit came in twice on account 54 (18 of them, ₦180,577,925),
 * the bare copy already used by a truck sale, the referenced copy sitting
 * unmatched where it could be used again. Both layouts end a row with the
 * running balance, and amount + balance is the same credit.
 *
 * Shapes are the real ones: the old layout's raw row is
 *   [date, description, description, value date, deposit, withdrawal, balance]
 * and the new one's
 *   [date, description, reference, value date, withdrawal, deposit, balance].
 */
describe("a referenced upload fills in the references of credits already on file", () => {
  const stamp = Date.now().toString().slice(-8);
  let token, accountId, statementId, lineA, lineB, saleId;
  let ready = false;

  const old = (date, payer, amount, balance) => ({
    txnDate: date, amount: String(amount), depositor: payer, narration: payer, bankRef: "",
    rawRow: [`${date}T00:00:00.000Z`, payer, payer, `${date}T00:00:00.000Z`, String(amount), "0", String(balance)],
  });
  const fresh = (date, payer, ref, amount, balance) => ({
    txnDate: date, amount: String(amount), depositor: payer, narration: payer, bankRef: ref,
    rawRow: [date, payer, ref, date, "0", String(amount), String(balance)],
  });
  const MUKHTAR = "UIP Trf from MUKHTAR HARUNA ABDU - NIP/MUKHTAR  |__INTER_BANK_TRANSFER|SOROMAN NIGERI";
  const HUSSAINI = "UIP Trf from HUSSAINI GARGA HUSS - MOBIL";
  const REF_A = `UI000026261005211330${stamp}`;
  const REF_A2 = `UI000026261005212026${stamp}`;
  const REF_B = `UI000014261005144954${stamp}`;

  before(async () => {
    try {
      const [a] = await client`
        INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
        VALUES ('Union Bank', 'REF MERGE TEST', ${`92${stamp}`}, 'Active') RETURNING id`;
      accountId = Number(a.id);
      await client`
        INSERT INTO bank_statement_column_mappings (bank_account_id, header_row, date_column, credit_column, depositor_column, reference_column, narration_column)
        VALUES (${accountId}, 0, 0, 5, 1, 2, 1)`;
      token = await staffToken(request, app);

      // The first upload: the old layout, no references.
      const res = await request(app).post("/api/bank-statements").set("Authorization", `Bearer ${token}`).send({
        bankAccountId: accountId, filename: "union bank.xlsx",
        rows: [old("2026-10-05", MUKHTAR, 19250000, 1336817880), old("2026-10-05", HUSSAINI, 8117120, 1201000000)],
      });
      if (res.status !== 200) throw new Error(`first upload: ${res.status} ${JSON.stringify(res.body)}`);
      statementId = Number(res.body.data.statement.id);
      const lines = await client`SELECT id, amount FROM bank_statement_lines WHERE statement_id = ${statementId} ORDER BY amount DESC`;
      lineA = Number(lines[0].id);
      lineB = Number(lines[1].id);
      // A truck sale already used the first one.
      const [s] = await client`
        INSERT INTO delivery_sales (truck_number, date_loaded, allocation_code, customer_name, quantity, payment_amount, statement_line_id, bank_ref)
        VALUES ('REFM1XB', '2026-10-01', 'PFI-12B', 'Mukhtar', 45000, 19250000, ${lineA}, '') RETURNING id`;
      saleId = Number(s.id);
      await client`UPDATE bank_statement_lines SET status = 'MATCHED', matched_delivery_sale_id = ${saleId} WHERE id = ${lineA}`;
      ready = true;
    } catch (e) {
      console.error("reference-merge fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM audit_logs WHERE entity_type = 'bank_statement_line' AND entity_id IN (SELECT id FROM bank_statement_lines WHERE bank_account_id = ${accountId})`;
      await client`DELETE FROM delivery_sales WHERE id = ${saleId}`;
      await client`DELETE FROM bank_statement_lines WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_statement_column_mappings WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    }
    await closeDb();
  });

  const post = (url, rows) => request(app).post(url).set("Authorization", `Bearer ${token}`)
    .send({ bankAccountId: accountId, filename: "0240307476_account_statement (2).xlsx", rows });
  const skip = (t) => !ready && t.skip("fixtures unavailable");

  // The referenced export: both credits already on file, and a second
  // ₦19.25m from the same payer the same day — a different balance, so a
  // different credit, which must come in.
  const referenced = () => [
    fresh("2026-10-05", MUKHTAR, REF_A, 19250000, 1336817880),
    fresh("2026-10-05", HUSSAINI, REF_B, 8117120, 1201000000),
    fresh("2026-10-05", MUKHTAR, REF_A2, 19250000, 1369288825),
  ];

  test("the preview says which credits get a reference and which are new", async (t) => {
    if (skip(t)) return;
    const res = await post("/api/bank-statements/preview", referenced());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.referencesAdded, 2);
    assert.equal(res.body.data.counts.importing, 1);
    assert.equal(res.body.data.rows[0].bankRef, REF_A2);
    const added = res.body.data.skipped.filter((r) => r.reason === "reference added").map((r) => r.lineId).sort();
    assert.deepEqual(added, [lineA, lineB].sort());
  });

  test("the upload gives both lines their references, the payment too, and imports only the new credit", async (t) => {
    if (skip(t)) return;
    const res = await post("/api/bank-statements", referenced());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.added, 1);
    assert.equal(res.body.data.referencesAdded, 2);
    assert.match(res.body.message, /2 references added/);

    const lines = await client`SELECT id, bank_ref, status FROM bank_statement_lines WHERE bank_account_id = ${accountId} ORDER BY id`;
    assert.equal(lines.length, 3, "two on file plus the one new credit — no duplicates");
    assert.equal(lines.find((l) => Number(l.id) === lineA).bank_ref, REF_A);
    assert.equal(lines.find((l) => Number(l.id) === lineA).status, "MATCHED");
    assert.equal(lines.find((l) => Number(l.id) === lineB).bank_ref, REF_B);
    assert.ok(lines.some((l) => l.bank_ref === REF_A2));

    const [sale] = await client`SELECT bank_ref FROM delivery_sales WHERE id = ${saleId}`;
    assert.equal(sale.bank_ref, REF_A);
    const audit = await client`
      SELECT entity_id, metadata FROM audit_logs WHERE action = 'bank_statement_line.reference_added' AND entity_id = ANY(${[lineA, lineB]})`;
    assert.equal(audit.length, 2);
    // The bank's own row that carried the reference is kept as the evidence for it.
    const forA = audit.find((x) => Number(x.entity_id) === lineA).metadata;
    assert.equal(forA.bankRow[2], REF_A);
  });

  test("the same referenced file again adds nothing", async (t) => {
    if (skip(t)) return;
    const res = await post("/api/bank-statements", referenced());
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const [{ n }] = await client`SELECT count(*)::int AS n FROM bank_statement_lines WHERE bank_account_id = ${accountId}`;
    assert.equal(n, 3);
  });

  test("the old layout uploaded after the new one is on record, not a second copy", async (t) => {
    if (skip(t)) return;
    // The second ₦19.25m first came in WITH its reference; this is it bare.
    const res = await post("/api/bank-statements/preview", [old("2026-10-05", MUKHTAR, 19250000, 1369288825)]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.importing, 0);
    assert.equal(res.body.data.skipped[0].reason, "on record");
  });

  test("a row dated in 2000 — a format reading the wrong column — is refused, preview and upload", async (t) => {
    if (skip(t)) return;
    const misread = { ...fresh("2026-10-05", MUKHTAR, "", 19250000, 1336817880), txnDate: "2000-01-01" };
    for (const url of ["/api/bank-statements/preview", "/api/bank-statements"]) {
      const res = await post(url, [misread]);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.message, /2000-01-01/);
    }
    const [{ n }] = await client`SELECT count(*)::int AS n FROM bank_statement_lines WHERE bank_account_id = ${accountId} AND txn_date < '2015-01-01'`;
    assert.equal(n, 0);
  });

  test("two rows that could both be one line are left alone, never guessed between", async (t) => {
    if (skip(t)) return;
    const [line] = await client`
      INSERT INTO bank_statement_lines (bank_account_id, statement_id, txn_date, amount, depositor, bank_ref, narration, raw_row, dedup_key)
      VALUES (${accountId}, ${statementId}, '2026-10-06', 5000000, 'X', '', 'X',
              ${JSON.stringify(["2026-10-06", "X", "X", "2026-10-06", "5000000", "0", "777000000"])}::jsonb, ${`amb${stamp}`})
      RETURNING id`;
    const res = await post("/api/bank-statements/preview", [
      fresh("2026-10-06", "X", `AMB1${stamp}`, 5000000, 777000000),
      fresh("2026-10-06", "X", `AMB2${stamp}`, 5000000, 777000000),
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.counts.referencesAdded, 0);
    assert.equal(res.body.data.counts.importing, 2);
    await client`DELETE FROM bank_statement_lines WHERE id = ${line.id}`;
  });
});
