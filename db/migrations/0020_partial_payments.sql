-- Part payment: an order can be settled in instalments, and ticketed only up
-- to what has actually been paid for.
--
-- Written by hand in the style of 0002–0019, for the reason set out in 0003:
-- drizzle-kit has no snapshot of this database. Every statement is idempotent,
-- so re-running the file is a no-op.
--
-- ── What this is for ───────────────────────────────────────────────────────
--
-- A customer orders 100,000 litres but only wants to pay for 50,000 now. Until
-- now that was impossible to express: payment_status is a two-value enum, and
-- pay-an-order moved the ENTIRE total_amount out of the wallet in one go. The
-- desk's only options were to confirm the full amount against money that had
-- not landed, or to leave the order unpaid and unticketable.
--
-- After this, a payment records what was actually received, the order carries
-- the running total, and ticketing is capped at the quantity that total covers
-- (see releasableQuantity in services/order.service.js). Pay the rest later and
-- the remaining litres unlock.
--
-- ── 1. The third payment state ─────────────────────────────────────────────
--
-- 'Part Paid' sits between Unpaid and Paid: money has been received and the
-- order is live and ticketable, but a balance is still expected.
--
-- ADD VALUE is safe inside the implicit transaction the migration runner puts
-- this file in — Postgres has allowed that since 12, and the restriction that
-- remains (the new label cannot be USED until the transaction commits) does
-- not apply here, because nothing below writes it.
ALTER TYPE order_payment_status ADD VALUE IF NOT EXISTS 'Part Paid';

-- ── 2. What has actually been paid ─────────────────────────────────────────
--
-- Stored on the order rather than derived, for two reasons. The wallet hold is
-- the obvious candidate — it is the money committed to this order — but a hold
-- is released when an order is cancelled and converted to a debit row when it
-- completes, so it stops being readable as "what was paid" at exactly the
-- points the finance report still needs the figure. And the ticket ceiling is
-- checked under a row lock on this table on every generate-tickets call; making
-- that a join against wallet_holds or a sum over order_deposit_allocations puts
-- a second table in the hot path of a lock that is already held.
--
-- The check mirrors orders_total_check: a negative amount paid is meaningless.
-- It is deliberately NOT capped at total_amount — an overpayment against an
-- order is a real thing this system already records (see the finance report's
-- differential), and a constraint that rejected it would turn a reportable
-- fact into a failed request.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS amount_paid numeric(15, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_amount_paid_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_amount_paid_check CHECK (amount_paid >= 0);
  END IF;
END $$;

-- ── 3. Backfill ────────────────────────────────────────────────────────────
--
-- Every order already marked Paid was, under the old all-or-nothing rule, paid
-- in full and for its whole quantity — that is precisely what 'Paid' meant
-- before this migration. So its amount_paid is its total_amount, and its
-- releasable quantity comes out as the full order quantity, leaving ticketing
-- on historical orders behaving exactly as it does today.
--
-- Unpaid orders keep the 0 default. Guarded on amount_paid = 0 so a re-run
-- cannot overwrite a figure a part payment has since moved.
--
-- `total_amount > 0` writes nothing different — setting amount_paid to a total
-- of 0 on a row already holding 0 is a no-op — but it stops this statement
-- TOUCHING such a row, and that distinction is the whole point.
--
-- 0049 added orders_priced_has_price_check as NOT VALID precisely because one
-- production order violates it: LN4378 (id 4378), marked Paid and priced at
-- 0.00, an anomaly from March 2026 left alone deliberately. NOT VALID exempts
-- it while it sits still, but any UPDATE that touches the row re-checks it. So
-- this six-month-old backfill began failing the moment 0049 landed, and
-- because apply-unjournaled-migrations runs the files in order, the whole
-- chain stopped here — 0050 never applied.
UPDATE orders
SET amount_paid = total_amount
WHERE payment_status = 'Paid'
  AND amount_paid = 0
  AND total_amount > 0;

-- Read by the finance report to list orders with a balance outstanding, and by
-- the payable-orders desk. Partial index: fully-paid orders are the bulk of the
-- table and are never the ones being looked for here.
CREATE INDEX IF NOT EXISTS orders_amount_paid_idx
  ON orders (payment_status, amount_paid)
  WHERE payment_status <> 'Paid';
