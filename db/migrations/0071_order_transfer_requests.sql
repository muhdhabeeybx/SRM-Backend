-- Surplus moved between orders only once somebody else has approved it.
--
-- Written by hand in the style of 0002-0070. Idempotent. Adds a table and one
-- nullable column; no existing row is read or changed.
--
-- ── What this replaces ─────────────────────────────────────────────────────
--
-- Until now one finance person moved surplus from one order to another on
-- their own say: POST /orders/:id/payments/transfer wrote both legs the moment
-- it was asked, and was open only on PFI 39/26. The owner's rule of 7 October
-- 2026: finance REQUESTS the move, a named approver (the CFO, an admin, or any
-- super admin, never the person who asked) APPROVES it, and only then does the
-- money move. Undoing a transfer goes the same way.
--
-- ── A request is the trail ─────────────────────────────────────────────────
--
-- A row here is one request: from and to, how much, why, who asked and when,
-- who decided, when and what they said. Rejected and cancelled requests are
-- kept, as order_refunds keeps its cancellations. An approved one names the
-- order_payment_transfers row it became, and that row names it back, so a
-- payment leg on an order leads to the request that justified it.
--
-- The orders' figures are kept as they stood when the request was made and
-- when it was decided (`*_before`, `*_after`), so the trail says what the
-- approver was shown, not only what is true now.
--
-- ── Holding the money ──────────────────────────────────────────────────────
--
-- An open request holds its amount on the source order: a second request, or
-- a refund request, can only reach what is left. That is worked out from the
-- open rows here (status 'requested'); nothing is written to the order.

CREATE TABLE IF NOT EXISTS order_transfer_requests (
  id                   serial PRIMARY KEY,
  -- 'transfer' moves surplus; 'reversal' puts an approved transfer back.
  kind                 varchar(16) NOT NULL DEFAULT 'transfer',
  from_order_id        integer NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  to_order_id          integer NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  amount               numeric(15, 2) NOT NULL,
  reason               text NOT NULL,
  note                 text NOT NULL DEFAULT '',
  -- A reversal names the transfer it undoes.
  reverses_transfer_id integer REFERENCES order_payment_transfers (id) ON DELETE RESTRICT,
  status               varchar(16) NOT NULL DEFAULT 'requested',
  requested_by         integer REFERENCES staff (id) ON DELETE SET NULL,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  decided_by           integer REFERENCES staff (id) ON DELETE SET NULL,
  decided_at           timestamptz,
  decision_note        text NOT NULL DEFAULT '',
  -- The movement an approval made.
  transfer_id          integer REFERENCES order_payment_transfers (id) ON DELETE RESTRICT,
  -- The two orders as they stood when asked, and once decided.
  from_before          jsonb,
  to_before            jsonb,
  from_after           jsonb,
  to_after             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_transfer_requests_kind_check CHECK (kind IN ('transfer', 'reversal')),
  CONSTRAINT order_transfer_requests_status_check CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT order_transfer_requests_amount_check CHECK (amount > 0),
  CONSTRAINT order_transfer_requests_distinct_check CHECK (from_order_id <> to_order_id),
  CONSTRAINT order_transfer_requests_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT order_transfer_requests_reversal_check CHECK ((kind = 'reversal') = (reverses_transfer_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS order_transfer_requests_status_idx ON order_transfer_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS order_transfer_requests_from_idx   ON order_transfer_requests (from_order_id);
CREATE INDEX IF NOT EXISTS order_transfer_requests_to_idx     ON order_transfer_requests (to_order_id);

-- One open reversal per transfer: two would ask to give the same money back twice.
CREATE UNIQUE INDEX IF NOT EXISTS order_transfer_requests_one_open_reversal_idx
  ON order_transfer_requests (reverses_transfer_id) WHERE status = 'requested' AND kind = 'reversal';

-- A transfer made from a request names it. NULL on every transfer made before.
ALTER TABLE order_payment_transfers
  ADD COLUMN IF NOT EXISTS request_id integer REFERENCES order_transfer_requests (id) ON DELETE SET NULL;
