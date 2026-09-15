-- What a truck's trip costs, so a margin can be worked out per truck.
--
-- Written by hand in the style of 0002-0037. Idempotent.
--
-- ── Why on the load and not on the batch ───────────────────────────────────
--
-- Diesel and feeding are bought per truck, per trip. Two trucks on the same
-- batch can take different AGO at different prices, and a batch-level figure
-- would average away the very thing being measured: which trip made money and
-- which did not.
--
-- ── Four inputs, five derivations, nothing stored twice ────────────────────
--
-- Stored:   ago_litres, ago_price, feeding_allowance, product_price
-- Derived:  ago value       = ago_litres x ago_price
--           total expenses  = ago value + feeding allowance
--           cost per litre  = total expenses / quantity_allocated
--           landing cost    = cost per litre + product price
--           margin          = rate - landing cost
--
-- The five are computed where they are read, never written. A stored total is
-- a total that goes stale the moment somebody corrects a price, and this table
-- already carries `rate` — which the margin is measured against — so the drift
-- would be silent and in the direction that flatters.
--
-- ── Nullable, no defaults ──────────────────────────────────────────────────
--
-- Zero and "not costed yet" are different states, and the difference decides
-- whether a margin may be shown at all. A trip with no AGO recorded has an
-- unknown margin, not a 100% one.

ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS ago_litres decimal(12,2);
ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS ago_price decimal(12,2);
ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS feeding_allowance decimal(14,2);
ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS product_price decimal(14,2);
ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS costed_at timestamptz;
ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS costed_by varchar(255);

COMMENT ON COLUMN delivery_inventory.ago_litres IS
  'Diesel issued to this truck for the trip, in litres.';
COMMENT ON COLUMN delivery_inventory.ago_price IS
  'Naira per litre paid for that diesel — the price on the day, not a standing rate.';
COMMENT ON COLUMN delivery_inventory.feeding_allowance IS
  'Naira given to the driver for the trip.';
COMMENT ON COLUMN delivery_inventory.product_price IS
  'What the product on this truck cost us per litre. Entered by hand: it is a purchase price, not the selling rate the row already carries.';
COMMENT ON COLUMN delivery_inventory.costed_at IS
  'When the trip costs were last entered — so an uncosted trip is distinguishable from a zero-cost one.';

CREATE INDEX IF NOT EXISTS delivery_inventory_costed_idx
  ON delivery_inventory (allocation_code) WHERE costed_at IS NOT NULL;
