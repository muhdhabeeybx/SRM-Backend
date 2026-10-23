-- A PFI's figures to three decimal places, as the papers print them: BL
-- 26,714,386.863 L at ₦1,228.765 a litre. The litres were whole numbers and
-- the tonnage and price stopped at two places, so the papers could not go in
-- as printed and the cargo cost moved by up to ₦133k on a 26.7m L cargo.
--
-- Written by hand in the style of 0002-0096. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js, and only changes a
-- column still short of three places.
--
--   pfis.starting_qty_litres, bl_qty_litres   integer       -> numeric(15,3)
--   pfis.qty_volume_mt, bl_qty_mt             numeric(14,2) -> numeric(15,3)
--   pfis.unit_price                           numeric(15,2) -> numeric(16,3)
--   pfi_price_reviews.price, previous_price   numeric(15,2) -> numeric(16,3)
--
-- Each keeps the whole-number digits it had. Every figure already stored reads
-- the same afterwards; nothing is rounded. Money totals stay at the kobo, and
-- sold_qty_litres stays whole, because orders are sold in whole litres.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('pfis', 'starting_qty_litres', 15),
      ('pfis', 'bl_qty_litres', 15),
      ('pfis', 'qty_volume_mt', 15),
      ('pfis', 'bl_qty_mt', 15),
      ('pfis', 'unit_price', 16),
      ('pfi_price_reviews', 'price', 16),
      ('pfi_price_reviews', 'previous_price', 16)
    ) AS t(tbl, col, prec)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = c.tbl AND column_name = c.col
         AND COALESCE(numeric_scale, 0) < 3
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE numeric(%s, 3)', c.tbl, c.col, c.prec);
    END IF;
  END LOOP;
END $$;
