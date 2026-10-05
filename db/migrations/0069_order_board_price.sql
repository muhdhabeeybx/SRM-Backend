-- The board price on the day an unpriced order was raised.
--
-- Written by hand in the style of 0002-0068. Idempotent.
--
-- ── Why it has to be kept, not looked up ──────────────────────────────────
--
-- An order raised with no price (migration 0049) is priced days later, by
-- hand, at a figure somebody agreed. Nothing measured that figure against
-- anything: a price far under the day's board could be typed, and the only
-- trace was the number itself. The comparison has to be against the board AS
-- IT STOOD WHEN THE PRODUCT LEFT, and that cannot be recovered afterwards —
-- every depot price is zeroed at 23:59 each night (priceReset.service), so by
-- the time the order is priced the board it left at is gone.
--
-- So placeOrder writes it here at the moment of raising. Pricing below it is
-- still allowed — the owner's decision — but the gap is shown on the order and
-- the receivables list, and written into the pricing's audit row.
--
-- ── Null is the backfill ──────────────────────────────────────────────────
--
-- A priced order needs none: its price is the board price it was raised at.
-- An unpriced order raised before this column existed had its board price
-- zeroed long ago and cannot be given one honestly. A board that read zero
-- when the order was raised (the morning before prices are set) is also null:
-- there was nothing to measure against.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS board_price numeric(15,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_board_price_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_board_price_check CHECK (board_price IS NULL OR board_price > 0);
  END IF;
END $$;
