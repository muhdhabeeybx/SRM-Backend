const repo = require("../../repositories/bankStatement.repository");
const { generateOrderReference } = require("../../utils/helpers");

const ok = (res, data, message) => res.json({ success: true, message, data });
const fail = (res, code, message) => res.status(code).json({ success: false, message });

/** GET /api/bank-statements/mapping/:bankAccountId */
async function getMapping(req, res) {
  const mapping = await repo.getMapping(Number(req.params.bankAccountId));
  return ok(res, { mapping });
}

/** PUT /api/bank-statements/mapping/:bankAccountId */
async function saveMapping(req, res) {
  const bankAccountId = Number(req.params.bankAccountId);
  const { dateColumn, amountColumn, creditColumn } = req.body || {};

  if (dateColumn === undefined || dateColumn === null) {
    return fail(res, 400, "A date column is required");
  }
  // One of the two amount strategies must be chosen.
  if ((amountColumn === undefined || amountColumn === null) &&
      (creditColumn === undefined || creditColumn === null)) {
    return fail(res, 400, "Choose either an amount column or a credit column");
  }

  const mapping = await repo.upsertMapping(bankAccountId, req.body);
  return ok(res, { mapping }, "Statement format saved");
}

/**
 * POST /api/bank-statements
 *
 * The client parses the workbook (it already ships a spreadsheet reader) and
 * posts structured rows plus each original row for traceability. Dedup and the
 * uniqueness guarantee stay here, on the database, where they belong.
 */
async function uploadStatement(req, res) {
  const { bankAccountId, filename, rows } = req.body || {};
  if (!bankAccountId) return fail(res, 400, "bankAccountId is required");

  const mapping = await repo.getMapping(Number(bankAccountId));
  if (!mapping) {
    return fail(res, 409, "Set up this account's statement format before uploading");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return fail(res, 400, "No usable credit rows were found in that statement");
  }

  const result = await repo.ingest({
    bankAccountId: Number(bankAccountId),
    filename,
    uploadedBy: req.staff?.id ?? null,
    rows,
  });

  /**
   * A row skipped because its transaction id is already on the account is
   * worth saying out loud, separately from an identical row.
   *
   * It means this file dates a credit differently from the file that brought
   * it in — a .csv export and an .xlsx of the same account disagreeing by a
   * day — and the desk is otherwise left to wonder why a row it can see in the
   * statement did not arrive. Silence is what made the old rule dangerous.
   */
  const repeats = result.repeatedTransactions
    ? `, ${result.repeatedTransactions} already on record under a different date`
    : "";

  if (result.added === 0) {
    return fail(
      res,
      409,
      `Every row in that file is already on record (${result.duplicates} duplicates${repeats})`,
    );
  }

  return ok(
    res,
    result,
    `${result.added} new row${result.added === 1 ? "" : "s"} added, ${result.duplicates} duplicate${result.duplicates === 1 ? "" : "s"} skipped${repeats}`,
  );
}

/** GET /api/bank-statements?bankAccountId= */
async function listStatements(req, res) {
  const { bankAccountId } = req.query;
  const statements = await repo.listStatements(bankAccountId ? Number(bankAccountId) : null);
  return ok(res, { statements });
}

/**
 * GET /api/bank-statements/:id/lines?page=&limit=&status=
 *
 * Every row of one upload with what became of it — which order took it and
 * who matched it. The order reference is built the way the rest of the app
 * builds it, so a reference read here finds the order it names.
 */
async function statementLines(req, res) {
  const { page, limit, status } = req.query;
  const result = await repo.listStatementLines({
    statementId: Number(req.params.id),
    page: page ? Number(page) : 1,
    limit: limit ? Math.min(Number(limit), 200) : 25,
    status: status || null,
  });

  return ok(res, {
    ...result,
    lines: result.lines.map((l) => ({
      ...l,
      order_reference:
        l.order_id != null ? generateOrderReference(l.order_company, l.order_id) : null,
      matched_by_name: l.matched_by_first_name
        ? `${l.matched_by_first_name} ${l.matched_by_surname || ""}`.trim()
        : null,
    })),
  });
}

/** DELETE /api/bank-statements/:id */
async function deleteStatement(req, res) {
  const result = await repo.deleteStatement(Number(req.params.id));
  if (!result.deleted) {
    return fail(
      res,
      409,
      `Cannot delete: ${result.matched} line${result.matched === 1 ? " is" : "s are"} already matched to a payment`,
    );
  }
  return ok(res, result, "Statement deleted");
}

/** GET /api/bank-statements/lines?bankAccountId=&q= */
async function searchLines(req, res) {
  const { bankAccountId, q, limit } = req.query;
  if (!bankAccountId) return fail(res, 400, "bankAccountId is required");
  const lines = await repo.searchUnmatched({
    bankAccountId: Number(bankAccountId),
    q,
    limit,
  });
  return ok(res, { lines });
}

/** POST /api/bank-statements/match */
async function matchLines(req, res) {
  const { lineIds, orderId, depositId } = req.body || {};
  const result = await repo.markMatched({
    lineIds,
    orderId,
    depositId,
    staffId: req.staff?.id ?? null,
  });
  return ok(res, result, `${result.matched} line${result.matched === 1 ? "" : "s"} matched`);
}

module.exports = {
  getMapping,
  saveMapping,
  uploadStatement,
  listStatements,
  statementLines,
  deleteStatement,
  searchLines,
  matchLines,
};
