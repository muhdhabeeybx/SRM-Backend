const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { enforceRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const s = require("../../schemas/accounts.schema");
const c = require("../../controllers/administration/accounts.controller");

/**
 * /api/accounts — the books. Reading them is open to signed-in staff like the
 * rest of the dashboard; every change is gated where it is made.
 */
const FINANCE = enforceRole("finance", "audit", "admin", {
  message: "Only finance, audit or an admin can post to the books",
});

router.get("/chart", verifyStaff, c.getChart);
router.get("/status", verifyStaff, c.getStatus);
router.get("/dimensions", verifyStaff, c.getDimensions);
router.get("/trial-balance", verifyStaff, validate({ query: s.periodQuery }), c.getTrialBalance);
router.get("/ledger/:accountId", verifyStaff, validate({ params: s.accountParam, query: s.ledgerQuery }), c.getAccountLedger);
router.get("/journals", verifyStaff, validate({ query: s.journalsQuery }), c.getJournals);
router.post("/journals", verifyStaff, FINANCE, validate({ body: s.journalBody }), c.writeJournal);
// Written by one person, approved and posted by another.
router.get("/journal-drafts", verifyStaff, validate({ query: s.draftsQuery }), c.getJournalDrafts);
router.post("/journal-drafts/:draftId/approve", verifyStaff, FINANCE, validate({ params: s.draftParam }), c.approveJournal);
router.post("/journal-drafts/:draftId/reject", verifyStaff, FINANCE, validate({ params: s.draftParam, body: s.rejectBody }), c.rejectJournal);
router.post("/journals/:entryId/reverse", verifyStaff, FINANCE, validate({ params: s.entryParam, body: s.reverseBody }), c.reverseJournal);
router.get("/profit-and-loss", verifyStaff, validate({ query: s.profitQuery }), c.getProfitAndLoss);
router.get("/balance-sheet", verifyStaff, validate({ query: s.atQuery }), c.getBalanceSheet);
router.get("/cash-flow", verifyStaff, validate({ query: s.periodQuery }), c.getCashFlow);
router.post("/post-now", verifyStaff, FINANCE, c.postNow);

router.get("/ageing", verifyStaff, validate({ query: s.ageingQuery }), c.getAgeing);
router.get("/readiness", verifyStaff, c.getReadiness);
router.get("/banks", verifyStaff, validate({ query: s.periodQuery }), c.getBanks);
router.get("/reconciliation", verifyStaff, validate({ query: s.reconciliationQuery }), c.getReconciliation);
router.post("/bank-lines/:direction/:lineId/classify", verifyStaff, FINANCE, validate({ params: s.lineParam, body: s.classifyBody }), c.classifyLine);
router.delete("/bank-lines/:direction/:lineId/classify", verifyStaff, FINANCE, validate({ params: s.lineParam }), c.unclassifyLine);

router.get("/opening-balances", verifyStaff, c.getOpening);
router.post("/opening-balances", verifyStaff, FINANCE, validate({ body: s.openingBody }), c.postOpening);

router.get("/periods", verifyStaff, c.getPeriods);
router.post("/periods/:period/close", verifyStaff, FINANCE, validate({ params: s.periodParam }), c.closePeriod);
// Reopening a month changes what was read from it: a super admin's act.
router.post(
  "/periods/:period/reopen",
  verifyStaff,
  enforceRole({ message: "Only a super admin can reopen a closed month" }),
  validate({ params: s.periodParam }),
  c.reopenPeriod
);

module.exports = router;
