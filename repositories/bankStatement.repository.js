const crypto = require("crypto");
const { client } = require("../db");

/**
 * Stable fingerprint for a statement row.
 *
 * SHA-256 over date | bank reference | amount | depositor, truncated to 32
 * characters. Paired with a unique index on (bank_account_id, dedup_key), this
 * is what makes re-uploading an overlapping date range safe.
 */
function dedupKey({ txnDate, bankRef, amount, depositor }) {
  // The plain day, taken off the front of whatever came in rather than routed
  // through Date — the round trip is what shifted it in the first place.
  const day = String(txnDate).slice(0, 10);
  const normalisedAmount = Number(amount).toFixed(2);
  const payload = [
    day,
    String(bankRef || "").trim().toLowerCase(),
    normalisedAmount,
    String(depositor || "").trim().toLowerCase(),
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

const bankStatementRepo = {
  dedupKey,

  // ── Column mapping ────────────────────────────────────────────────────────

  async getMapping(bankAccountId) {
    const [row] = await client`
      SELECT * FROM bank_statement_column_mappings
      WHERE bank_account_id = ${bankAccountId}
    `;
    return row || null;
  },

  async upsertMapping(bankAccountId, m) {
    const [row] = await client`
      INSERT INTO bank_statement_column_mappings
        (bank_account_id, header_row, date_column, amount_column, credit_column,
         depositor_column, reference_column, narration_column, sample_headers, updated_at)
      VALUES (${bankAccountId}, ${m.headerRow ?? 0}, ${m.dateColumn},
              ${m.amountColumn ?? null}, ${m.creditColumn ?? null},
              ${m.depositorColumn ?? null}, ${m.referenceColumn ?? null},
              ${m.narrationColumn ?? null},
              ${JSON.stringify(m.sampleHeaders || [])}::jsonb, now())
      ON CONFLICT (bank_account_id) DO UPDATE SET
        header_row = EXCLUDED.header_row,
        date_column = EXCLUDED.date_column,
        amount_column = EXCLUDED.amount_column,
        credit_column = EXCLUDED.credit_column,
        depositor_column = EXCLUDED.depositor_column,
        reference_column = EXCLUDED.reference_column,
        narration_column = EXCLUDED.narration_column,
        sample_headers = EXCLUDED.sample_headers,
        updated_at = now()
      RETURNING *
    `;
    return row;
  },

  // ── Statements ────────────────────────────────────────────────────────────

  /**
   * Stores a parsed statement.
   *
   * Rows are deduplicated twice: against everything already held for the
   * account (by fingerprint *or* by the bank's own reference), and against the
   * rest of the incoming batch. A statement that yields no new rows is
   * rejected by the caller rather than stored empty.
   */
  async ingest({ bankAccountId, filename, uploadedBy, rows }) {
    const prepared = rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      dedup: dedupKey(r),
    }));

    const existing = await client`
      SELECT dedup_key FROM bank_statement_lines
      WHERE bank_account_id = ${bankAccountId}
    `;
    const seenKeys = new Set(existing.map((e) => e.dedup_key));

    /**
     * A row is a duplicate only if the WHOLE of it matches — date, reference,
     * amount and depositor together.
     *
     * There was a second rule here: a row was also discarded if its bank
     * reference alone matched anything already on the account. That is only
     * safe if the reference column holds a unique transaction id, and on these
     * statements it does not — the mapping points it at the narration, which
     * is text like "POOKIE ENERGY L/To FIDELITY BANK | SOROMAN NIGERIA" and
     * repeats every time that customer pays.
     *
     * So the first payment from a customer silently swallowed every later one.
     * A N38,461,500 credit on 1 September was rejected because a N70,000,000
     * credit from the same payer was already on file — different date,
     * different money, discarded as "already on record" with no way to see
     * which row it collided with.
     *
     * Losing a real credit is far worse than importing a near-duplicate: a
     * missing line looks exactly like money that never arrived, while a
     * doubled one is visible and can be deleted. The composite key still
     * catches the case this was meant to catch — the same file uploaded twice.
     */
    const fresh = [];
    let duplicates = 0;
    for (const r of prepared) {
      if (seenKeys.has(r.dedup)) {
        duplicates++;
        continue;
      }
      seenKeys.add(r.dedup);
      fresh.push(r);
    }

    if (!fresh.length) return { added: 0, duplicates, statement: null };

    /**
     * The date as it was printed, and nothing else.
     *
     * A statement line carries a calendar date — no hour, no zone — and the
     * column is a `date` to match. Sending a full ISO instant here is what put
     * 1,066 rows a day out: the instant was built at local midnight, which is
     * the previous day in UTC, and the shift was invisible because the same
     * browser read it back.
     *
     * So the value is trimmed to YYYY-MM-DD before it is bound. Postgres has
     * no timezone arithmetic to apply to that, which is the whole point.
     */
    const day = (d) => String(d).slice(0, 10);
    const dates = fresh.map((r) => day(r.txnDate)).sort();

    const [statement] = await client`
      INSERT INTO bank_statements
        (bank_account_id, filename, uploaded_by, row_count, duplicate_count,
         period_start, period_end)
      VALUES (${bankAccountId}, ${filename || ""}, ${uploadedBy ?? null},
              ${fresh.length}, ${duplicates},
              ${dates[0]}, ${dates[dates.length - 1]})
      RETURNING *
    `;

    for (const r of fresh) {
      await client`
        INSERT INTO bank_statement_lines
          (bank_account_id, statement_id, txn_date, amount, depositor, bank_ref,
           narration, raw_row, dedup_key)
        VALUES (${bankAccountId}, ${statement.id}, ${day(r.txnDate)}, ${r.amount},
                ${r.depositor || ""}, ${r.bankRef || ""}, ${r.narration || ""},
                ${JSON.stringify(r.rawRow || [])}::jsonb, ${r.dedup})
        ON CONFLICT (bank_account_id, dedup_key) DO NOTHING
      `;
    }

    return { added: fresh.length, duplicates, statement };
  },

  async listStatements(bankAccountId) {
    // A NULL account id means "all accounts" — avoids an empty SQL fragment.
    return client`
      SELECT s.*,
             b.bank_name, b.account_name, b.account_number,
             (SELECT count(*) FROM bank_statement_lines l
               WHERE l.statement_id = s.id AND l.status = 'MATCHED')::int AS matched_count
      FROM bank_statements s
      JOIN bank_accounts b ON b.id = s.bank_account_id
      WHERE (${bankAccountId ?? null}::int IS NULL
             OR s.bank_account_id = ${bankAccountId ?? null}::int)
      ORDER BY s.created_at DESC
    `;
  },

  /**
   * The rows of one uploaded statement, and what became of each.
   *
   * The upload list could say how many rows were matched but never which, so
   * "I uploaded this statement and cannot find some rows" had no answer short
   * of querying the database. Every row now carries its outcome: the order it
   * was matched to, the person who matched it, and when.
   *
   * The order reference is assembled here from the company name and id, the
   * same way every other screen builds it, so a reference read off this page
   * is the one to search for elsewhere. A matched line whose order has since
   * been deleted keeps its deposit but resolves to no order — that state is
   * real (see the PU11486 deletion) and showing it blank would hide it.
   */
  async listStatementLines({ statementId, page = 1, limit = 25, status = null }) {
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
    const rows = await client`
      SELECT l.id, l.txn_date, l.amount, l.depositor, l.narration, l.bank_ref, l.status,
             l.matched_deposit_id, l.matched_order_id, l.matched_at,
             d.reference AS deposit_reference,
             o.id AS order_id, o.company_name AS order_company,
             c.name AS customer_name,
             s.first_name AS matched_by_first_name, s.surname AS matched_by_surname
        FROM bank_statement_lines l
        LEFT JOIN deposits d ON d.id = l.matched_deposit_id
        LEFT JOIN orders o ON o.id = l.matched_order_id
        LEFT JOIN customers c ON c.id = d.customer_id
        LEFT JOIN staff s ON s.id = l.matched_by
       WHERE l.statement_id = ${statementId}
         AND (${status}::text IS NULL OR l.status::text = ${status}::text)
       ORDER BY l.txn_date ASC, l.id ASC
       LIMIT ${Number(limit)} OFFSET ${offset}
    `;

    const [{ total, matched, unmatched }] = await client`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'MATCHED')::int AS matched,
             count(*) FILTER (WHERE status <> 'MATCHED')::int AS unmatched
        FROM bank_statement_lines
       WHERE statement_id = ${statementId}
         AND (${status}::text IS NULL OR status::text = ${status}::text)
    `;

    return {
      lines: rows,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
      totals: { total, matched, unmatched },
    };
  },

  /** Refuses to delete once any line has been matched — that is audit trail. */
  async deleteStatement(id) {
    const [{ matched }] = await client`
      SELECT count(*)::int AS matched FROM bank_statement_lines
      WHERE statement_id = ${id} AND status = 'MATCHED'
    `;
    if (matched > 0) return { deleted: false, matched };
    await client`DELETE FROM bank_statements WHERE id = ${id}`;
    return { deleted: true, matched: 0 };
  },

  // ── The matching pool ─────────────────────────────────────────────────────

  /**
   * Unmatched lines for an account.
   *
   * Amount search strips commas, so "150,000" and "150000" behave the same.
   */
  async searchUnmatched({ bankAccountId, q, limit = 50 }) {
    const term = String(q || "").trim();
    // Amount search ignores thousands separators, so "150,000" finds 150000.
    const numeric = term.replace(/,/g, "");
    const amount = numeric !== "" && !Number.isNaN(Number(numeric)) ? Number(numeric) : null;
    const like = term ? `%${term}%` : null;

    return client`
      SELECT * FROM bank_statement_lines
      WHERE bank_account_id = ${bankAccountId}
        AND status = 'UNMATCHED'
        AND (
          ${like}::text IS NULL
          OR depositor ILIKE ${like}::text
          OR bank_ref  ILIKE ${like}::text
          OR narration ILIKE ${like}::text
          OR (${amount}::numeric IS NOT NULL AND amount = ${amount}::numeric)
        )
      ORDER BY txn_date DESC
      LIMIT ${Math.min(Number(limit) || 50, 200)}
    `;
  },

  /**
   * Claims lines for a payment.
   *
   * The UPDATE filters on status = 'UNMATCHED', so two concurrent
   * confirmations can never claim the same deposit — the loser updates zero
   * rows and the caller sees a short count.
   */
  async markMatched({ lineIds, orderId, depositId, staffId }) {
    if (!Array.isArray(lineIds) || !lineIds.length) return { matched: 0 };
    const rows = await client`
      UPDATE bank_statement_lines
         SET status = 'MATCHED',
             matched_order_id = ${orderId ?? null},
             matched_deposit_id = ${depositId ?? null},
             matched_by = ${staffId ?? null},
             matched_at = now()
       WHERE id = ANY(${lineIds}::int[])
         AND status = 'UNMATCHED'
      RETURNING id
    `;
    return { matched: rows.length, ids: rows.map((r) => r.id) };
  },
};

module.exports = bankStatementRepo;
