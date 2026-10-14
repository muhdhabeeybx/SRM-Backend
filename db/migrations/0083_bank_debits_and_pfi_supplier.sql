-- Money out of the bank, what Finance says a line was, and who a cargo was
-- bought from.
--
-- Written by hand in the style of 0002-0082. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── bank_statement_debits ─────────────────────────────────────────────────
--
-- Statement uploads read credits only, so the books had no money out. A
-- withdrawal is kept here, in a table of its own: nothing that reads
-- bank_statement_lines — the payment pickers, the matching, the finance
-- report — can mistake one for a payment in. Deduplicated per account the way
-- credits are (dedup_key).
--
-- ── bank_line_classifications ─────────────────────────────────────────────
--
-- A line no record in the dashboard explains — a loan paid in, capital, tax
-- paid to FIRS, a director's drawing — is named here by Finance: which
-- account it was, and why. A credit so named stays unmatched as far as the
-- payment desks are concerned; if it is later matched to an order after all,
-- the order's payment books it and this is set aside.
--
-- ── bank_statement_column_mappings.debit_column ───────────────────────────
--
-- Where an account's statement keeps its withdrawals, beside its credit
-- column. An account with one signed amount column needs none.
--
-- ── pfis.supplier_vendor_id ───────────────────────────────────────────────
--
-- Who the product on a cargo was bought from, so what is owed for it sits on
-- that supplier's statement.
--
-- Nothing existing changes: new tables and empty columns.

CREATE TABLE IF NOT EXISTS bank_statement_debits (
  id              serial PRIMARY KEY,
  bank_account_id integer NOT NULL REFERENCES bank_accounts(id),
  -- The upload it came in with: deleting a wrong upload takes its withdrawals too.
  statement_id    integer REFERENCES bank_statements(id) ON DELETE CASCADE,
  txn_date        date NOT NULL,
  amount          numeric(18, 2) NOT NULL,
  beneficiary     varchar(255) NOT NULL DEFAULT '',
  bank_ref        varchar(255) NOT NULL DEFAULT '',
  narration       text NOT NULL DEFAULT '',
  raw_row         jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedup_key       varchar(64) NOT NULL,
  uploaded_by     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_statement_debits_amount_check') THEN
    ALTER TABLE bank_statement_debits ADD CONSTRAINT bank_statement_debits_amount_check CHECK (amount > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_debits_dedup_idx ON bank_statement_debits (bank_account_id, dedup_key);
CREATE INDEX IF NOT EXISTS bank_statement_debits_day_idx ON bank_statement_debits (bank_account_id, txn_date);

CREATE TABLE IF NOT EXISTS bank_line_classifications (
  id          serial PRIMARY KEY,
  -- 'credit' is a bank_statement_lines row, 'debit' a bank_statement_debits row.
  direction   varchar(6) NOT NULL,
  line_id     integer NOT NULL,
  account_id  integer NOT NULL REFERENCES expense_categories(id),
  vendor_id   integer REFERENCES vendors(id),
  note        text NOT NULL DEFAULT '',
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_line_classifications_direction_check') THEN
    ALTER TABLE bank_line_classifications ADD CONSTRAINT bank_line_classifications_direction_check
      CHECK (direction IN ('credit', 'debit'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bank_line_classifications_line_idx ON bank_line_classifications (direction, line_id);

ALTER TABLE bank_statement_column_mappings ADD COLUMN IF NOT EXISTS debit_column integer;

ALTER TABLE pfis ADD COLUMN IF NOT EXISTS supplier_vendor_id integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pfis_supplier_vendor_fk') THEN
    ALTER TABLE pfis ADD CONSTRAINT pfis_supplier_vendor_fk
      FOREIGN KEY (supplier_vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
  END IF;
END $$;
