-- How many trucks an order is expected to take.
--
-- Written by hand in the style of 0002-0032. Idempotent.
--
-- ── The problem ────────────────────────────────────────────────────────────
--
-- order_trucks rows are created when tickets are generated. Before that an
-- order has none, so nothing anywhere knows how many it is waiting for. Every
-- screen therefore counts ORDERS — "46 orders awaiting tickets" — when the
-- work is per truck, and the reports can only say what was loaded by
-- subtracting litres and inferring the rest.
--
-- It also makes partial ticketing invisible. An order for six trucks with two
-- ticketed looks identical to one for two trucks fully ticketed: both show
-- two rows and neither says what is missing. The only clue is a litre
-- subtraction the reader has to do in their head.
--
-- ── The denominator ────────────────────────────────────────────────────────
--
-- Stated on the order, once, so every count afterwards is against a number
-- somebody gave rather than one the system inferred. "Truck 2 of 6" is then a
-- fact, and "4 still to ticket" is arithmetic instead of a guess.
--
-- Nullable on purpose. Historic orders have nobody to ask, and an order can
-- genuinely be raised before the haulage is settled — so the absence of a
-- figure is itself honest, and the UI says "3 ticketed" rather than inventing
-- a total. What it must never do is guess one from litres ÷ a typical truck.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_trucks integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_expected_trucks_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_expected_trucks_check
      CHECK (expected_trucks IS NULL OR expected_trucks > 0);
  END IF;
END $$;

-- Backfilled only where the answer is already known beyond doubt: the order is
-- finished, so the trucks it took ARE the trucks it expected. Anything still
-- moving is left null rather than being told what it expected by counting what
-- it has so far — which would make every partially-ticketed order look
-- complete, the exact confusion this column exists to end.
UPDATE orders o
   SET expected_trucks = t.n
  FROM (
    SELECT order_id, COUNT(*)::int AS n
      FROM order_trucks
     GROUP BY order_id
  ) t
 WHERE t.order_id = o.id
   AND o.expected_trucks IS NULL
   AND o.status = 'Completed'
   AND t.n > 0;
