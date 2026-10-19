-- An expense a station or LPG plant paid out of its own sales cash.
--
-- Written by hand in the style of 0002-0091. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Until now a station's day sheet kept what it spent as delivery_sales rows
-- (expenses_amount), outside Expenses and its approvals, while Expenses held
-- only what Soroman paid vendors for a station. The owner wants every station
-- and plant expense in Expenses and through its approvals, bank charges aside.
-- An expense the station paid from its takings is raised there with this set:
-- it walks the same chain (officer, CFO, final approval, marked paid), and
-- the station pages take it off what the station still has to bank from the
-- day it is raised — back on if it is rejected.
--
--   paid_from_takings   true = paid out of the station's or plant's own sales
--                       cash; needs exactly one station or plant on the row
--
-- Nothing existing changes: every expense today stays false.

ALTER TABLE pfi_expenses ADD COLUMN IF NOT EXISTS paid_from_takings boolean NOT NULL DEFAULT false;
