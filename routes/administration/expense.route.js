const express = require("express");
const router = express.Router();
const { authenticateStaff } = require("../../middleware/verifyStaff");
const { requireExpenseRole, requireChartRole } = require("../../middleware/expenseAccess");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  autoPopulateCategories,
  listExpenses,
  taxReport,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpense,
  reviewExpense,
  listAttachments,
  addAttachments,
  deleteAttachment,
  listComments,
  addComment,
  attachmentSignature,
} = require("../../controllers/administration/expense.controller");

// --- categories -----------------------------------------------------------
// Before the "/:id" expense routes so "categories" is not read as an id.
router.get("/categories", authenticateStaff, listCategories);
router.post("/categories", authenticateStaff, requireChartRole, validate({ body: misc.createCategory }), createCategory);
router.post("/categories/auto-populate", authenticateStaff, requireChartRole, autoPopulateCategories);
router.patch("/categories/:id", authenticateStaff, requireChartRole, validate({ params: misc.idParam, body: misc.updateCategory }), updateCategory);
router.delete("/categories/:id", authenticateStaff, requireChartRole, validate({ params: misc.idParam }), deleteCategory);

// --- expenses -------------------------------------------------------------
router.get("/", authenticateStaff, listExpenses);
// VAT and WHT for a period. Before "/:id" so "tax-report" is not read as an id.
router.get("/tax-report", authenticateStaff, taxReport);
router.get("/:id", authenticateStaff, validate({ params: misc.idParam }), getExpense);
// The only path by which status moves.
// Before "/:id/attachments" so "upload-signature" is not read as an expense id.
router.get("/attachments/signature", authenticateStaff, attachmentSignature);
router.get("/:id/attachments", authenticateStaff, validate({ params: misc.idParam }), listAttachments);
router.post("/:id/attachments", authenticateStaff, validate({ params: misc.idParam }), addAttachments);
router.delete("/attachments/:id", authenticateStaff, validate({ params: misc.idParam }), deleteAttachment);
router.post("/:id/review", authenticateStaff, requireExpenseRole, validate({ params: misc.idParam }), reviewExpense);
// Not behind requireExpenseRole: the person who raised the request has to be
// able to answer a reviewer's query. The controller checks they are on it.
router.get("/:id/comments", authenticateStaff, validate({ params: misc.idParam }), listComments);
router.post("/:id/comments", authenticateStaff, validate({ params: misc.idParam }), addComment);
router.post("/", authenticateStaff, validate({ body: misc.createExpense }), createExpense);
router.patch("/:id", authenticateStaff, validate({ params: misc.idParam }), updateExpense);
router.delete("/:id", authenticateStaff, validate({ params: misc.idParam }), deleteExpense);

module.exports = router;
