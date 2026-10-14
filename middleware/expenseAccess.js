const chain = require("../lib/expenseChain");
const { enforceRole } = require("./verifyStaff");

/**
 * Gate for the review endpoint.
 *
 * The app-wide `verifyStaff` admits only admin and super_admin, which would
 * shut the Expenditure Officer and the CFO out of the queue they exist to
 * work — so the expense routes authenticate first and authorise here instead.
 *
 * This only asks "could you ever review anything?". Whether you may perform
 * *this* action on *this* request at *this* stage is the chain's decision, and
 * it stays there so there is one source of truth for the rules.
 */
function requireExpenseRole(req, res, next) {
  /**
   * OPEN: anyone signed in may work the review queue.
   *
   * This gate only ever asked "could you ever review anything?" — it is the
   * door to the queue, not the rule about a particular expense at a particular
   * stage. That rule is the chain's, and the chain is DELIBERATELY LEFT INTACT:
   * an expense still has to move pending → approved → paid in order, so it
   * cannot be raised and paid in a single step by one person.
   *
   * So what opening this changes is who may take part. What it does not change
   * is that each stage is still a separate, recorded act. See
   * config/apiPermissions.checkApiAccess for the wider decision.
   */
  void chain;
  next();
}

/**
 * Gate for editing the chart of accounts — enforced (2026-10-13).
 *
 * It was open, like the review queue. Since 0081 the chart is the general
 * ledger's too: its banks, payables and sales accounts are what the books post
 * to, so it is Finance's to reshape. An Expenditure Officer still posts to it
 * all day. One of the approved exceptions to open access; soromanfe
 * lib/serverGates.ts `manageChart` hides the buttons to match.
 */
const requireChartRole = enforceRole("finance", "audit", "admin", {
  message: "Only finance, audit or an admin can change the chart of accounts",
});

module.exports = { requireExpenseRole, requireChartRole };
