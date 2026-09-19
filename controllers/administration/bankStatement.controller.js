const repo = require("../../repositories/bankStatement.repository");
const { generateOrderReference } = require("../../utils/helpers");

const ok = (res, data, message) => res.json({ success: true, message, data });
const fail = (res, code, message) => res.status(code).json({ success: false, message });

/**
 * A calendar day from a query string, or null.
 *
 * Only YYYY-MM-DD gets through. Anything else becomes null rather than being
 * coerced, because a filter that silently reads as "no filter" is better than
 * one that reads as some other day — and these bind straight into ::date.
 */
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);

/**
 * The two derived fields every line view needs.
 *
 * The order reference is assembled the way every other screen builds it, so a
 * reference read off this page is the one to search for elsewhere; the matcher
 * is a name rather than a staff id.
 */
const decorateLine = (l) => ({
  ...l,
  order_reference:
    l.order_id != null ? generateOrderReference(l.order_company, l.order_id) : null,
  matched_by_name: l.matched_by_first_name
    ? `${l.matched_by_first_name} ${l.matched_by_surname || ""}`.trim()
    : null,
  /**
   * What claimed this credit, when it was not an order.
   *
   * A truck sale spends a statement line the same way an order does, and
   * without this a line it had claimed would read as MATCHED against nothing
   * — which on a reconciliation screen is indistinguishable from a fault.
   */
  claimed_by: l.delivery_sale_id
    ? {
        kind: "truck_sale",
        id: l.delivery_sale_id,
        label: [l.truck_number, l.truck_customer].filter(Boolean).join(" · "),
      }
    : null,
});

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
    /**
     * req.user, not req.staff. verifyStaff has never set req.staff.
     *
     * The middleware populates `req.user` — see its own note about preserving
     * "the shape of the previous decoded.UserInfo payload so the 16 route
     * files keep working unchanged". This controller was the one that did not,
     * and `req.staff?.id ?? null` cannot throw, so it recorded null forever
     * and said nothing. Every one of September's 160 uploads has no uploader
     * against it, and 85 of August's; July's 165 all do, which dates the
     * break to that rewrite.
     *
     * The rows already written cannot be attributed after the fact.
     */
    uploadedBy: req.user?.id ?? null,
    rows,
  });

  /**
   * A row skipped because its REFERENCE is already on the account is worth
   * saying out loud, separately from a row that matched in every field.
   *
   * It means this file describes a credit differently from the file that
   * brought it in — a different date, a reworded narration — and the desk is
   * otherwise left to wonder why a row it can see in the statement did not
   * arrive. Silence about dropped rows is what made this rule dangerous the
   * last time it was in force; on an account whose reference column is
   * mis-mapped onto the narration, this line is the symptom to read.
   */
  const repeats = result.repeatedReferences
    ? `, ${result.repeatedReferences} already on record under the same reference`
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

/**
 * POST /api/bank-statements/preview
 *
 * What the upload would do, before it does it. Same body as the upload and the
 * same dedup rule, run and returned rather than applied — so the rows offered
 * for confirmation are the rows that will actually be stored.
 *
 * Nothing is written and nothing is held. A file confirmed a minute later is
 * partitioned again on the way in, and anything that arrived in between is
 * caught there by the unique index exactly as it would have been anyway.
 */
async function previewStatement(req, res) {
  const { bankAccountId, rows } = req.body || {};
  if (!bankAccountId) return fail(res, 400, "bankAccountId is required");

  const mapping = await repo.getMapping(Number(bankAccountId));
  if (!mapping) {
    return fail(res, 409, "Set up this account's statement format before uploading");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return fail(res, 400, "No usable credit rows were found in that statement");
  }

  const result = await repo.previewIngest({
    bankAccountId: Number(bankAccountId),
    rows,
  });

  // dedup keys are an implementation detail of the rule, not something a
  // screen has any use for — and they are what makes the payload large.
  const strip = ({ dedup, rawRow, ...rest }) => rest;

  return ok(res, {
    rows: result.fresh.map(strip),
    skipped: result.skipped.map(strip),
    counts: {
      incoming: rows.length,
      importing: result.fresh.length,
      duplicates: result.duplicates,
      repeatedReferences: result.repeatedReferences,
    },
    total: result.fresh.reduce((sum, r) => sum + Number(r.amount || 0), 0),
  });
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

  return ok(res, { ...result, lines: result.lines.map(decorateLine) });
}

/**
 * GET /api/bank-statements/summary
 *
 * Every bank account with what has been uploaded against it. Accounts with no
 * uploads are included deliberately — that is where a first upload starts, and
 * an account with no format set up is the one somebody is looking for.
 */
async function accountSummary(req, res) {
  const accounts = await repo.accountSummaries();
  return ok(res, { accounts });
}

/**
 * GET /api/bank-statements/accounts/:bankAccountId/days?from=&to=
 *
 * One account's statement grouped by the day the bank printed, which is the
 * unit it is actually read in.
 */
async function accountDays(req, res) {
  const { from, to } = req.query;
  const days = await repo.accountDays({
    bankAccountId: Number(req.params.bankAccountId),
    from: day(from),
    to: day(to),
  });
  return ok(res, { days });
}

/**
 * GET /api/bank-statements/accounts/:bankAccountId/lines
 *   ?from=&to=&day=&status=&q=&page=&limit=
 *
 * Every line on the account in a range, each carrying where it came from and
 * where it went. This is also what the export reads.
 */
async function accountLines(req, res) {
  const { from, to, day: onDay, status, q, page, limit } = req.query;
  const result = await repo.accountLines({
    bankAccountId: Number(req.params.bankAccountId),
    from: day(from),
    to: day(to),
    day: day(onDay),
    status: status || null,
    q: q || null,
    page: page ? Number(page) : 1,
    limit: limit ? Number(limit) : 50,
  });

  return ok(res, { ...result, lines: result.lines.map(decorateLine) });
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
    // Same bug, same fix. This path happens to be unused — matched_by is 100%
    // populated because confirming a payment claims the lines instead — but a
    // dormant call that silently records nobody is worth correcting now
    // rather than discovering later.
    staffId: req.user?.id ?? null,
  });
  return ok(res, result, `${result.matched} line${result.matched === 1 ? "" : "s"} matched`);
}

module.exports = {
  getMapping,
  saveMapping,
  uploadStatement,
  previewStatement,
  listStatements,
  statementLines,
  accountSummary,
  accountDays,
  accountLines,
  deleteStatement,
  searchLines,
  matchLines,
};
