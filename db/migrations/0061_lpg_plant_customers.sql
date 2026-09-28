-- An LPG plant can be a delivery customer, the way a filling station is.
--
-- Written by hand in the style of 0002-0060. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── A customer type, not a table of its own ───────────────────────────────
--
-- A filling station takes a truck's load on consignment, sells it down over
-- days and banks the money. The desk allocates it trucks on Delivery
-- Inventory, records its days, and reads it as a running account. An LPG
-- plant does exactly that with gas. Every step of the route — allocations,
-- load splits, sales, the account — hangs off delivery_customers, so a plant
-- that is a delivery_customers row takes the whole route as it stands, and
-- nothing about the route needs a second copy.
--
-- ── The link to lpg_stations ──────────────────────────────────────────────
--
-- Soroman's own plants already exist as lpg_stations rows: staff are assigned
-- to them, and expenses are raised against them (0055). A plant registered as
-- a customer may name the lpg_stations row it IS, so that:
--
--   - what Soroman pays vendors for that plant comes off its account's profit,
--     the way a filling station's costs come off a station's; and
--   - a person assigned that plant sees its account and no other plant's.
--
-- A plant that is not one of ours — a third party taking gas on consignment —
-- has no row there, and the link stays null.
--
-- One account per plant. Two customers claiming the same plant would each
-- take its costs, and the profit would be understated twice over.

ALTER TYPE delivery_customer_type ADD VALUE IF NOT EXISTS 'lpg_plant';

ALTER TABLE delivery_customers
  ADD COLUMN IF NOT EXISTS lpg_station_id integer
    REFERENCES lpg_stations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_customers_lpg_station_uidx
  ON delivery_customers (lpg_station_id)
  WHERE lpg_station_id IS NOT NULL;
