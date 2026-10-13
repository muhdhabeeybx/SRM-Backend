-- A delivery order's delivery charge, kept apart from the product.
--
-- Written by hand in the style of 0002-0077. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The owner's rule of 13 Oct 2026: on a delivery order the desk enters a
-- delivery rate per litre; the delivery charge is that rate times the litres,
-- and the order's total is the product (quantity x price) plus the delivery.
-- The customer pays the total, so payment, balances and overpayments work off
-- it as before. The price per unit is untouched.
--
-- Delivery is NOT the PFI's sales: every revenue, sales-value and profit
-- figure reads total_amount - delivery_fee (the product alone). Finance or an
-- admin may change the rate until a payment is recorded.
--
-- Nothing existing changes: two columns, both 0 on every order there is.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_rate numeric(15, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee  numeric(15, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_rate_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_delivery_rate_check CHECK (delivery_rate >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_fee_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_delivery_fee_check CHECK (delivery_fee >= 0);
  END IF;
END $$;

COMMENT ON COLUMN orders.delivery_rate IS
  'Delivery charge per litre on a delivery order (0 on pickup). Migration 0078.';
COMMENT ON COLUMN orders.delivery_fee IS
  'delivery_rate x quantity, included in total_amount; not product sales. Migration 0078.';
