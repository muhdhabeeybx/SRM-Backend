-- The whole chart of accounts: assets, liabilities, equity, income and cost of
-- sales, beside the cost accounts the expense form already uses.
--
-- Written by hand in the style of 0002-0080. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── One list, two names ───────────────────────────────────────────────────
--
-- expense_categories already IS the chart: 0007 gave it codes and 5010-6480
-- are in daily use. The desks keep calling these "Kind of cost" and
-- "Category"; Finance sees the same rows as the Chart of Accounts. So the rest
-- of the chart goes into the same table rather than a second one that would
-- have to be kept in step with it.
--
-- The new rows sit in their own groups (assets, liabilities, equity, income,
-- cost_of_sales), which lib/glAccounts.js never offers on the expense form
-- and resolveBooking refuses to book an expense to. Nothing a desk sees
-- changes.
--
-- ── What the columns are for ──────────────────────────────────────────────
--
--   system_key       the name the posting engine finds an account by
--                    ('customer_receivables', 'bank:54'), so Finance can
--                    rename or renumber it without breaking anything.
--   bank_account_id  the bank account a 11xx account stands for — one each,
--                    added here for every bank account that exists and by
--                    lib/accounting/chart.js for every one created after.
--                    Deleting the bank account takes its chart account with
--                    it; once the ledger has posted to it, the journal's own
--                    key refuses that delete.
--   cash_flow_class  operating | investing | financing, where the group's
--                    default is wrong for one account.
--   into_stock       a cargo cost that is part of the product's cost — it
--                    goes into the PFI's stock value, not straight to profit.
--
-- Nothing existing changes: three empty columns, and new rows.

ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS system_key varchar(60);
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS bank_account_id integer;
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS cash_flow_class varchar(20);
-- A cargo cost that is part of what the product cost us (freight, jetty,
-- survey, clearing, insurance): it goes into the PFI's stock value and cost
-- per litre, and reaches profit only as the litres are sold (the owner's
-- choice, 14 Oct 2026). Off for a cost of selling, like customer commission.
--
-- Set in the same step that adds the column, so a re-run never undoes an
-- account Finance has switched since. Every cargo cost goes in except what
-- is spent on selling, the customer commission (5410).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'expense_categories' AND column_name = 'into_stock') THEN
    ALTER TABLE expense_categories ADD COLUMN into_stock boolean NOT NULL DEFAULT false;
    UPDATE expense_categories SET into_stock = true
     WHERE gl_group = 'pfi_direct' AND gl_code IS DISTINCT FROM '5410';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_categories_bank_account_fk') THEN
    ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_bank_account_fk
      FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_categories_cash_flow_class_check') THEN
    ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_cash_flow_class_check
      CHECK (cash_flow_class IS NULL OR cash_flow_class IN ('operating', 'investing', 'financing'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_system_key_idx
  ON expense_categories (system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_bank_account_idx
  ON expense_categories (bank_account_id) WHERE bank_account_id IS NOT NULL;

-- ── The accounts the posting engine needs ─────────────────────────────────
--
-- Codes leave gaps, as 0007's did, so an account can be slotted in later
-- without renumbering. Skipped when the key — or a row of the same name — is
-- already there, so a re-run, or an account Finance has since renamed, is
-- left alone.

INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, system_key, cash_flow_class, is_system_category)
SELECT v.name, v.code, v.grp, v.sub, v.key, v.cash, false
  FROM (VALUES
    -- Assets. 1101-1199 are the bank accounts, below.
    ('Customer receivables',             '1200', 'assets',        'Receivables',  'customer_receivables', NULL),
    ('Trucking receivables',             '1210', 'assets',        'Receivables',  'trucking_receivables', NULL),
    ('Station takings not yet banked',   '1220', 'assets',        'Receivables',  'station_takings',      NULL),
    ('LPG plant takings not yet banked', '1230', 'assets',        'Receivables',  'plant_takings',        NULL),
    ('Stock – products',                 '1300', 'assets',        'Stock',        'stock',                NULL),
    ('Input VAT',                        '1400', 'assets',        'Tax',          'input_vat',            NULL),
    ('Trucks & equipment',               '1500', 'assets',        'Fixed assets', 'fixed_assets',         'investing'),
    ('Accumulated depreciation',         '1590', 'assets',        'Fixed assets', 'accumulated_depreciation', 'investing'),
    ('Suspense – money to be matched',   '1900', 'assets',        'Suspense',     'suspense',             NULL),
    -- Liabilities.
    ('Vendor payables',                  '2100', 'liabilities',   'Payables',     'vendor_payables',      NULL),
    ('Cargo supplier payables',          '2110', 'liabilities',   'Payables',     'supplier_payables',    NULL),
    ('Commissions payable',              '2200', 'liabilities',   'Payables',     'commissions_payable',  NULL),
    ('VAT payable to FIRS',              '2300', 'liabilities',   'Tax',          'vat_payable',          NULL),
    ('WHT payable to FIRS',              '2310', 'liabilities',   'Tax',          'wht_payable',          NULL),
    ('Loans',                            '2400', 'liabilities',   'Loans',        'loans',                'financing'),
    -- Equity.
    ('Share capital',                    '3100', 'equity',        '',             'share_capital',        'financing'),
    ('Retained earnings',                '3200', 'equity',        '',             'retained_earnings',    'financing'),
    ('Opening balance equity',           '3900', 'equity',        '',             'opening_balance_equity', 'financing'),
    -- Income.
    ('Sales – depot',                    '4100', 'income',        'Sales',        'sales_depot',          NULL),
    ('Sales – stations',                 '4110', 'income',        'Sales',        'sales_stations',       NULL),
    ('Sales – LPG plants',               '4120', 'income',        'Sales',        'sales_plants',         NULL),
    ('Sales – trucking',                 '4130', 'income',        'Sales',        'sales_trucking',       NULL),
    ('Delivery charges',                 '4200', 'income',        'Sales',        'delivery_charges',     NULL),
    ('Stock gains',                      '4300', 'income',        'Other income', 'stock_gains',          NULL),
    ('Other income',                     '4900', 'income',        'Other income', 'other_income',         NULL),
    -- Cost of sales the posting engine writes. The cargo costs (5010-5560)
    -- stay in pfi_direct, where the expense form books them.
    ('Cost of product sold',             '5001', 'cost_of_sales', '',             'cost_of_product_sold', NULL),
    ('Stock losses',                     '5002', 'cost_of_sales', '',             'stock_losses',         NULL),
    -- What a filling station or LPG plant spends out of its takings before
    -- banking them (delivery_sales.expenses_amount). An overhead, so on the
    -- expense form too, where a station cost paid by head office can go.
    ('Station running costs',            '6490', 'general',       'Station & Plant Costs', 'station_running_costs', NULL)
  ) AS v(name, code, grp, sub, key, cash)
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.system_key = v.key OR c.name = v.name)
   AND NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.gl_code = v.code);

-- Bank charges (6150) is already in the chart and in use on the expense form;
-- the ledger posts POS charges a station pays out of its takings to it too,
-- so it is given a key rather than a second account.
UPDATE expense_categories SET system_key = 'bank_charges'
 WHERE gl_code = '6150' AND system_key IS NULL
   AND NOT EXISTS (SELECT 1 FROM expense_categories WHERE system_key = 'bank_charges');

-- ── One account per bank account ──────────────────────────────────────────
--
-- Numbered from 1101 in the order the bank accounts were created, after any
-- bank code already taken, up to 1199. Named with the bank, the account name and the last
-- four digits, which is how the desks tell them apart.

INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, system_key, bank_account_id, is_system_category)
SELECT
  left(concat_ws(' · ', NULLIF(btrim(b.bank_name), ''), NULLIF(btrim(b.account_name), ''),
                 '••' || right(regexp_replace(COALESCE(b.account_number, ''), '\D', '', 'g'), 4))
       || CASE WHEN dup.n > 1 THEN ' #' || b.id ELSE '' END, 255),
  -- 1101-1199 hold ninety-nine. Past that an account has no code, and is
  -- still found by its key; Finance can number it on the chart.
  CASE WHEN base.top + ROW_NUMBER() OVER (ORDER BY b.id) <= 1199
       THEN (base.top + ROW_NUMBER() OVER (ORDER BY b.id))::text END,
  'assets', 'Bank accounts', 'bank:' || b.id, b.id, false
  FROM bank_accounts b
  CROSS JOIN (
    SELECT GREATEST(1100, COALESCE(MAX(gl_code::int), 1100)) AS top
      FROM expense_categories WHERE gl_code ~ '^11[0-9]{2}$'
  ) base
  -- Two accounts that would read the same get their id on the end, so the
  -- unique name never refuses one of them.
  CROSS JOIN LATERAL (
    SELECT COUNT(*) AS n FROM bank_accounts b2
     WHERE lower(btrim(b2.bank_name)) = lower(btrim(b.bank_name))
       AND lower(btrim(b2.account_name)) = lower(btrim(b.account_name))
       AND right(regexp_replace(COALESCE(b2.account_number, ''), '\D', '', 'g'), 4)
         = right(regexp_replace(COALESCE(b.account_number, ''), '\D', '', 'g'), 4)
  ) dup
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.bank_account_id = b.id);
