-- Delivery money found in an order's surplus after it was paid.
--
-- Written by hand in the style of 0002-0079. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- A customer who paid for product and delivery before the delivery charge
-- was entered (0078 only lets that be set before any payment) shows the
-- delivery as overpayment "held" for them. Finance or an admin records that
-- part of the surplus as delivery: it joins the order's delivery charge and
-- its total, so the order is square everywhere and the PFI's sales stay the
-- product alone (they already take delivery_fee back out).
--
-- delivery_from_surplus is the part of delivery_fee that came in this way.
-- The Finance Report takes it back off its order rows and totals, so the
-- figures it already printed do not move; it lists these in a block of their
-- own instead (owner's choice, 13 Oct 2026). Everything that recomputes the
-- fee from the rate adds it back on.
--
-- Nothing existing changes: a column at 0 on every order, and a new table.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_from_surplus numeric(15, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_from_surplus_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_delivery_from_surplus_check
      CHECK (delivery_from_surplus >= 0 AND delivery_from_surplus <= delivery_fee);
  END IF;
END $$;

-- Each time it was done: how much, why, who. Taken back by voiding, never
-- deleted.
CREATE TABLE IF NOT EXISTS order_surplus_deliveries (
  id               serial PRIMARY KEY,
  order_id         integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount           numeric(15, 2) NOT NULL CHECK (amount > 0),
  note             text NOT NULL DEFAULT '',
  recorded_by      integer REFERENCES staff(id) ON DELETE SET NULL,
  recorded_by_name varchar(255) NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  voided_by        integer REFERENCES staff(id) ON DELETE SET NULL,
  voided_by_name   varchar(255) NOT NULL DEFAULT '',
  void_reason      text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS order_surplus_deliveries_order_idx
  ON order_surplus_deliveries (order_id, id)
  WHERE voided_at IS NULL;
