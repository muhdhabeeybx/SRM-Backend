-- Several orders at the same unit price can be folded into one.
--
-- Written by hand in the style of 0002-0055. Idempotent, and convergent: it is
-- re-run in full every time by scripts/apply-unjournaled-migrations.js.
--
-- ── What a merge does ──────────────────────────────────────────────────────
--
-- One order survives. Everything the others carry — payments, trucks,
-- tickets, PFI stock, refunds, commissions — is re-pointed at it, and its
-- quantity and value become the sum of theirs. See
-- services/orderMerge.service.js.
--
-- The others are NOT deleted. Each one's reference may already be on a bank
-- narration, an SMS or a paper ticket, and a reference that no longer resolves
-- to anything is worse than one that says where it went. So each becomes an
-- empty, Cancelled order carrying merged_into_order_id, and every screen that
-- opens it can send the reader on to the order that holds its history.
--
-- ── Why a table as well as the column ──────────────────────────────────────
--
-- The finance report is audited, and a merge moves payment rows from one
-- order to another — so the per-order rows that were signed off change. The
-- user chose to allow that on the condition that every merge is on the record
-- with its figures. order_merges is that record: what each order held
-- immediately before (quantity, value, money received, status) and what the
-- surviving order held immediately after, so an auditor can reconcile the old
-- rows to the new one line by line.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS merged_into_order_id integer
    REFERENCES orders(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS orders_merged_into_idx
  ON orders (merged_into_order_id) WHERE merged_into_order_id IS NOT NULL;

COMMENT ON COLUMN orders.merged_into_order_id IS
  'Set on an order that was folded into another. The order is Cancelled and holds nothing; its payments, trucks, tickets and stock are on the order named here. See order_merges.';

CREATE TABLE IF NOT EXISTS order_merges (
  id               serial      PRIMARY KEY,
  target_order_id  integer     NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  source_order_id  integer     NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- The source order as it stood the moment before it was merged.
  source_before    jsonb       NOT NULL,
  -- The surviving order before and after — the same on every row of one merge.
  target_before    jsonb       NOT NULL,
  target_after     jsonb       NOT NULL,
  -- Shared by the rows of a single merge, so "what went in together" is one
  -- query rather than a guess from timestamps.
  merge_group      uuid        NOT NULL,
  reason           text        NOT NULL DEFAULT '',
  merged_by        integer     REFERENCES staff(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_merges_distinct_check CHECK (source_order_id <> target_order_id)
);

-- An order is merged away once. There is nothing left on it to merge again.
CREATE UNIQUE INDEX IF NOT EXISTS order_merges_source_idx ON order_merges (source_order_id);
CREATE INDEX IF NOT EXISTS order_merges_target_idx ON order_merges (target_order_id);
