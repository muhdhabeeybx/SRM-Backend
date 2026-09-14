-- Keep what the system said, next to what was typed.
--
-- Written by hand in the style of 0002-0035. Idempotent.
--
-- ── Why store it rather than recompute ─────────────────────────────────────
--
-- The daily report is typed by hand and every figure on it is also recorded:
-- litres sold, orders raised, commission paid, trucks through the gate.
-- Nobody compared the two, so a report stating 1,000,000 litres against a PFI
-- the system had 1,200,000 confirmed on was filed, approved, and the variance
-- only ever surfaced if a person went looking.
--
-- The comparison could be recomputed whenever the master report is opened, and
-- that would be wrong. Orders get cancelled, payments get rematched, a batch
-- gets reassigned — so a report read in November would be checked against a
-- book that has moved since it was filed, and the variance would change every
-- time somebody looked. What the desk needs to answer is "did this agree with
-- the system ON THE DAY", which means the answer has to be captured then.
--
-- One jsonb column, holding the figures the service computed at submit time.
-- Null on every report filed before this, and the master report says "not
-- captured" rather than pretending zero — an old report is not a report with
-- no variance, it is one nobody checked.

ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS system_actuals jsonb;

COMMENT ON COLUMN daily_reports.system_actuals IS
  'What the system held for this PFI and date at the moment the report was submitted. Captured rather than recomputed so a variance cannot drift as the book moves. See services/reportActuals.service.js.';
