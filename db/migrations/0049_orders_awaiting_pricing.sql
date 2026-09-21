-- An order can exist before anyone has agreed what it costs.
--
-- Written by hand in the style of 0002-0048. Idempotent.
--
-- ── The practice ──────────────────────────────────────────────────────────
--
-- A manually written ticket usually carries no price. The customer is given
-- the ticket, the truck loads, and the invoice follows days later when the
-- number is agreed. The sale is real from the moment the truck leaves; only
-- the figure is outstanding.
--
-- placeOrder() refuses this outright — "No price configured for this product
-- at this depot" — because it resolves the price server-side and treats its
-- absence as a misconfiguration rather than a state.
--
-- ── Why not simply store 0 ────────────────────────────────────────────────
--
-- Because 0 does not mean "unknown" in this schema. It means free, and every
-- consumer reads it that way:
--
--   - findReceivables filters on (total_amount - amount_paid) > 0, so a
--     zero-valued order computes as owing nothing and DISAPPEARS from the one
--     list built to catch product that left unpaid;
--   - releasableQuantity divides by price;
--   - commissionQuantity divides by price;
--   - every naira total silently adds nothing against real litres.
--
-- A flag nobody can divide by, and nobody can accidentally sum, is the only
-- honest representation. pricing_status is the truth; on a pending order the
-- zeros in price and total_amount are placeholders and are never money.
--
-- ── Default 'priced' is the whole backfill ────────────────────────────────
--
-- Every order that exists today was priced at creation — placeOrder could not
-- have made it otherwise — so the default states a fact about all 7,661 rows
-- rather than guessing at one. No UPDATE is needed and none is run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_pricing_status') THEN
    CREATE TYPE order_pricing_status AS ENUM ('priced', 'pending');
  END IF;
END $$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pricing_status order_pricing_status NOT NULL DEFAULT 'priced';

-- Who is waiting on a number, oldest first. Partial: the rows that matter are
-- the few awaiting a price, not the tens of thousands that have one.
CREATE INDEX IF NOT EXISTS orders_awaiting_pricing_idx
  ON orders (created_at)
  WHERE pricing_status = 'pending';

-- A priced order must actually carry a price. This is the invariant that stops
-- the flag and the figures drifting apart: flipping an order to 'priced'
-- without setting a real price would put it back in the silent-zero state this
-- migration exists to abolish, and the constraint refuses that write outright.
--
-- Stated as "priced implies price > 0" rather than as an equality, because a
-- PENDING order is allowed to carry anything (it carries zeros) — it is only
-- the claim of being priced that has to be earned.
--
-- ── NOT VALID, and why that is the honest choice ──────────────────────────
--
-- Production already holds one row that violates this: order 4378 (LN4378,
-- 5 March 2026, customer Eno, Soroman Depot Calabar) — 45,000 litres, price
-- 0.00, total 0.00, and marked Paid. It is a genuine anomaly and it predates
-- everything here by six months.
--
-- Two ways to get the constraint on, and only one of them is defensible.
-- Reclassifying that row as 'pending' would make it pass, and would even be
-- arguably true — nobody ever priced it — but it silently rewrites the meaning
-- of a settled finance record to suit a migration, which is not a migration's
-- business. NOT VALID instead: the constraint is enforced on every insert and
-- update from here on, and the existing row is left exactly as it is for
-- somebody to look at deliberately.
--
-- To adopt it later, once that order has been dealt with:
--   ALTER TABLE orders VALIDATE CONSTRAINT orders_priced_has_price_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_priced_has_price_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_priced_has_price_check CHECK (
      pricing_status <> 'priced' OR price > 0
    ) NOT VALID;
  END IF;
END $$;

-- When the number was finally agreed, and by whom. Nullable forever on an
-- order that was priced at creation, which is almost all of them — the absence
-- is meaningful, not missing data.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS priced_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS priced_by integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_priced_by_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_priced_by_fkey
      FOREIGN KEY (priced_by) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;
