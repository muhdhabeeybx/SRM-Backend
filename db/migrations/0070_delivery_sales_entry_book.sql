-- Which record a new delivery_sales row belongs to: the sales ledger, or a
-- station's own book. Forward only.
--
-- Written by hand in the style of 0002-0069. Idempotent. Additive: one
-- nullable column, a check and an index. No existing row is changed.
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- A load sent to a filling station or LPG plant used to be read through the
-- station's own entries: its pump sales were the load's value on the sales
-- ledger and its deposits were the load's payment. From PFI-47B on the
-- owner wants a station treated like any customer there — the truck assigned,
-- a rate, payments added the normal way — with its daily pump sales,
-- expenses and deposits kept as a separate record on the station page.
--
-- ── Nothing is rewritten ──────────────────────────────────────────────────
--
-- Every existing row keeps book NULL. How a NULL row is read is decided where
-- it is read (lib/deliveryBook.js): a station's rows on PFI-47B and after are
-- read the new way, as the owner asked; every earlier batch is read exactly
-- as before. Only rows written from now on carry a value:
--
--   trucking  written on the sales ledger: a load's customer, its rate, its
--             payments, a transfer between trucks.
--   station   written on a station or plant page: a pump or gas sale, an
--             expense, a deposit.

ALTER TABLE delivery_sales ADD COLUMN IF NOT EXISTS book varchar(16);
-- A database that ran the withdrawn first 0070 (local copies only — it never
-- reached production) has this column NOT NULL with a default. Neither may
-- stand: a new row must say which record it is, or be read as before.
ALTER TABLE delivery_sales ALTER COLUMN book DROP NOT NULL;
ALTER TABLE delivery_sales ALTER COLUMN book DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'delivery_sales_book_check'
  ) THEN
    ALTER TABLE delivery_sales ADD CONSTRAINT delivery_sales_book_check CHECK (
      book IS NULL OR book IN ('trucking', 'station')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS delivery_sales_book_idx ON delivery_sales (book);
