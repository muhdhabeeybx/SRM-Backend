-- A PFI's quantity and its BL figure carry decimals: 27,090,717.50 L in the
-- tank, 26,714,386.86 L on the papers. Both were whole numbers, so the BL
-- cost ran off a rounded figure and the form refused what the papers say.
--
-- Written by hand in the style of 0002-0096. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js, and only changes a
-- column that is still integer.
--
-- Two places, the same as bl_qty_mt and qty_volume_mt. Every figure already
-- stored is a whole number and reads the same afterwards; nothing is rounded.
-- sold_qty_litres stays whole, because orders are sold in whole litres.

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pfis'
         AND column_name = 'starting_qty_litres') = 'integer' THEN
    ALTER TABLE pfis ALTER COLUMN starting_qty_litres TYPE numeric(14, 2);
  END IF;
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pfis'
         AND column_name = 'bl_qty_litres') = 'integer' THEN
    ALTER TABLE pfis ALTER COLUMN bl_qty_litres TYPE numeric(14, 2);
  END IF;
END $$;
