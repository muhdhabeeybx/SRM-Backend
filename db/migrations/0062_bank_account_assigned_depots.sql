-- A bank account can be assigned to a location directly, not only through a
-- PFI.
--
-- Written by hand in the style of 0002-0061. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- depot_ids is what everything reads — which accounts an order at a depot may
-- quote (order.service), the depot's subaccount, staff scope, the accounts
-- list — and it has been derived from the account's PFIs on every save, so a
-- location could only be reached through a cargo. Finance also needs to say
-- "this account collects at Warri" for a depot with no PFI on the account.
--
-- assigned_depot_ids holds exactly those direct assignments. depot_ids stays
-- the one list every reader uses, now the union of the depots the PFIs imply
-- and these, recomputed on every save (bankAccount.controller). LPG plants
-- were already assigned directly, through lpg_station_ids.
--
-- filling_station_ids is the third kind of location. A filling station is a
-- delivery_customers row (customer_type 'filling_station'), and its pump
-- sales are lodged into an account of its own — the Moniepoint accounts named
-- Ningi, Alkaleri, Potiskum, Tirwun and Kano — with nothing on the account to
-- say so. It is a record of where the station banks; nothing routes payments
-- by it yet.
--
-- Nothing in production carries a location its PFIs do not imply (checked
-- 2026-09-28), so every account starts with empty lists and no depot_ids
-- changes.

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS assigned_depot_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bank_accounts.assigned_depot_ids IS
  'Depots this account is assigned to directly, beside those its PFIs imply. depot_ids is the union of the two.';

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS filling_station_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bank_accounts.filling_station_ids IS
  'Filling stations (delivery_customers.id, customer_type filling_station) whose sales are lodged into this account.';
