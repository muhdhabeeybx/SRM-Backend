-- A truck's loading money, entered in Delivery Costing and raised as a
-- payment request — the way its feeding is (0095).
--
-- Written by hand in the style of 0002-0098. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The desk raised truck loading by hand under Other PFI Operational Expenses
-- ("loading expenses of 6 trucks, 90,000 × 6", EXP-652). Now it is entered on
-- the trucks and raised from there, one Truck Loading request per batch on the
-- trucks' PFI (services/loadingRequests.service.js). Until that request is
-- paid the loading counts on the truck; once paid, the PFI's paid expenses
-- carry it and the truck adds nothing (lib/tripCosts.js) — counted once.
--
--   delivery_inventory.loading_cost               the loading money, naira
--   delivery_inventory.loading_cost_in_expenses   already in Expenses some other way: not raised, not added
--   delivery_inventory.loading_cost_expense_id    the request carrying it, or null
--
-- Named loading_cost, not loading_*: loading_status is the truck's loading stage.
--
-- Truck Loading is its own account in the chart (the user, 2026-10-27), beside
-- Feeding under PFI Operational Expenses. 5435 keeps the subgroup's codes in
-- one contiguous run, which is how its heading is read.
--
-- Nothing existing changes: every trip today has no loading cost, so it is
-- costed exactly as before.

ALTER TABLE delivery_inventory
  ADD COLUMN IF NOT EXISTS loading_cost numeric(14, 2),
  ADD COLUMN IF NOT EXISTS loading_cost_in_expenses boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loading_cost_expense_id integer REFERENCES pfi_expenses(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_inventory_loading_cost_check') THEN
    ALTER TABLE delivery_inventory
      ADD CONSTRAINT delivery_inventory_loading_cost_check CHECK (loading_cost IS NULL OR loading_cost >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS delivery_inventory_loading_cost_expense_idx
  ON delivery_inventory (loading_cost_expense_id) WHERE loading_cost_expense_id IS NOT NULL;

INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, is_system_category, is_active)
SELECT 'Truck Loading', '5435', 'pfi_direct', 'PFI Operational Expenses', false, true
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.gl_code = '5435');
