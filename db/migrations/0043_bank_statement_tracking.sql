-- Everything an uploaded statement should have been able to tell you.
--
-- Written by hand in the style of 0002-0042. Idempotent.
--
-- ── Repeated references are a finding, not a footnote ──────────────────────
--
-- ingest() already counts the rows it drops because their REFERENCE is
-- already on the account — a different thing from a row that matched in every
-- field, and the symptom of a mis-mapped reference column (see the account 37
-- note in bankStatement.repository.js). That count was returned to the caller
-- in one toast and then thrown away, so an account quietly shedding a month
-- of credits on every upload looked, a day later, exactly like an account
-- that had nothing to shed.
--
-- Keeping it per upload makes the pattern visible: one file with three is a
-- genuine overlap, every file with hundreds is a mapping that needs fixing.
ALTER TABLE bank_statements
  ADD COLUMN IF NOT EXISTS repeated_reference_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN bank_statements.repeated_reference_count IS
  'Rows in this upload skipped because their bank reference was already on the account. A persistently high count means the reference column is mapped onto something that is not a reference.';

-- ── The per-day read needs its own index ───────────────────────────────────
--
-- The pool index is (bank_account_id, status), which answers "what is still
-- unmatched on this account". The statements screen now asks a different
-- question — every line on this account between two dates, newest day first —
-- and that one had no index at all behind it.
CREATE INDEX IF NOT EXISTS bsl_account_day_idx
  ON bank_statement_lines (bank_account_id, txn_date DESC);
