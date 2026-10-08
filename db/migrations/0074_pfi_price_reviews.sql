-- Price reviews: a PFI's price per litre changed after it was raised — the
-- supplier reviewed it, a new invoice superseded the first.
--
-- Written by hand in the style of 0002-0073. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The reviewed price becomes the PFI's price. pfis.unit_price is set to it in
-- the same transaction as the entry (repositories/pfiPrice.repository.js), so
-- the cargo value, the landing cost and the profit — all computed live from
-- unit_price by lib/pfiFinance.js — move with it, and nothing that reads the
-- price has to learn about reviews.
--
-- What is kept here is the record: each entry holds the price it replaced, so
-- the initial price and every price after it stay on the PFI's file and its
-- report. Taken back by voiding, never deleted; only the latest live review
-- can be taken back, and doing so puts the price it replaced back on the PFI.
--
-- Nothing existing changes: a new table, and no column on pfis.

CREATE TABLE IF NOT EXISTS pfi_price_reviews (
  id               serial PRIMARY KEY,
  pfi_id           integer NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,
  -- The reviewed price per unit, and the one it replaced.
  price            numeric(15, 2) NOT NULL CHECK (price > 0),
  previous_price   numeric(15, 2) NOT NULL DEFAULT 0,
  -- The day the new price applies from.
  effective_on     date NOT NULL,
  note             text NOT NULL DEFAULT '',
  recorded_by      integer REFERENCES staff(id) ON DELETE SET NULL,
  recorded_by_name varchar(255) NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  voided_by        integer REFERENCES staff(id) ON DELETE SET NULL,
  voided_by_name   varchar(255) NOT NULL DEFAULT '',
  void_reason      text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS pfi_price_reviews_live_idx
  ON pfi_price_reviews (pfi_id, id)
  WHERE voided_at IS NULL;

COMMENT ON TABLE pfi_price_reviews IS
  'Each change to a PFI''s price per unit after it was raised, with the price it replaced. The latest live entry''s price is pfis.unit_price.';
