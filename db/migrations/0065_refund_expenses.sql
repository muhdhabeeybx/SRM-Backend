-- An overpayment refund is paid through the expense chain.
--
-- Written by hand in the style of 0002-0064. Idempotent.
--
-- ── What changes ───────────────────────────────────────────────────────────
--
-- Requesting a refund now raises an expense for it, linked here by
-- order_refunds.expense_id. The expense starts at "With CFO" — refunds skip the
-- Expenditure Officer's verification — and from there walks the ordinary
-- chain: CFO approval, final approval, and the Expenditure Officer marking it
-- paid. Marking it paid is what records the refund on the order (the negative
-- order_payments row), so the finance report shows it refunded and the balance
-- goes to 0. Rejecting the expense cancels the refund; cancelling the refund
-- withdraws the expense. services/orderRefund.service.js keeps the two in step.
--
-- ── Why a refund is kept out of every cost ─────────────────────────────────
--
-- A refund returns a customer's own money; it is not something the business
-- spent. Booked as an ordinary expense it would count as overhead in the daily
-- report, and against a PFI it would raise the landing cost and cut the profit
-- by the refund. So:
--
--   * refund expenses carry no pfi_id — every PFI cost reads only expenses
--     booked to that PFI, so none of them can ever see one;
--   * their category is flagged is_refund, and the expense totals and the
--     daily report's overhead leave anything in it out.

ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS is_refund boolean NOT NULL DEFAULT false;

-- The one category refunds are raised under. A system category, so it cannot
-- be renamed or deleted by hand.
INSERT INTO expense_categories (name, gl_group, gl_subgroup, is_system_category, is_refund)
SELECT 'Customer Refund', 'general', 'Customer Refunds', true, true
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE is_refund);

ALTER TABLE order_refunds
  ADD COLUMN IF NOT EXISTS expense_id integer REFERENCES pfi_expenses(id) ON DELETE SET NULL;

-- One expense pays one refund.
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_expense_uq
  ON order_refunds (expense_id) WHERE expense_id IS NOT NULL;
