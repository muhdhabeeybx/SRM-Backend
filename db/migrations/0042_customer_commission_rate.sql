-- A commission rate that belongs to the customer, not to the depot.
--
-- Written by hand in the style of 0002-0041. Idempotent.
--
-- ── What this is for ───────────────────────────────────────────────────────
--
-- Commission is configured per depot and product — five pairs, all at ₦1.00
-- per litre. Some customers are on ₦2.00 by agreement, and there was nowhere
-- to record that: the rate is looked up from depot_product_commissions and the
-- customer is not part of the key. The only way to pay one was to edit the
-- depot's rate, which pays it to everybody buying there.
--
-- One nullable column, because the agreement is with the customer and applies
-- wherever they buy. NULL means "no agreement — use the usual rate for the
-- depot and product", which is a different fact from 0.00, and 0.00 is a
-- legitimate value meaning "this customer earns nothing". A NOT NULL DEFAULT 0
-- here would have made every customer in the book an explicit zero-commission
-- agreement overnight.
--
-- ── Why the rate is still snapshotted on every commission row ──────────────
--
-- It always was, and that does not change: commissions.commission_rate is what
-- the order was actually settled at. This column only decides what the NEXT
-- order snapshots. Changing it never rewrites a paid commission — see
-- services/commission.service.js.
--
-- ── rate_source ────────────────────────────────────────────────────────────
--
-- A ₦2.00 row sitting in a column of ₦1.00 rows looks like a keying error, and
-- the desk cannot tell an agreed rate from a typo without asking somebody. So
-- each commission records WHERE its rate came from. Defaulted to
-- 'depot_product' rather than left null: every row that already exists was
-- priced from the depot table, so that is not a guess, it is what happened.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS commission_rate numeric(15, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_commission_rate_check'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_commission_rate_check
      CHECK (commission_rate IS NULL OR commission_rate >= 0);
  END IF;
END $$;

COMMENT ON COLUMN customers.commission_rate IS
  'Per-litre commission agreed with this customer, overriding depot_product_commissions wherever they buy. NULL means no agreement — use the depot+product rate. 0 means this customer earns nothing, which is not the same thing.';

ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS rate_source varchar(20) NOT NULL DEFAULT 'depot_product';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commissions_rate_source_check'
  ) THEN
    ALTER TABLE commissions
      ADD CONSTRAINT commissions_rate_source_check
      CHECK (rate_source IN ('customer', 'depot_product', 'none'));
  END IF;
END $$;

-- The rows raised with no rate configured at all. They carry rate 0 and the
-- skipped status already; naming the source keeps "nobody set a rate" apart
-- from "the depot pays nothing", which both read as ₦0.00 otherwise.
UPDATE commissions
   SET rate_source = 'none'
 WHERE status = 'skipped'
   AND commission_rate = 0
   AND skip_reason = 'No commission rate set for this location and product'
   AND rate_source <> 'none';

COMMENT ON COLUMN commissions.rate_source IS
  'Where this row''s rate came from: the customer''s own agreed rate, the depot+product table, or nowhere. See services/commission.service.js.';

-- The commissions page filters by customer constantly, and the override sweep
-- (recomputeForCustomer) reads exactly this.
CREATE INDEX IF NOT EXISTS commissions_customer_status_idx
  ON commissions (customer_id, status);
