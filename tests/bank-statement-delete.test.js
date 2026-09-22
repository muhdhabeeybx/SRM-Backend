require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const repo = require("../repositories/bankStatement.repository");
const { client } = require("../config/db");
const { closeDb } = require("./helpers");

/**
 * Taking back an upload made by mistake.
 *
 * It must take every line with it — that is the point, a wrong file has to
 * disappear from wherever it shows — and it must refuse outright when any of
 * its money has been used, however that use is recorded.
 */
describe("deleting an uploaded statement", () => {
  const RUN = Date.now();
  let accountId = null;
  let ready = false;

  const upload = async (lines) => {
    const [st] = await client`
      INSERT INTO bank_statements (bank_account_id, filename, row_count)
      VALUES (${accountId}, ${`upload-${RUN}-${Math.random()}.xlsx`}, ${lines.length}) RETURNING id`;
    const ids = [];
    for (const [i, extra] of lines.entries()) {
      const [l] = await client`
        INSERT INTO bank_statement_lines (statement_id, bank_account_id, txn_date, amount, depositor,
                                          narration, bank_ref, status, dedup_key)
        VALUES (${st.id}, ${accountId}, '2026-09-21', ${100000 * (i + 1)}, 'Test', 'delete test',
                ${`DEL${RUN}${i}${Math.random()}`}, ${extra?.status || "UNMATCHED"}, ${`d${String(RUN).slice(-8)}${i}${Math.random().toString(36).slice(2, 12)}`})
        RETURNING id`;
      ids.push(Number(l.id));
    }
    return { statementId: Number(st.id), lineIds: ids };
  };

  before(async () => {
    try {
      const [a] = await client`
        INSERT INTO bank_accounts (bank_name, account_name, account_number, status)
        VALUES ('Delete Bank', ${"Delete " + RUN}, ${String(RUN).slice(-10)}, 'Active') RETURNING id`;
      accountId = Number(a.id);
      ready = true;
    } catch (e) {
      console.error("fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM audit_logs WHERE entity_type = 'bank_statement' AND metadata->>'bankAccountId' = ${String(accountId)}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${accountId}`;
      await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    }
    await closeDb();
  });

  test("an upload nothing has used is removed with every line it brought", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const { statementId, lineIds } = await upload([{}, {}, {}]);

    const result = await repo.deleteStatement(statementId, { staffId: null });
    assert.equal(result.deleted, true);
    assert.equal(result.lines, 3);
    assert.equal(result.total, 600000);

    const [{ n: files }] = await client`SELECT count(*)::int AS n FROM bank_statements WHERE id = ${statementId}`;
    const [{ n: rows }] = await client`SELECT count(*)::int AS n FROM bank_statement_lines WHERE id = ANY(${lineIds}::int[])`;
    assert.equal(files, 0, "the file is gone");
    assert.equal(rows, 0, "and so is every line it brought in");
  });

  test("the deletion is on the record", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const [row] = await client`
      SELECT action, metadata FROM audit_logs
       WHERE entity_type = 'bank_statement' AND metadata->>'bankAccountId' = ${String(accountId)}
       ORDER BY id DESC LIMIT 1`;
    assert.equal(row.action, "bank_statement.deleted");
    assert.equal(Number(row.metadata.lines), 3);
    assert.equal(Number(row.metadata.total), 600000);
  });

  test("an upload with a matched line is refused, and nothing is removed", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const { statementId, lineIds } = await upload([{}, { status: "MATCHED" }]);

    const result = await repo.deleteStatement(statementId);
    assert.equal(result.deleted, false);
    assert.equal(result.matched, 1);

    const [{ n }] = await client`SELECT count(*)::int AS n FROM bank_statement_lines WHERE id = ANY(${lineIds}::int[])`;
    assert.equal(n, 2, "every line is still there");
  });

  test("a line a truck sale claimed counts as used, even if its own status says otherwise", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    /*
     * The case the old status-only check missed. delivery_sales has no
     * foreign key to the line, so nothing would have stopped the delete — the
     * truck sale would have been left pointing at a line that no longer
     * exists, silently.
     */
    const { statementId, lineIds } = await upload([{}]);
    await client`UPDATE bank_statement_lines SET matched_delivery_sale_id = -1 WHERE id = ${lineIds[0]}`;

    const result = await repo.deleteStatement(statementId);
    assert.equal(result.deleted, false);
    assert.equal(result.matched, 1);
  });

  test("an upload that is already gone says so rather than pretending", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const result = await repo.deleteStatement(-12345);
    assert.equal(result.deleted, false);
    assert.equal(result.notFound, true);
  });
});
