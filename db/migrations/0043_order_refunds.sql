-- Overpayment goes back to the customer. It no longer moves between orders.
--
-- Written by hand in the style of 0002-0042. Idempotent.
--
-- ── What replaced what ─────────────────────────────────────────────────────
--
-- Surplus on an order used to be settled by moving it to another order
-- (order_payment_transfers, migration 0021). That is switched off at the API;
-- the 72 transfers already made stay exactly as they are — the finance report
-- is audited against them — and can still be reviewed or reversed.
--
-- Instead, an overpayment is REFUNDED, in two steps that are deliberately two
-- different facts:
--
--   requested  somebody has decided this money goes back, to this account.
--              Nothing about the order changes. Its surplus still shows,
--              because the money is still with us.
--   refunded   the money has actually been sent. Only now is a payment row
--              written against the order — negative, source 'refund' — and
--              the order's surplus falls to zero through the same arithmetic
--              that produced it.
--
-- A request that clears the balance before the money leaves would report a
-- customer as settled while they are still owed, which is the one mistake a
-- refund process must not be able to make.

CREATE TABLE IF NOT EXISTS order_refunds (
  id                  serial        PRIMARY KEY,
  order_id            integer       NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  customer_id         integer       NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount              numeric(15,2) NOT NULL,
  status              varchar(16)   NOT NULL DEFAULT 'requested',

  -- Where the money goes. Captured on the request because it is what the
  -- person making the payment needs, and a customer's bank details are not
  -- held anywhere else for this purpose.
  destination_bank    varchar(255)  NOT NULL DEFAULT '',
  destination_name    varchar(255)  NOT NULL DEFAULT '',
  destination_number  varchar(30)   NOT NULL DEFAULT '',
  reason              text          NOT NULL DEFAULT '',

  requested_by        integer       REFERENCES staff(id) ON DELETE SET NULL,
  requested_at        timestamptz   NOT NULL DEFAULT now(),

  -- Filled when the money has gone.
  paid_from_account_id integer      REFERENCES bank_accounts(id) ON DELETE SET NULL,
  payment_reference   varchar(255)  NOT NULL DEFAULT '',
  paid_at             timestamptz,
  paid_by             integer       REFERENCES staff(id) ON DELETE SET NULL,

  cancelled_at        timestamptz,
  cancelled_by        integer       REFERENCES staff(id) ON DELETE SET NULL,
  cancel_reason       text          NOT NULL DEFAULT '',

  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_amount_check') THEN
    ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_amount_check CHECK (amount > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_status_check') THEN
    ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_status_check
      CHECK (status IN ('requested', 'refunded', 'cancelled'));
  END IF;
  -- A refunded row must say when; the others must not claim to have been paid.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunds_paid_check') THEN
    ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_paid_check
      CHECK ((status = 'refunded') = (paid_at IS NOT NULL));
  END IF;
END $$;

-- One open request per order. Two would let the same surplus be paid twice,
-- and a race between two people raising one is exactly how that happens.
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_one_open_idx
  ON order_refunds (order_id) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS order_refunds_status_idx ON order_refunds (status);
CREATE INDEX IF NOT EXISTS order_refunds_customer_idx ON order_refunds (customer_id);

-- ── The payment row a refund writes ─────────────────────────────────────────

ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS refund_id integer REFERENCES order_refunds(id) ON DELETE RESTRICT;

-- 'refund' joins the sources. Replaced rather than added to, because a CHECK
-- cannot be amended in place; the old list is a strict subset, so every
-- existing row still satisfies it.
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_source_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_source_check
  CHECK (source IN ('statement', 'transfer_in', 'transfer_out', 'legacy', 'refund'));

-- Money leaving is negative, like the outgoing leg of a transfer, so what an
-- order holds stays a plain SUM with no case analysis anywhere above it.
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_sign_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_sign_check
  CHECK (
    (source IN ('transfer_out', 'refund') AND amount < 0)
    OR (source NOT IN ('transfer_out', 'refund') AND amount > 0)
  );

-- A refund row must point at its refund, and nothing else may.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_payments_refund_link_check') THEN
    ALTER TABLE order_payments ADD CONSTRAINT order_payments_refund_link_check
      CHECK ((source = 'refund') = (refund_id IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS order_payments_refund_unique
  ON order_payments (refund_id) WHERE refund_id IS NOT NULL;

-- Its own basis, so a refund is never read as the "unknown" provenance the
-- report ranks as the weakest there is.
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_confirmation_basis_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_confirmation_basis_check
  CHECK (confirmation_basis IN (
    'bank_matched', 'bank_inferred', 'auto_allocated',
    'no_record', 'transfer_desk', 'transfer_auto', 'unknown', 'refund_desk'
  ));

COMMENT ON TABLE order_refunds IS
  'Overpayment sent back to the customer. Requested first, refunded when the money has actually left; only then is a negative order_payments row (source refund) written and the surplus cleared. See services/orderRefund.service.js.';
