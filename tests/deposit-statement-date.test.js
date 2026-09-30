require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { db } = require("../config/db");
const { sql } = require("drizzle-orm");
const { closeDb } = require("./helpers");
const { localDateStr } = require("../lib/zonedDay");

/**
 * The deposit date must be the date on the statement, always.
 *
 * `deposits` had no date of its own, so "Deposit Date" was reconstructed at
 * read time from the statement line that funded it — and got it wrong two
 * ways. Both are pinned here. See migration 0017.
 */

const RUN = String(Date.now()).slice(-6);
const rowsOf = (r) => r.rows ?? r;

let customerId;
let accountId;
let statementId;

const cleanup = async () => {
  await db.execute(sql`DELETE FROM bank_statement_lines WHERE bank_ref LIKE ${`DT${RUN}%`}`);
  await db.execute(sql`DELETE FROM deposits WHERE reference LIKE ${`DT${RUN}%`}`);
  await db.execute(sql`DELETE FROM bank_statements WHERE id = ${statementId ?? -1}`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE account_number = ${`ACC${RUN}`}`);
  await db.execute(sql`DELETE FROM customers WHERE phone = ${`0803${RUN}0`}`);
};

describe("deposit date is the statement date", () => {
  before(async () => {
    [{ id: customerId }] = rowsOf(
      await db.execute(sql`
        INSERT INTO customers (name, phone, status)
        VALUES ('Deposit Date Test', ${`0803${RUN}0`}, 'Active') RETURNING id
      `)
    );
    [{ id: accountId }] = rowsOf(
      await db.execute(sql`
        INSERT INTO bank_accounts (bank_name, account_name, account_number)
        VALUES ('Test Bank', 'Soroman Test', ${`ACC${RUN}`}) RETURNING id
      `)
    );
    // Only bank_account_id is required; everything else on the header row is
    // defaulted, so the fixture stays minimal and cannot drift as columns
    // are added around it.
    [{ id: statementId }] = rowsOf(
      await db.execute(sql`
        INSERT INTO bank_statements (bank_account_id) VALUES (${accountId}) RETURNING id
      `)
    );
  });

  after(async () => {
    await cleanup();
    await closeDb();
  });

  test("the column exists and is not defaulted to the entry date", async () => {
    // The whole point: a deposit with no statement behind it must read NULL,
    // not "now". Storing created_at here would recreate the confusion the
    // column exists to end, except stored and so no longer detectable.
    const [row] = rowsOf(
      await db.execute(sql`
        INSERT INTO deposits (customer_id, amount, type, reference, description)
        VALUES (${customerId}, 5000, 'credit', ${`DT${RUN}-nostmt`}, 'Internal transfer')
        RETURNING id, deposit_date, created_at
      `)
    );
    assert.equal(row.deposit_date, null, "no statement means no banking date");
    assert.ok(row.created_at, "the entry date is still recorded, separately");
  });

  test("a deposit carries the statement's own date, not the day it was matched", async () => {
    // The statement says the money landed on 3 March. It is being matched
    // today, weeks later — which is the case that was silently wrong.
    const banked = "2026-03-03T10:15:00Z";
    const [dep] = rowsOf(
      await db.execute(sql`
        INSERT INTO deposits (customer_id, amount, type, reference, deposit_date)
        VALUES (${customerId}, 250000, 'credit', ${`DT${RUN}-a`}, ${banked}::timestamptz)
        RETURNING id, deposit_date, created_at
      `)
    );

    assert.equal(
      new Date(dep.deposit_date).toISOString(),
      new Date(banked).toISOString(),
      "the banking date is stored verbatim"
    );
    // And it is genuinely a different day from the entry date, which is the
    // whole bug — the two coincided only when matching happened same-day.
    assert.notEqual(
      new Date(dep.deposit_date).toDateString(),
      new Date(dep.created_at).toDateString()
    );
  });

  test("with several lines behind one deposit, the EARLIEST banking date wins", async () => {
    // The old query took the lowest id — upload order, not banking order — so
    // whichever line happened to be parsed first decided the date.
    const [dep] = rowsOf(
      await db.execute(sql`
        INSERT INTO deposits (customer_id, amount, type, reference)
        VALUES (${customerId}, 90000, 'credit', ${`DT${RUN}-b`}) RETURNING id
      `)
    );

    // Deliberately inserted so that the LOWER id has the LATER date.
    await db.execute(sql`
      INSERT INTO bank_statement_lines
        (bank_account_id, statement_id, txn_date, amount, bank_ref, dedup_key, matched_deposit_id)
      VALUES
        (${accountId}, ${statementId}, '2026-04-20T09:00:00Z', 60000, ${`DT${RUN}-late`}, ${`k${RUN}1`}, ${dep.id}),
        (${accountId}, ${statementId}, '2026-04-02T09:00:00Z', 30000, ${`DT${RUN}-early`}, ${`k${RUN}2`}, ${dep.id})
    `);

    const [picked] = rowsOf(
      await db.execute(sql`
        SELECT txn_date FROM bank_statement_lines
        WHERE matched_deposit_id = ${dep.id}
        ORDER BY txn_date ASC, id ASC LIMIT 1
      `)
    );
    assert.equal(
      new Date(picked.txn_date).toISOString().slice(0, 10),
      "2026-04-02",
      "earliest banking date, not lowest id"
    );

    // What the old ordering would have produced, kept as the contrast: it is
    // the later date purely because that row was inserted first.
    const [old] = rowsOf(
      await db.execute(sql`
        SELECT txn_date FROM bank_statement_lines
        WHERE matched_deposit_id = ${dep.id} ORDER BY id LIMIT 1
      `)
    );
    assert.equal(new Date(old.txn_date).toISOString().slice(0, 10), "2026-04-20");
  });

  test("the backfill reads the matched line, earliest date first", async () => {
    const [dep] = rowsOf(
      await db.execute(sql`
        INSERT INTO deposits (customer_id, amount, type, reference)
        VALUES (${customerId}, 11000, 'credit', ${`DT${RUN}-c`}) RETURNING id
      `)
    );
    await db.execute(sql`
      INSERT INTO bank_statement_lines
        (bank_account_id, statement_id, txn_date, amount, bank_ref, dedup_key, matched_deposit_id)
      VALUES (${accountId}, ${statementId}, '2026-01-09T08:00:00Z', 11000, ${`DT${RUN}-bf`}, ${`k${RUN}3`}, ${dep.id})
    `);

    // The same statement migration 0017 runs.
    await db.execute(sql`
      UPDATE deposits d SET deposit_date = l.txn_date
      FROM (
        SELECT DISTINCT ON (matched_deposit_id) matched_deposit_id, txn_date
        FROM bank_statement_lines
        WHERE matched_deposit_id IS NOT NULL
        ORDER BY matched_deposit_id, txn_date ASC, id ASC
      ) l
      WHERE l.matched_deposit_id = d.id AND d.deposit_date IS NULL AND d.id = ${dep.id}
    `);

    const [after] = rowsOf(
      await db.execute(sql`SELECT deposit_date FROM deposits WHERE id = ${dep.id}`)
    );
    // Read as a Lagos day: the database casts a date to Lagos midnight now, so
    // the UTC reading of the same instant is the evening before.
    assert.equal(localDateStr(new Date(after.deposit_date)), "2026-01-09");
  });

  test("the backfill also recovers a date from paystack_details.paidAt", async () => {
    // Deposits whose statement line was deleted with its statement still have
    // the date in the JSON the match path has always written.
    const [dep] = rowsOf(
      await db.execute(sql`
        INSERT INTO deposits (customer_id, amount, type, reference, paystack_details)
        VALUES (${customerId}, 7000, 'credit', ${`DT${RUN}-d`},
                ${JSON.stringify({ paidAt: "2025-11-14T12:00:00Z" })}::jsonb)
        RETURNING id
      `)
    );

    await db.execute(sql`
      UPDATE deposits
      SET deposit_date = (paystack_details ->> 'paidAt')::timestamptz
      WHERE deposit_date IS NULL
        AND paystack_details ? 'paidAt'
        AND NULLIF(paystack_details ->> 'paidAt', '') IS NOT NULL
        AND (paystack_details ->> 'paidAt') ~ '^\\d{4}-\\d{2}-\\d{2}'
        AND id = ${dep.id}
    `);

    const [after] = rowsOf(
      await db.execute(sql`SELECT deposit_date FROM deposits WHERE id = ${dep.id}`)
    );
    assert.equal(new Date(after.deposit_date).toISOString().slice(0, 10), "2025-11-14");
  });

  test("a malformed paidAt is skipped rather than aborting the backfill", async () => {
    const [dep] = rowsOf(
      await db.execute(sql`
        INSERT INTO deposits (customer_id, amount, type, reference, paystack_details)
        VALUES (${customerId}, 800, 'credit', ${`DT${RUN}-e`},
                ${JSON.stringify({ paidAt: "not a date" })}::jsonb)
        RETURNING id
      `)
    );

    // The guard is the regex — without it this UPDATE throws and takes the
    // whole migration with it.
    await db.execute(sql`
      UPDATE deposits
      SET deposit_date = (paystack_details ->> 'paidAt')::timestamptz
      WHERE deposit_date IS NULL
        AND paystack_details ? 'paidAt'
        AND (paystack_details ->> 'paidAt') ~ '^\\d{4}-\\d{2}-\\d{2}'
        AND id = ${dep.id}
    `);

    const [after] = rowsOf(
      await db.execute(sql`SELECT deposit_date FROM deposits WHERE id = ${dep.id}`)
    );
    assert.equal(after.deposit_date, null, "left null rather than guessed at");
  });
});
