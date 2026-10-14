const asyncHandler = require("express-async-handler");
const { listChart } = require("../../lib/accounting/chart");
const gl = require("../../lib/glAccounts");
const { lagosToday } = require("../../lib/zonedDay");
const reports = require("../../services/accounting/reports.service");
const posting = require("../../services/accounting/posting.service");
const opening = require("../../services/accounting/opening.service");
const recon = require("../../services/accounting/reconciliation.service");
const journalsSvc = require("../../services/accounting/journals.service");
const ageingSvc = require("../../services/accounting/ageing.service");
const readinessSvc = require("../../services/accounting/readiness.service");

/**
 * The Accounts pages: the chart of accounts and the general ledger built on
 * it (services/accounting).
 *
 * Changing an account goes through the chart's own endpoints
 * (/api/expenses/categories), which the expense form's editor already used —
 * one set of rules for the chart, whichever page edits it.
 */

/** Every account, grouped the way the Chart of Accounts page lists them, with today's balance. */
const getChart = asyncHandler(async (req, res) => {
  const accounts = await listChart();
  // Before migration 0082 there is no ledger to read: the chart still lists.
  const balances = await reports.balancesAt(lagosToday()).catch(() => null);
  res.json({
    success: true,
    data: {
      groups: gl.CHART_GROUPS.map((g) => ({
        code: g.code,
        label: g.label,
        type: g.type,
        /** Only these two are booked to by the expense form. */
        onExpenseForm: !!gl.groupFor(g.code),
      })),
      accounts: accounts.map((a) => ({ ...a, balance: balances ? balances.get(a.id) ?? 0 : null })),
      ledgerReady: balances !== null,
    },
  });
});

/** The part of the business a report is narrowed to, from the query (schemas/accounts dims). */
const dimsOf = (q) => ({ pfiIds: (q.pfi || []).map(Number), units: q.unit || [], locations: q.location || [] });

const getDimensions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.dimensions() });
});

const getStatus = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.status() });
});

const getTrialBalance = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.trialBalance({ from: req.query.from, to: req.query.to, dims: dimsOf(req.query) }) });
});

const getAccountLedger = asyncHandler(async (req, res) => {
  const data = await reports.accountLedger(req.params.accountId, {
    from: req.query.from, to: req.query.to, partyType: req.query.partyType, partyId: req.query.partyId, dims: dimsOf(req.query),
  });
  res.json({ success: true, data });
});

const getJournals = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.journals({ ...req.query, dims: dimsOf(req.query) }) });
});

const getProfitAndLoss = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.profitAndLoss({ from: req.query.from, to: req.query.to, by: req.query.by, dims: dimsOf(req.query) }) });
});

const getBalanceSheet = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.balanceSheet({ at: req.query.at || lagosToday(), dims: dimsOf(req.query) }) });
});

const getCashFlow = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.cashFlow({ from: req.query.from, to: req.query.to, dims: dimsOf(req.query) }) });
});

/** A refusal the service raised (status set) answers with its message; anything else is a 500. */
const answer = (res, err) => {
  if (!err.status) throw err;
  return res.status(err.status).json({ success: false, message: err.message });
};

const getOpening = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await opening.proposal() });
});

const postOpening = asyncHandler(async (req, res) => {
  try {
    const data = await opening.post({ amounts: req.body.amounts, staffId: req.user?.id ?? null });
    res.json({ success: true, message: "Opening balances posted", data });
  } catch (err) {
    answer(res, err);
  }
});

const getPeriods = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { periods: await opening.periods(lagosToday()) } });
});

const closePeriod = asyncHandler(async (req, res) => {
  try {
    const periods = await opening.close(req.params.period, { today: lagosToday(), staffId: req.user?.id ?? null });
    res.json({ success: true, message: `${req.params.period} closed`, data: { periods } });
  } catch (err) {
    answer(res, err);
  }
});

const reopenPeriod = asyncHandler(async (req, res) => {
  try {
    const periods = await opening.reopen(req.params.period, { today: lagosToday(), staffId: req.user?.id ?? null });
    res.json({ success: true, message: `${req.params.period} reopened`, data: { periods } });
  } catch (err) {
    answer(res, err);
  }
});

const getReconciliation = asyncHandler(async (req, res) => {
  try {
    res.json({ success: true, data: await recon.reconciliation(req.query) });
  } catch (err) {
    answer(res, err);
  }
});

const classifyLine = asyncHandler(async (req, res) => {
  try {
    const data = await recon.classify({ ...req.params, ...req.body, staffId: req.user?.id ?? null });
    res.json({ success: true, message: `Named to ${data.account}`, data });
  } catch (err) {
    answer(res, err);
  }
});

const unclassifyLine = asyncHandler(async (req, res) => {
  res.json({ success: true, message: "Left to explain", data: await recon.unclassify({ ...req.params, staffId: req.user?.id ?? null }) });
});

/** Every bank account at a glance — the Banks page's first table. */
const getBanks = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await recon.banks({ from: req.query.from || null, to: req.query.to || null }) });
});

const writeJournal = asyncHandler(async (req, res) => {
  try {
    const data = await journalsSvc.write({ ...req.body, staffId: req.user?.id ?? null });
    res.status(201).json({ success: true, message: "Journal written — it posts once somebody else approves it", data });
  } catch (err) {
    answer(res, err);
  }
});

/** What the books still need from people — see the service. */
const getReadiness = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await readinessSvc.readiness() });
});

const getAgeing = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await ageingSvc.ageing({ side: req.query.side || "receivables", at: req.query.at || lagosToday() }) });
});

const getJournalDrafts = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { drafts: await journalsSvc.drafts({ status: req.query.status ?? "waiting" }) } });
});

const approveJournal = asyncHandler(async (req, res) => {
  try {
    const data = await journalsSvc.approve({ draftId: req.params.draftId, staffId: req.user?.id ?? null });
    res.json({ success: true, message: "Journal approved and posted", data });
  } catch (err) {
    answer(res, err);
  }
});

const rejectJournal = asyncHandler(async (req, res) => {
  try {
    const data = await journalsSvc.reject({ draftId: req.params.draftId, reason: req.body.reason, staffId: req.user?.id ?? null });
    res.json({ success: true, message: "Journal rejected", data });
  } catch (err) {
    answer(res, err);
  }
});

const reverseJournal = asyncHandler(async (req, res) => {
  try {
    const data = await journalsSvc.reverse({ entryId: req.params.entryId, day: req.body.day, staffId: req.user?.id ?? null });
    res.json({ success: true, message: "Journal reversed", data });
  } catch (err) {
    answer(res, err);
  }
});

/** Bring the books up to date now, rather than at the next ten-minute run. */
/**
 * Bring the books up to date now.
 *
 * Waited on for a while, then left to finish on its own: the first run reads
 * every record since June — thousands, each booked in its own batch — and an
 * answer held longer than the proxy in front of the API allows would read as a
 * failure while the run went on regardless. The pages say when the books were
 * last brought up to date, so they show it finishing.
 */
const WAIT_FOR_RUN_MS = 25_000;
const postNow = asyncHandler(async (req, res) => {
  const running = posting.run();
  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ stillRunning: true }), WAIT_FOR_RUN_MS)),
  ]);
  if (result.stillRunning) {
    running.catch((err) => console.error("[accounts] posting run failed:", err));
    return res.status(202).json({
      success: true,
      message: "Still bringing the books up to date — this can take a few minutes. The pages fill in as it goes.",
    });
  }
  if (result.busy) {
    return res.status(409).json({ success: false, message: "The books are being brought up to date already — try again in a minute" });
  }
  res.json({ success: true, message: "The books are up to date", data: result });
});

module.exports = {
  getChart, getDimensions, getStatus, getTrialBalance, getAccountLedger, getJournals, getProfitAndLoss, getBalanceSheet, getCashFlow,
  getOpening, postOpening, getPeriods, closePeriod, reopenPeriod, postNow,
  getReconciliation, classifyLine, unclassifyLine, writeJournal, reverseJournal, getJournalDrafts, approveJournal, rejectJournal, getAgeing, getReadiness, getBanks,
};
