-- The CFO report's corrections, kept beside the book rather than inside it.
--
-- Written by hand in the style of 0002-0039, for the reason set out in 0003.
-- Every statement is idempotent, so re-running the file is a no-op.
--
-- ── What this table is for ─────────────────────────────────────────────────
--
-- The CFO report states, for each PFI on each day: what the batch started
-- with, what has sold off it, what sold that day, what is left, what that
-- came to in naira, what reached the bank, and the difference between the
-- last two. Every one of those is computed from orders and order_payments —
-- see services/cfoReport.service.js, which is the authority on how.
--
-- Computed is not always right. A batch's tank figure gets restated after a
-- dip, a cargo lands against the wrong batch and is moved weeks later, money
-- arrives by a route nobody has matched to a statement line yet. The desk
-- knows these things before the database does, and a report that cannot be
-- corrected is a report that gets re-keyed into a spreadsheet and diverges.
--
-- ── Null means "the system's figure stands" ────────────────────────────────
--
-- Every override column is nullable with no default, and null is the whole
-- design: it says nobody has overridden this cell, which is a different fact
-- from somebody having typed 0 into it. A NOT NULL DEFAULT 0 here would make
-- the two indistinguishable and quietly zero out every figure on the report
-- the moment one remark was saved against a row.
--
-- ── What is NOT stored, on purpose ─────────────────────────────────────────
--
-- Stock balance and surplus/deficit have no column here. They are arithmetic
-- on the cells beside them —
--
--     stock balance   = initial qty        - cumulative sales volume
--     surplus/deficit = bank inflow        - sales value to date
--
-- — and letting them be typed independently would let a sheet go out on which
-- the numbers in a row do not add up to the number at the end of it. That is
-- the one defect an audit document cannot survive. Correct an input and the
-- derived figure follows; where the real tank disagrees with the arithmetic,
-- restate `initial_qty` or say so in `remarks`.
--
-- ── Keyed by day and batch ─────────────────────────────────────────────────
--
-- One row per (date, PFI) — the cell the report is laid out in. A correction
-- to 15 September does not touch 16 September, because the two days were
-- signed off separately and by different figures.

CREATE TABLE IF NOT EXISTS cfo_report_entries (
  id            serial       PRIMARY KEY,
  -- The calendar day in the reporting zone (Africa/Lagos), not an instant.
  -- A report line belongs to a day, and a timestamptz here would put the
  -- same line on two different days depending on who read it.
  report_date   date         NOT NULL,
  pfi_id        integer      NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,

  -- ── the overrides. NULL = not overridden; see above ──
  initial_qty        numeric(18, 2),
  cumulative_volume  numeric(18, 2),
  day_volume         numeric(18, 2),
  sales_value        numeric(18, 2),
  bank_inflow        numeric(18, 2),

  -- Free text, and the only column here that is not an override of a figure.
  -- Empty string rather than null: there is no difference worth keeping
  -- between "no remark" and "an empty remark".
  remarks       text         NOT NULL DEFAULT '',

  -- Who last touched the row. The report is an audit document and a
  -- correction with no author on it is worth less than no correction.
  updated_by    integer      REFERENCES staff(id) ON DELETE SET NULL,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

-- One entry per batch per day. This is what lets the save path be a plain
-- upsert rather than a read-then-write that two people can race.
CREATE UNIQUE INDEX IF NOT EXISTS cfo_report_entries_date_pfi_idx
  ON cfo_report_entries (report_date, pfi_id);

-- The report reads a date range and then groups by day, so the range scan is
-- the access path that matters.
CREATE INDEX IF NOT EXISTS cfo_report_entries_date_idx
  ON cfo_report_entries (report_date);

COMMENT ON TABLE cfo_report_entries IS
  'Manual corrections and remarks on the CFO report, one row per (date, PFI). Null in an override column means the computed figure stands. Stock balance and surplus/deficit are deliberately absent — they are derived so a row always adds up. See services/cfoReport.service.js.';
