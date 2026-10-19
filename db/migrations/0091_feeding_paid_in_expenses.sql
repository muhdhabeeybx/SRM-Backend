-- A truck's feeding can be marked as already paid through Expenses.
--
-- Written by hand in the style of 0002-0090. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Drivers' feeding is often raised and paid as an expense on the PFI ("₦50,000
-- by 25 trucks drivers feeding allowance"), and then typed again per truck in
-- Delivery Costing. Both reached the batch's landing cost, so the same naira
-- was counted twice. With this set, the truck keeps its feeding figure for the
-- record, but lib/tripCosts.js leaves it out of the truck's trip expenses, cost
-- per litre and landing cost — the paid expense already carries it.
--
--   feeding_in_expenses   true = feeding paid through Expenses, not added here
--
-- Nothing existing changes: every truck today stays false, so its feeding is
-- still added exactly as before until somebody ticks it.

ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS feeding_in_expenses boolean NOT NULL DEFAULT false;
