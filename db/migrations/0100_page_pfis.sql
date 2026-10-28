-- A page can show somebody a PFI list of its own.
--
-- Written by hand in the style of 0002-0099. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Somebody's PFIs (pfi_staff) apply on every page. The owner (28 Oct 2026):
-- "someone can only see pending payments on only selected pfis and can see
-- other pfis on delivery inventory too". So a page grant may carry its own
-- list, and requests from that page use it in place of their PFIs
-- (middleware/pagePfis.js).
--
--   pfi_ids   null = their own PFIs, as before; never stored empty
--
-- Nothing existing changes: every row today stays null.

ALTER TABLE staff_page_overrides ADD COLUMN IF NOT EXISTS pfi_ids integer[];
