-- A truck's feeding, raised as a payment request from Delivery Costing.
--
-- Written by hand in the style of 0002-0094. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Feeding entered on a truck in Delivery Costing, and not already paid some
-- other way, is put on one Feeding payment request per batch, charged to the
-- truck's PFI (services/feedingRequests.service.js). This column says which
-- request carries the truck's feeding. Until that request is paid the feeding
-- still counts on the truck; once paid, the PFI's paid expenses carry it and
-- the truck adds nothing (lib/tripCosts.js) — so it is counted once, always.
--
--   delivery_inventory.feeding_expense_id   the request, or null
--
-- Nothing existing changes: every trip today has none, so it is costed
-- exactly as before.

ALTER TABLE delivery_inventory
  ADD COLUMN IF NOT EXISTS feeding_expense_id integer REFERENCES pfi_expenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS delivery_inventory_feeding_expense_idx
  ON delivery_inventory (feeding_expense_id) WHERE feeding_expense_id IS NOT NULL;
