-- Customer commission, as it is really paid.
--
-- Written by hand in the style of 0002-0083. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The owner's account of it (14 Oct 2026): money for commissions is requested
-- on an expense (5410 Customer Commission) and handed to a member of staff,
-- who pays each customer their commission out of it until it runs out. So
-- the 5410 expense is not the commission — it is money moved to somebody who
-- will pay it — and the commission is what each order earned its customer
-- (the commissions table).
--
-- In the books (lib/accounting/postingSources/commissions.js):
--
--   an order earns its customer a commission
--     Dr Customer Commission (5410)            Cr Commissions payable (the customer)
--   money is requested on 5410 and given to a member of staff
--     Dr Commission money with staff (1240)    Cr Vendor payables (whoever it was paid to)
--   the desk marks a customer's commission paid
--     Dr Commissions payable (the customer)    Cr Commission money with staff
--
-- What is left in 1240, PFI by PFI, is what staff still hold.
--
-- Nothing existing changes: one new account, and the posting engine's name
-- put on the account that is already 5410.

INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, system_key, is_system_category)
SELECT 'Commission money with staff', '1240', 'assets', 'Advances', 'commission_float', false
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories c
                    WHERE c.system_key = 'commission_float' OR c.name = 'Commission money with staff' OR c.gl_code = '1240');

UPDATE expense_categories SET system_key = 'customer_commission'
 WHERE gl_code = '5410' AND system_key IS NULL
   AND NOT EXISTS (SELECT 1 FROM expense_categories WHERE system_key = 'customer_commission');
