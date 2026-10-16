-- The bank line a transfer's money came out of, where it has been traced.
--
-- Written by hand in the style of 0002-0088. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- A transfer moves surplus, and surplus is not attributable to one line when
-- the giving order was paid by several — so the report names a source ref
-- only where the giving order had exactly one. Where somebody has traced the
-- money to a line (PFI 41, 16 Oct 2026: order 11424's ₦270,000 is what was
-- left of ₦10,000,000 credit 32930393157), this records it, and the report
-- names that line and its amount beside the transfer's own.
--
--   source_statement_line_id   the line the money arrived on, at the bank;
--                              the line stays claimed by the order it paid —
--                              this is a pointer, not a second claim
--
-- Nothing existing changes: one empty column.

ALTER TABLE order_payment_transfers ADD COLUMN IF NOT EXISTS source_statement_line_id integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_payment_transfers_source_line_fk') THEN
    ALTER TABLE order_payment_transfers ADD CONSTRAINT order_payment_transfers_source_line_fk
      FOREIGN KEY (source_statement_line_id) REFERENCES bank_statement_lines(id) ON DELETE SET NULL;
  END IF;
END $$;
