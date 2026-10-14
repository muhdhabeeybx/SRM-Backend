-- Vendors that are one vendor, merged into one.
--
-- Written by hand in the style of 0002-0085. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The book has the same vendor saved under several names — "Keonamex",
-- "keonamax", "KEONAMEX PETROLEUM NIG LTD" — so its spend and its statement
-- are split in pieces. Merging (services/vendorMerge) moves everything to the
-- vendor kept: its expenses, the cargos naming it as supplier, the bank lines
-- named to it. The others are not deleted: each stays as a name that points
-- at the vendor kept, so the name still finds it (the request form, linking
-- typed names), and the merge can always be read back.
--
--   merged_into_id   the vendor this one was merged into; set, it is a name
--                    only, left off every list and picker
--   merged_at, merged_by   when, and by whom (staff id)
--
-- Nothing existing changes: three empty columns.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merged_into_id integer;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merged_at timestamptz;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS merged_by integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_merged_into_fk') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_merged_into_fk
      FOREIGN KEY (merged_into_id) REFERENCES vendors(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_not_merged_into_itself') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_not_merged_into_itself CHECK (merged_into_id IS DISTINCT FROM id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vendors_merged_into_idx ON vendors (merged_into_id) WHERE merged_into_id IS NOT NULL;
