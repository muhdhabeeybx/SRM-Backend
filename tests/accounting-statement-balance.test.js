require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { statementBalance } = require("../services/accounting/reconciliation.service");
const { closeDb } = require("./helpers");

/**
 * The balance a statement prints at the end of a day (reconciliation.service).
 *
 *   heading    read under the Balance heading — Zenith's export ends with a
 *              PaymentId after it, which "the last number" took for ₦33.5bn
 *   last row   the day's closing balance is the end of the chain its rows
 *              make, whatever order they were stored in
 *   old rows   rows carried from the old system, kept by heading, are read too
 */
const RUN = String(Date.now()).slice(-6);

describe("a statement's printed balance", () => {
  let zenith;
  let legacy;

  before(async () => {
    const bank = async (name) => Number((await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
      VALUES ('Balance Bank', ${`${name} ${RUN}`}, ${`66${RUN}`}, 'Active') RETURNING id`)[0].id);
    zenith = await bank("Zenith layout");
    legacy = await bank("Old layout");
    await client`
      INSERT INTO bank_statement_column_mappings (bank_account_id, header_row, date_column, credit_column, debit_column, sample_headers)
      VALUES (${zenith}, 0, 0, 3, 2, ${JSON.stringify(["Date", "Description", "DebitAmount", "CreditAmount", "Balance", "PaymentId"])}::jsonb)`;
    const [st] = await client`INSERT INTO bank_statements (bank_account_id, filename) VALUES (${zenith}, 'z.csv') RETURNING id`;
    // Exported newest first, so stored newest first: 76.6m → +2,587,000 → 79.19m.
    const line = (amount, balance, paymentId) => client`
      INSERT INTO bank_statement_lines (bank_account_id, statement_id, txn_date, amount, raw_row, dedup_key)
      VALUES (${zenith}, ${st.id}, '2026-08-31', ${amount},
              ${JSON.stringify(["31/08/2026", "NIP", "0", String(amount), String(balance), String(paymentId)])}::jsonb,
              ${`B${RUN}${paymentId}`})`;
    await line(2_587_000, 79_193_113.63, 33505874637);
    await line(311_890, 76_606_113.63, 33501022001);
    await client`
      INSERT INTO bank_statement_lines (bank_account_id, statement_id, txn_date, amount, raw_row, dedup_key)
      VALUES (${legacy}, ${st.id}, '2026-07-29', 55800000,
              ${JSON.stringify({ "Txn Date": "07/29/2026", Lodgments: 55800000, Withdrawals: 0, Balance: 81595956.22 })}::jsonb,
              ${`L${RUN}`})`;
  });

  after(async () => {
    await client`DELETE FROM bank_statement_lines WHERE bank_account_id IN (${zenith}, ${legacy})`;
    await client`DELETE FROM bank_statements WHERE bank_account_id IN (${zenith}, ${legacy})`;
    await client`DELETE FROM bank_statement_column_mappings WHERE bank_account_id IN (${zenith}, ${legacy})`;
    await client`DELETE FROM expense_categories WHERE bank_account_id IN (${zenith}, ${legacy})`;
    await client`DELETE FROM bank_accounts WHERE id IN (${zenith}, ${legacy})`;
    await closeDb();
  });

  test("read under the Balance heading, at the end of the day's chain", async () => {
    assert.deepEqual(await statementBalance(zenith, "2026-08-31"), { balance: 79_193_113.63, day: "2026-08-31" });
  });

  test("a row carried from the old system, kept by heading, is read too", async () => {
    assert.deepEqual(await statementBalance(legacy, "2026-08-31"), { balance: 81_595_956.22, day: "2026-07-29" });
  });
});
