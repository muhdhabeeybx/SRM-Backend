const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
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
} = require("../../controllers/administration/bankStatement.controller");

// The matching pool, queried while confirming a payment.
router.get("/lines", verifyStaff, searchLines);
router.post("/match", verifyStaff, validate({ body: misc.matchBankLines }), matchLines);

// Per-bank rollups and the per-day read. Declared above the "/:id" family so
// a literal segment is never a candidate for the id parameter.
router.get("/summary", verifyStaff, accountSummary);
router.get("/accounts/:bankAccountId/days", verifyStaff, accountDays);
router.get("/accounts/:bankAccountId/lines", verifyStaff, accountLines);

// Per-account statement format.
router.get("/mapping/:bankAccountId", verifyStaff, getMapping);
router.put("/mapping/:bankAccountId", verifyStaff, validate({ body: misc.bankStatementMapping }), saveMapping);

// Statements themselves.
router.get("/", verifyStaff, listStatements);
router.post("/", verifyStaff, validate({ body: misc.createBankStatement }), uploadStatement);
// The same body as the upload, answered rather than applied.
router.post("/preview", verifyStaff, validate({ body: misc.createBankStatement }), previewStatement);
router.get("/:id/lines", verifyStaff, statementLines);
router.delete("/:id", verifyStaff, deleteStatement);

module.exports = router;
