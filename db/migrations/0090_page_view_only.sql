-- A page can be given to somebody to look at only.
--
-- Written by hand in the style of 0002-0089. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Manage Users gives each page one of three answers: not theirs, view only, or
-- full. "View only" is a page grant with this set: they may open the page and
-- download its reports, and the server refuses anything that adds, edits or
-- removes while they are on it (middleware/viewOnlyPages.js).
--
--   view_only   only meaningful where allowed is true
--
-- Nothing existing changes: every row today stays a full grant.

ALTER TABLE staff_page_overrides ADD COLUMN IF NOT EXISTS view_only boolean NOT NULL DEFAULT false;
