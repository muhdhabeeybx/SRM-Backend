-- Who a sale line was sold to: an end user or a dealer.
--
-- Written by hand in the style of 0002-0067. Idempotent.
--
-- ── The practice ──────────────────────────────────────────────────────────
--
-- An LPG plant sells at two kinds of price. End users — people filling a
-- cylinder — pay the plant's retail rate. Dealers buy in bulk at a rate agreed
-- per sale. The plants' own daily sheets keep the two in separate columns, and
-- the breakdown at the foot of every sheet ("end users @ 1,650 … dealers @
-- 1,500 …") is the figure they are read for.
--
-- A sale line already carries its quantity and its rate. What it could not say
-- is which of the two buyers it was, and the rate cannot stand in for that: a
-- dealer's agreed rate can equal the end-user rate on a given day, and the
-- breakdown would then put dealer kilograms under end users.
--
-- ── Null is the backfill ──────────────────────────────────────────────────
--
-- Every row already in the table — fuel stations, truck sales, deposits,
-- expenses — was written without the distinction, so null states a fact about
-- all of them rather than guessing. Only a sale line ever carries a value.

ALTER TABLE delivery_sales ADD COLUMN IF NOT EXISTS buyer_class varchar(16);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'delivery_sales_buyer_class_check'
  ) THEN
    ALTER TABLE delivery_sales ADD CONSTRAINT delivery_sales_buyer_class_check CHECK (
      buyer_class IS NULL OR buyer_class IN ('end_user', 'dealer')
    );
  END IF;
END $$;
