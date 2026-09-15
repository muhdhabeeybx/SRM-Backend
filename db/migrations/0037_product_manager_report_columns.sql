-- The location manager's sheet, as the desk actually fills it.
--
-- Written by hand in the style of 0002-0036. Idempotent.
--
-- ── What was missing ───────────────────────────────────────────────────────
--
-- The paper sheet carries figures the form had nowhere to put: the BL, the
-- tank's initial dip, the running total sold, how many days the batch has been
-- counting, what was sold today but has not left, and the two balances that
-- follow from it. Those were being written into `remarks` as free text, which
-- means they could not be totalled, compared against the system, or carried
-- into the master report.
--
-- ── One column removed, deliberately ───────────────────────────────────────
--
-- `differentials` and `loading_left_over` were two columns for one thing. The
-- desk writes a single "differentials / loading left over" figure, and having
-- both — one typed as money, one as litres — meant the same quantity was
-- entered twice in two units and disagreed with itself.
--
-- differentials is NOT dropped. It holds filed data on 1,400+ rows and the
-- finance report reads it. It stays in the table and out of this form; the
-- litres figure lives in loading_left_over, which is what it always was.
--
-- ── Nullable, no defaults ──────────────────────────────────────────────────
--
-- A zero and an unanswered question are different things on a sheet somebody
-- fills in over a shift, and these are exactly the fields where "0" would read
-- as a dipped tank rather than an unvisited one.

ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS bl_figure decimal(15,2);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS tank_initial decimal(15,2);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS aggregate_sold decimal(15,2);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS pfi_days_counting integer;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS yesterday_remarks text;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS sold_unloaded decimal(15,2);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS tank_balance_inclusive decimal(15,2);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS net_tank_balance decimal(15,2);

COMMENT ON COLUMN daily_reports.bl_figure IS
  'Bill of Lading quantity for the cargo this batch came from.';
COMMENT ON COLUMN daily_reports.tank_initial IS
  'The tank dip when this batch started — the figure everything else is measured against.';
COMMENT ON COLUMN daily_reports.aggregate_sold IS
  'Total sold on this batch to date, not just today.';
COMMENT ON COLUMN daily_reports.pfi_days_counting IS
  'How many days this batch has been running, as the desk counts it.';
COMMENT ON COLUMN daily_reports.yesterday_remarks IS
  'Carried from the previous sheet so an open issue is not lost between days.';
COMMENT ON COLUMN daily_reports.sold_unloaded IS
  'Sold today but still in the tank — ordered less loaded.';
COMMENT ON COLUMN daily_reports.tank_balance_inclusive IS
  'Tank balance counting product already sold but not yet lifted.';
COMMENT ON COLUMN daily_reports.net_tank_balance IS
  'What is left once product owed to customers is taken out — Soroman''s own.';
