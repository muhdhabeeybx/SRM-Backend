const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/accounts.schema");
const c = require("../../controllers/administration/accounts.controller");
const { requireAccountsAccess } = require("../../middleware/accountsAccess");

/**
 * /api/accounts — the books. The admins' for now, reading included, and
 * anyone else by a page grant (middleware/accountsAccess.js); every change is
 * gated again where it is made.
 */
router.use(verifyStaff, requireAccountsAccess);

const FINANCE = enforceRole("finance", "audit", "admin", {
  message: "Only finance, audit or an admin can post to the books",
});

router.get("/report", validate({ query: s.reportQuery }), c.getReport);
router.get("/chart", c.getChart);
router.get("/status", c.getStatus);
router.get("/dimensions", c.getDimensions);
router.get("/trial-balance", validate({ query: s.periodQuery }), c.getTrialBalance);
router.get("/ledger/:accountId", validate({ params: s.accountParam, query: s.ledgerQuery }), c.getAccountLedger);
router.get("/journals", validate({ query: s.journalsQuery }), c.getJournals);
router.post("/journals", FINANCE, validate({ body: s.journalBody }), c.writeJournal);
// Written by one person, approved and posted by another.
router.get("/journal-drafts", validate({ query: s.draftsQuery }), c.getJournalDrafts);
router.post("/journal-drafts/:draftId/approve", FINANCE, validate({ params: s.draftParam }), c.approveJournal);
router.post("/journal-drafts/:draftId/reject", FINANCE, validate({ params: s.draftParam, body: s.rejectBody }), c.rejectJournal);
router.post("/journals/:entryId/reverse", FINANCE, validate({ params: s.entryParam, body: s.reverseBody }), c.reverseJournal);
router.get("/profit-and-loss", validate({ query: s.profitQuery }), c.getProfitAndLoss);
router.get("/balance-sheet", validate({ query: s.atQuery }), c.getBalanceSheet);
router.get("/cash-flow", validate({ query: s.periodQuery }), c.getCashFlow);
router.post("/post-now", FINANCE, c.postNow);

router.get("/ageing", validate({ query: s.ageingQuery }), c.getAgeing);
router.get("/readiness", c.getReadiness);
router.get("/banks", validate({ query: s.periodQuery }), c.getBanks);
router.get("/reconciliation", validate({ query: s.reconciliationQuery }), c.getReconciliation);
router.post("/bank-lines/:direction/:lineId/classify", FINANCE, validate({ params: s.lineParam, body: s.classifyBody }), c.classifyLine);
router.delete("/bank-lines/:direction/:lineId/classify", FINANCE, validate({ params: s.lineParam }), c.unclassifyLine);

// What the company owns and keeps, and what it has borrowed (0088).
router.get("/fixed-assets", c.getFixedAssets);
router.post("/fixed-assets", FINANCE, validate({ body: s.assetBody }), c.createFixedAsset);
router.patch("/fixed-assets/:assetId", FINANCE, validate({ params: s.assetParam, body: s.assetBody }), c.updateFixedAsset);
router.delete("/fixed-assets/:assetId", FINANCE, validate({ params: s.assetParam }), c.deleteFixedAsset);
router.post("/fixed-assets/:assetId/dispose", FINANCE, validate({ params: s.assetParam, body: s.disposeBody }), c.disposeFixedAsset);
router.delete("/fixed-assets/:assetId/dispose", FINANCE, validate({ params: s.assetParam }), c.undisposeFixedAsset);
router.get("/loans", c.getLoans);
router.post("/loans", FINANCE, validate({ body: s.loanBody }), c.createLoan);
router.patch("/loans/:loanId", FINANCE, validate({ params: s.loanParam, body: s.loanBody }), c.updateLoan);
router.delete("/loans/:loanId", FINANCE, validate({ params: s.loanParam }), c.deleteLoan);
router.post("/loans/:loanId/repayments", FINANCE, validate({ params: s.loanParam, body: s.repaymentBody }), c.addLoanRepayment);
router.delete("/loans/:loanId/repayments/:repaymentId", FINANCE, validate({ params: s.repaymentParam }), c.deleteLoanRepayment);

router.get("/opening-balances", c.getOpening);
router.post("/opening-balances", FINANCE, validate({ body: s.openingBody }), c.postOpening);

router.get("/periods", c.getPeriods);
router.post("/periods/:period/close", FINANCE, validate({ params: s.periodParam }), c.closePeriod);
// Reopening a month changes what was read from it: a super admin's act.
router.post(
  "/periods/:period/reopen",
  enforceRole({ message: "Only a super admin can reopen a closed month" }),
  validate({ params: s.periodParam }),
  c.reopenPeriod
);

module.exports = router;
