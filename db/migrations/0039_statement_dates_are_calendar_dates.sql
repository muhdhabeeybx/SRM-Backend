-- A bank statement date is a calendar date, not an instant.
--
-- Written by hand in the style of 0002-0038. Idempotent.
--
-- ── What went wrong ────────────────────────────────────────────────────────
--
-- txn_date was `timestamptz`, and the parser built it with
-- `new Date(year, month, day)` — LOCAL midnight. In Lagos that serialises to
-- 23:00 the previous day in UTC. The dashboard rendered it back through the
-- same timezone, so it looked right on screen while the database, every
-- export and every SQL report held the day before. 1,066 rows across 104
-- statements carry that shift.
--
-- A timestamp was always the wrong type for this. The bank prints "09/07/2026"
-- on a page; there is no hour, no zone, and no instant to be converted between
-- them. A `date` column cannot carry the error at all, which is the point:
-- what is read out is exactly what was uploaded.
--
-- ── The conversion repairs the history in the same step ────────────────────
--
-- Reading each stored instant back in Africa/Lagos recovers the day that was
-- meant:
--
--   2026-07-08 23:00Z  →  Lagos 2026-07-09 00:00  →  date 2026-07-09  (fixed)
--   2026-07-09 00:00Z  →  Lagos 2026-07-09 01:00  →  date 2026-07-09  (unchanged)
--
-- So the rows written by the broken path land on their intended day, and the
-- rows that were already correct are untouched. That is only true because
-- every row was written from a Nigerian browser; a statement typed in another
-- timezone would need its own judgement, and none exist.
--
-- ── What is deliberately NOT touched ───────────────────────────────────────
--
-- order_payments.txn_date. It is a separate column, copied from these lines
-- when a payment is matched, and the finance report filters periods on it.
-- Correcting it would move figures between periods on a report that has been
-- audited and signed off. That is a decision for the desk, not a migration,
-- and it is stated here so the divergence is on the record rather than
-- discovered later: a matched payment may read one day earlier than the
-- statement line it came from, for rows imported before this.

ALTER TABLE bank_statement_lines
  ALTER COLUMN txn_date TYPE date
  USING (txn_date AT TIME ZONE 'Africa/Lagos')::date;

-- The statement's own period, from the same broken instants.
ALTER TABLE bank_statements
  ALTER COLUMN period_start TYPE date
  USING (period_start AT TIME ZONE 'Africa/Lagos')::date;

ALTER TABLE bank_statements
  ALTER COLUMN period_end TYPE date
  USING (period_end AT TIME ZONE 'Africa/Lagos')::date;

COMMENT ON COLUMN bank_statement_lines.txn_date IS
  'The date printed on the statement. A calendar date deliberately: there is no hour or timezone on a bank line, and storing one is how a row ends up a day out.';
