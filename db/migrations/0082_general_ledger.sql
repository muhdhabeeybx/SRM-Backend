-- The general ledger: balanced journal entries on the chart of accounts.
--
-- Written by hand in the style of 0002-0081. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── How it fills ──────────────────────────────────────────────────────────
--
-- Nobody types a journal for an order, a payment or an expense. The posting
-- engine (services/accounting/posting.service.js) reads the desks' own
-- records and writes the entries, and keeps, per record, the lines it has
-- booked (ledger_postings). When a record changes or goes, the engine books
-- the difference — never by editing what is already in the ledger.
--
-- ── What the database itself refuses ──────────────────────────────────────
--
--   an entry whose debits and credits differ, or with fewer than two lines —
--   checked when the transaction commits, so an entry is written whole;
--   a line with both a debit and a credit, or neither;
--   any UPDATE or DELETE of a journal row. A mistake is put right by another
--   entry, which is what keeps a month that has been read the same tomorrow.
--   The one way past the last rule is SET LOCAL ledger.allow_rewrite = 'on',
--   for redoing the first posting before go-live, by hand.
--
-- ── Periods ───────────────────────────────────────────────────────────────
--
-- The books start on accounting_settings.books_start (1 Oct 2026, the
-- owner's choice). Records before it are carried in by the opening entry,
-- not posted one by one. A closed month takes nothing new: a late change is
-- booked on the first open day and marked late.
--
-- Nothing existing changes: new tables only.

CREATE TABLE IF NOT EXISTS journal_entries (
  id                serial PRIMARY KEY,
  entry_date        date NOT NULL,
  kind              varchar(20) NOT NULL,
  -- What it was posted from: 'order_sale' 41022, 'expense_bill' 812 … Null on
  -- an entry somebody wrote by hand.
  source_type       varchar(40),
  source_id         varchar(80),
  memo              text NOT NULL DEFAULT '',
  -- The day the record itself is dated, where the entry had to go later
  -- because that month was closed (or before the books started).
  original_date     date,
  is_late           boolean NOT NULL DEFAULT false,
  reverses_entry_id integer REFERENCES journal_entries(id),
  created_by        integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_kind_check') THEN
    ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_kind_check
      CHECK (kind IN ('auto', 'adjustment', 'opening', 'manual', 'reversal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS journal_entries_source_idx ON journal_entries (source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id              serial PRIMARY KEY,
  entry_id        integer NOT NULL REFERENCES journal_entries(id),
  -- RESTRICT: an account with lines on it cannot disappear from the chart.
  account_id      integer NOT NULL REFERENCES expense_categories(id),
  debit           numeric(18, 2) NOT NULL DEFAULT 0,
  credit          numeric(18, 2) NOT NULL DEFAULT 0,
  -- Who the line is about, for statements and control-account checks.
  party_type      varchar(20),
  party_id        integer,
  pfi_id          integer,
  bank_account_id integer,
  memo            text NOT NULL DEFAULT ''
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_side_check') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_side_check
      CHECK (debit >= 0 AND credit >= 0 AND (debit > 0) <> (credit > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_party_check') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_party_check
      CHECK (party_type IS NULL OR party_type IN ('customer', 'delivery_customer', 'vendor'));
  END IF;
END $$;

-- What every line is about, beyond its account — so any report can be read
-- for one part of the business (the owner's ask, 14 Oct 2026):
--
--   unit        the line of business: depot | trucking | stations |
--               lpg_plants | fleet | head_office
--   location    where: a depot, a filling station or an LPG plant
--               (location_type depot | station | plant, and its id — a
--               depot's id, or the station's or plant's delivery customer)
--   pfi_id      which cargo (above)
--
-- Set by the posting engine from the record it books, never typed.
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS unit varchar(20);
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS location_type varchar(20);
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS location_id integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_unit_check') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_unit_check
      CHECK (unit IS NULL OR unit IN ('depot', 'trucking', 'stations', 'lpg_plants', 'fleet', 'head_office'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_location_check') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_location_check
      CHECK ((location_type IS NULL) = (location_id IS NULL)
             AND (location_type IS NULL OR location_type IN ('depot', 'station', 'plant')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_unit_idx ON journal_lines (unit) WHERE unit IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_lines_pfi_idx ON journal_lines (pfi_id) WHERE pfi_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_lines_location_idx ON journal_lines (location_type, location_id) WHERE location_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines (account_id);
CREATE INDEX IF NOT EXISTS journal_lines_party_idx ON journal_lines (party_type, party_id) WHERE party_type IS NOT NULL;

-- What the engine has booked for each record, line by line, so the next run
-- can book only the difference. A record from before the books started is
-- noted here with no entry: the opening balance carries it.
CREATE TABLE IF NOT EXISTS ledger_postings (
  source_type varchar(40) NOT NULL,
  source_id   varchar(80) NOT NULL,
  lines       jsonb NOT NULL DEFAULT '[]'::jsonb,
  fingerprint text NOT NULL DEFAULT '',
  last_entry_id integer REFERENCES journal_entries(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);

-- A journal written by hand waits here until somebody else approves it —
-- one person writes, another posts (maker-checker). Approving posts it to
-- journal_entries (entry_id); rejecting says why. Nothing here is in the
-- books until then.
CREATE TABLE IF NOT EXISTS journal_drafts (
  id            serial PRIMARY KEY,
  entry_date    date NOT NULL,
  memo          text NOT NULL,
  lines         jsonb NOT NULL,
  status        varchar(10) NOT NULL DEFAULT 'waiting',
  written_by    integer,
  written_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    integer,
  decided_at    timestamptz,
  reject_reason text NOT NULL DEFAULT '',
  entry_id      integer REFERENCES journal_entries(id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_drafts_status_check') THEN
    ALTER TABLE journal_drafts ADD CONSTRAINT journal_drafts_status_check
      CHECK (status IN ('waiting', 'posted', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS journal_drafts_status_idx ON journal_drafts (status);

CREATE TABLE IF NOT EXISTS accounting_periods (
  period      char(7) PRIMARY KEY,          -- '2026-10'
  status      varchar(10) NOT NULL DEFAULT 'open',
  closed_at   timestamptz,
  closed_by   integer,
  reopened_at timestamptz,
  reopened_by integer
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_periods_status_check') THEN
    ALTER TABLE accounting_periods ADD CONSTRAINT accounting_periods_status_check
      CHECK (status IN ('open', 'closed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS accounting_settings (
  key        varchar(60) PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer
);

INSERT INTO accounting_settings (key, value) VALUES
  ('books_start', '2026-10-01'),
  -- 'cost': VAT on a purchase is part of what it cost. 'recoverable': it is
  -- claimed back, and sits in Input VAT instead.
  ('purchase_vat', 'cost')
ON CONFLICT (key) DO NOTHING;

-- ── Every entry balances ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION journal_entry_balances() RETURNS trigger AS $$
DECLARE
  e_id integer;
  d numeric;
  c numeric;
  n integer;
BEGIN
  -- Each branch is only parsed when it runs, so neither names a column the
  -- other table lacks.
  IF TG_TABLE_NAME = 'journal_lines' THEN
    e_id := NEW.entry_id;
  ELSE
    e_id := NEW.id;
  END IF;
  -- An entry written and taken away in the same transaction has nothing left
  -- to check.
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = e_id) THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = e_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Journal entry % has % line(s); an entry needs at least two', e_id, n;
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Journal entry % does not balance: debits % against credits %', e_id, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balance ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balance
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balances();

DROP TRIGGER IF EXISTS journal_entries_balance ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balance
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balances();

-- ── Nothing in the journal is edited ──────────────────────────────────────

CREATE OR REPLACE FUNCTION journal_is_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('ledger.allow_rewrite', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'The journal is never edited: % on % refused. Post a correcting entry instead.', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_append_only ON journal_entries;
CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

DROP TRIGGER IF EXISTS journal_lines_append_only ON journal_lines;
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();
