-- Which book a delivery_sales row belongs to: the truck sale, or a station's own.
--
-- Written by hand in the style of 0002-0069. Idempotent.
--
-- ── Two books in one table ────────────────────────────────────────────────
--
-- A load sent to a filling station or an LPG plant has two stories, and both
-- were written into delivery_sales as if they were one:
--
--   trucking  who took the load off the truck, at what rate, and what they
--             paid for it. Every customer, a station included.
--   station   what a station or plant then did with its stock: what it sold
--             at the pump, what it spent, what it banked. Dozens of rows per
--             load, over weeks.
--
-- Read as one book, a station's pump sales were the load's value and its
-- deposits were the load's payment, so a trucking PFI could not close until
-- the station had banked the last of its takings. The desk wants the station
-- to be an ordinary customer of the truck sale — charged for its share, and
-- settled like anyone else — with its daily trade kept on its own pages.
--
-- ── The backfill ──────────────────────────────────────────────────────────
--
-- Every row a station or plant carries money on is its own book: a pump or gas
-- sale, an expense, a deposit, a transfer of banked surplus between its loads,
-- and a plant's truckless sheet line. A station's row with no money on it is
-- the load share written when it was put on the truck, and stays with the
-- truck sale. Every other customer's row is the truck sale.
--
-- The backfill runs only in the step that adds the column. Re-running this
-- file must never re-sort rows written since: a settlement of a station's
-- load carries money and belongs to the truck sale, and the rule above would
-- move it.
--
-- ── A settlement from the station account ─────────────────────────────────
--
-- A station is ours, so what it owes the truck sale can be settled without a
-- bank credit: payment_method 'station_account'. The station's own deposits
-- stay on the station's book, so the money is counted once.

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'station_account';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'delivery_sales' AND column_name = 'book'
  ) THEN
    ALTER TABLE delivery_sales ADD COLUMN book varchar(16) NOT NULL DEFAULT 'trucking';

    UPDATE delivery_sales ds
       SET book = 'station'
      FROM delivery_customers dc
     WHERE dc.id = ds.customer_id
       AND dc.customer_type::text IN ('filling_station', 'lpg_plant')
       AND (
            COALESCE(ds.sales_value, 0) <> 0
         OR COALESCE(ds.payment_amount, 0) <> 0
         OR COALESCE(ds.expenses_amount, 0) <> 0
         OR ds.buyer_class IS NOT NULL
         OR COALESCE(btrim(ds.truck_number), '') = ''
       );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'delivery_sales_book_check'
  ) THEN
    ALTER TABLE delivery_sales ADD CONSTRAINT delivery_sales_book_check CHECK (
      book IN ('trucking', 'station')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS delivery_sales_book_idx ON delivery_sales (book);
