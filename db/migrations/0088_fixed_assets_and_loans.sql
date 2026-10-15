-- What the company owns that it does not sell, and what it has borrowed.
--
-- Written by hand in the style of 0002-0087. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The owner's ask (15 Oct 2026): the accounts must show fixed assets and
-- liabilities as well as trade. Two registers the books read from
-- (lib/accounting/postingSources/assets.js, loans.js):
--
--   fixed_assets      trucks, generators, tanks, buildings, land, equipment.
--                     Every Fleet Truck is listed on the page with its cost
--                     still to fill; a row here is made when it is filled.
--                     Wear and tear: what it cost, less what it will fetch at
--                     the end, spread evenly over the months of its life,
--                     from the month after it was bought — the owner's
--                     choice. Land (no life) never wears.
--   loans             a bank loan, hire purchase or lease, another lender.
--                     A bank overdraft is not here: it is a bank account
--                     below nought, and the books read it from the bank.
--   loan_repayments   what was paid back, the part off what is owed and the
--                     part that was interest.
--
-- In the books:
--
--   asset bought          Dr Trucks & equipment (1500)
--                           Cr the bank it was paid from (Suspense until its
--                              withdrawal is on a statement), or
--                           Cr the expense account it was first booked to, or
--                           Cr Loans (hire purchase) and the deposit's bank, or
--                           Cr Opening balance equity (owned before the books)
--   wear, each month      Dr Depreciation & Amortisation (6260)
--                           Cr Accumulated depreciation (1590)
--   asset sold / gone     Dr Accumulated depreciation, Dr the bank (proceeds)
--                           Cr Trucks & equipment, and the difference to
--                           Gain or loss on assets sold (4910)
--   loan received         Dr the bank / Cr Loans (the loan)
--   repayment             Dr Loans (the part off it), Dr Interest on loans (6500)
--                           Cr the bank

-- ── The registers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loans (
  id                serial PRIMARY KEY,
  -- bank_loan | hire_purchase | other_lender
  kind              varchar(20) NOT NULL,
  lender            varchar(255) NOT NULL,
  -- What was borrowed, for a loan paid in money. A hire purchase's is what
  -- its assets put on it (fixed_assets.financed), so it is not typed twice.
  amount            numeric(18, 2),
  received_on       date,
  -- The account the money landed in. Null on hire purchase.
  bank_account_id   integer REFERENCES bank_accounts(id),
  interest_rate     numeric(7, 3),
  term_months       integer,
  notes             text NOT NULL DEFAULT '',
  closed_on         date,
  created_by        integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        integer,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loans_kind_check') THEN
    ALTER TABLE loans ADD CONSTRAINT loans_kind_check
      CHECK (kind IN ('bank_loan', 'hire_purchase', 'other_lender'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loans_amount_check') THEN
    ALTER TABLE loans ADD CONSTRAINT loans_amount_check CHECK (amount IS NULL OR amount > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS loan_repayments (
  id                serial PRIMARY KEY,
  loan_id           integer NOT NULL REFERENCES loans(id),
  paid_on           date NOT NULL,
  principal         numeric(18, 2) NOT NULL DEFAULT 0,
  interest          numeric(18, 2) NOT NULL DEFAULT 0,
  bank_account_id   integer REFERENCES bank_accounts(id),
  notes             text NOT NULL DEFAULT '',
  created_by        integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loan_repayments_amount_check') THEN
    ALTER TABLE loan_repayments ADD CONSTRAINT loan_repayments_amount_check
      CHECK (principal >= 0 AND interest >= 0 AND principal + interest > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS loan_repayments_loan_idx ON loan_repayments (loan_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fixed_assets (
  id                serial PRIMARY KEY,
  name              varchar(255) NOT NULL,
  -- truck | vehicle | generator | tank | building | land | equipment |
  -- computer | furniture | other
  kind              varchar(20) NOT NULL,
  -- The Fleet Truck it is, where it is one: one row per truck.
  fleet_truck_id    integer REFERENCES fleet_trucks(id),
  bought_on         date NOT NULL,
  cost              numeric(18, 2) NOT NULL,
  -- What it should fetch at the end of its life; wear stops there.
  residual          numeric(18, 2) NOT NULL DEFAULT 0,
  -- Months it is used for. Null: it does not wear (land).
  life_months       integer,
  -- bank | expense | loan | owned
  paid_how          varchar(10) NOT NULL,
  -- paid_how = bank: the account it left. paid_how = loan: the deposit's.
  bank_account_id   integer REFERENCES bank_accounts(id),
  -- paid_how = expense: the expense it was first booked as.
  expense_id        integer REFERENCES pfi_expenses(id),
  -- paid_how = loan: the hire purchase, how much of the cost it carries, and
  -- the deposit paid ourselves (cost − financed).
  loan_id           integer REFERENCES loans(id),
  financed          numeric(18, 2),
  -- The part of the business it serves, and where it is.
  unit              varchar(20),
  location_type     varchar(20),
  location_id       integer,
  notes             text NOT NULL DEFAULT '',
  -- Sold, scrapped or lost: the day, what it fetched, the bank it went into.
  disposed_on       date,
  disposed_for      numeric(18, 2),
  disposed_bank_account_id integer REFERENCES bank_accounts(id),
  created_by        integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        integer,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixed_assets_kind_check') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_kind_check
      CHECK (kind IN ('truck', 'vehicle', 'generator', 'tank', 'building', 'land', 'equipment', 'computer', 'furniture', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixed_assets_paid_how_check') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_paid_how_check
      CHECK (paid_how IN ('bank', 'expense', 'loan', 'owned'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixed_assets_amounts_check') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_amounts_check
      CHECK (cost > 0 AND residual >= 0 AND residual <= cost
             AND (life_months IS NULL OR life_months > 0)
             AND (financed IS NULL OR (financed > 0 AND financed <= cost))
             AND (disposed_for IS NULL OR disposed_for >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixed_assets_unit_check') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_unit_check
      CHECK (unit IS NULL OR unit IN ('depot', 'trucking', 'stations', 'lpg_plants', 'fleet', 'head_office'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fixed_assets_location_check') THEN
    ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_location_check
      CHECK ((location_type IS NULL) = (location_id IS NULL)
             AND (location_type IS NULL OR location_type IN ('depot', 'station', 'plant')));
  END IF;
END $$;

-- One asset per truck, while it stands.
CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_truck_idx ON fixed_assets (fleet_truck_id)
  WHERE fleet_truck_id IS NOT NULL AND deleted_at IS NULL;
-- An expense becomes one asset at most.
CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_expense_idx ON fixed_assets (expense_id)
  WHERE expense_id IS NOT NULL AND deleted_at IS NULL;

-- ── The accounts ──────────────────────────────────────────────────────────
--
-- 6260 Depreciation & Amortisation has been on the expense form since 0007
-- and nothing is booked to it; it is given the engine's key rather than a
-- second account. The other two are new.

UPDATE expense_categories SET system_key = 'depreciation'
 WHERE gl_code = '6260' AND system_key IS NULL
   AND NOT EXISTS (SELECT 1 FROM expense_categories WHERE system_key = 'depreciation');

INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, system_key, cash_flow_class, is_system_category)
SELECT v.name, v.code, v.grp, v.sub, v.key, v.cash, false
  FROM (VALUES
    ('Depreciation & Amortisation',  '6260', 'general', '',              'depreciation',    NULL),
    ('Interest on loans',            '6500', 'general', 'Finance costs', 'loan_interest',   'financing'),
    ('Gain or loss on assets sold',  '4910', 'income',  'Other income',  'asset_disposals', 'investing')
  ) AS v(name, code, grp, sub, key, cash)
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.system_key = v.key OR c.name = v.name)
   AND NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.gl_code = v.code);

-- ── A bank line can be one of these ───────────────────────────────────────
--
--   asset           the withdrawal that paid for an asset, or its deposit
--   asset_sale      money in for an asset sold
--   loan            money in from a lender
--   loan_repayment  the withdrawal that paid a loan back
--
-- Each names its record in ref_id, and a record is matched once.

-- Swapped once: the check is rebuilt only while it does not know them yet.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_line_classifications_kind_check'
                    AND pg_get_constraintdef(oid) LIKE '%loan_repayment%') THEN
    ALTER TABLE bank_line_classifications DROP CONSTRAINT IF EXISTS bank_line_classifications_kind_check;
    ALTER TABLE bank_line_classifications ADD CONSTRAINT bank_line_classifications_kind_check
      CHECK (kind IN ('account', 'transfer', 'expense', 'refund', 'charges', 'supplier', 'left',
                      'asset', 'asset_sale', 'loan', 'loan_repayment'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bank_line_classifications_one_register_idx
  ON bank_line_classifications (kind, ref_id) WHERE kind IN ('asset', 'asset_sale', 'loan', 'loan_repayment');

-- ── A journal line can be about a loan ────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_party_check'
                    AND pg_get_constraintdef(oid) LIKE '%''loan''%') THEN
    ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_party_check;
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_party_check
      CHECK (party_type IS NULL OR party_type IN ('customer', 'delivery_customer', 'vendor', 'loan'));
  END IF;
END $$;
