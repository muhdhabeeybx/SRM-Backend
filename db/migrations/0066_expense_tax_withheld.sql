-- VAT is withheld from the vendor, and an invoice may carry untaxed lines.
--
-- Written by hand in the style of 0002-0065. Idempotent.
--
-- ── VAT withheld ───────────────────────────────────────────────────────────
--
-- Until now a request paid the vendor the invoice total less WHT, so the VAT
-- went to the vendor. It no longer does: like WHT, the VAT on an invoice is
-- kept back and paid to the tax office by us. The vendor receives
--
--     amount before VAT − WHT + untaxed items
--
-- and WHT is still worked out on the amount before VAT.
--
-- `vat_withheld` says which rule a row was raised under. Every row already in
-- the table was raised under the old one, so it defaults to false and nothing
-- is backfilled: on those rows the vendor was paid the VAT, and the tax report
-- must not ask anyone to remit it a second time. New rows are written with it
-- set by the request form.
--
-- ── Untaxed items ──────────────────────────────────────────────────────────
--
-- An invoice often carries lines no tax applies to — logistics, a
-- reimbursed cost. They are paid to the vendor in full. `untaxed_items` keeps
-- each line ([{ "description": text, "amount": number }]) and
-- `untaxed_amount` their sum, so totals can be read without unpacking JSON.
-- The invoice total includes them; neither VAT nor WHT is worked on them.

ALTER TABLE pfi_expenses
  ADD COLUMN IF NOT EXISTS vat_withheld boolean NOT NULL DEFAULT false;

ALTER TABLE pfi_expenses
  ADD COLUMN IF NOT EXISTS untaxed_items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE pfi_expenses
  ADD COLUMN IF NOT EXISTS untaxed_amount numeric(15, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pfi_expenses_untaxed_amount_check'
  ) THEN
    ALTER TABLE pfi_expenses
      ADD CONSTRAINT pfi_expenses_untaxed_amount_check CHECK (untaxed_amount >= 0);
  END IF;
END $$;
