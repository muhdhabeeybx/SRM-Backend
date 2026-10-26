-- What a hired truck's owner has been paid for a trip, and through which
-- payment request.
--
-- Written by hand in the style of 0002-0097. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- A third party's truck (0094) is costed at the haulage its owner charges, and
-- the owner is paid that less the AGO they took from us. The owner is paid
-- through Expenses — an advance across several trucks ("₦20m for 20 trucks"),
-- then the balance — as a Transportation/Haulage request raised from Delivery
-- Costing (services/ownerPayments.service.js). Each row here is one truck's
-- part of one such request:
--
--   expense_id   the request
--   trip_id      the truck's trip (delivery_inventory)
--   kind         advance | balance
--   share        what was asked for this truck when the request was raised
--
-- A truck's part of a request is the request's amount × share ÷ the request's
-- shares, read at the time — so a request finance corrects in Expenses is
-- still spread the same way, and its parts still add up to it. A rejected or
-- deleted request pays nothing.
--
-- Counted once (lib/tripCosts.js): the haulage counts on the truck less what
-- is already PAID to the owner, because the PFI's paid expenses carry that.

CREATE TABLE IF NOT EXISTS trip_owner_payments (
  id          serial PRIMARY KEY,
  expense_id  integer NOT NULL REFERENCES pfi_expenses(id) ON DELETE CASCADE,
  trip_id     integer NOT NULL REFERENCES delivery_inventory(id) ON DELETE CASCADE,
  kind        varchar(10) NOT NULL CHECK (kind IN ('advance', 'balance')),
  share       numeric(15, 2) NOT NULL CHECK (share > 0),
  created_by  integer REFERENCES staff(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trip_owner_payments_expense_trip_idx
  ON trip_owner_payments (expense_id, trip_id);

CREATE INDEX IF NOT EXISTS trip_owner_payments_trip_idx
  ON trip_owner_payments (trip_id);

-- The rate a hired truck's owner charges per litre carried (the user,
-- 2026-10-26: "they give us rate per litre, then we get the total haulage").
-- The trip's haulage is this rate × the litres loaded, worked out wherever it
-- is read (lib/tripCosts.js), so a corrected load moves the haulage with it.
-- haulage_amount stays for a lump sum typed before the rate existed; a rate,
-- once entered, is what counts.
ALTER TABLE delivery_inventory
  ADD COLUMN IF NOT EXISTS haulage_rate numeric(14, 4);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_inventory_haulage_rate_check') THEN
    ALTER TABLE delivery_inventory
      ADD CONSTRAINT delivery_inventory_haulage_rate_check CHECK (haulage_rate IS NULL OR haulage_rate >= 0);
  END IF;
END $$;
