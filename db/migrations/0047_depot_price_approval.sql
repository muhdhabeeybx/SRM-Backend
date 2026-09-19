-- A price does not go live because one person typed it.
--
-- Written by hand in the style of 0002-0046. Idempotent.
--
-- ── What a price actually is here ──────────────────────────────────────────
--
-- depot_product_prices.current_price is what an order is priced from — see
-- order.service.js, which reads it as the server price and refuses to take the
-- client's — and what the public catalogue shows. So a number typed on the
-- pricing page was live the instant it saved, everywhere, with nothing between
-- the typing and the selling.
--
-- depot_price_history already existed and recorded price and time. It could
-- not say who, and there was no second act to record, because there was no
-- second act.
--
-- ── The proposal is the record ─────────────────────────────────────────────
--
-- A row here IS the change: what it was, what is asked for, who asked, who
-- decided, and when each happened. Rejected and superseded rows are kept for
-- the same reason approved ones are — "why is PMS still 950" is answered by
-- the change that was refused, not by its absence.
--
-- current_price is untouched until a change is approved, so a depot goes on
-- selling at the price it had while a new one waits.
CREATE TABLE IF NOT EXISTS depot_price_changes (
  id                 serial PRIMARY KEY,
  depot_id           integer NOT NULL REFERENCES depots(id)   ON DELETE CASCADE,
  product_id         integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- What it was when this was asked for. NULL when the product had no price
  -- at all: that is a first price, not a change, and 0 would claim it was
  -- being sold for nothing.
  previous_price     numeric(15,2),
  proposed_price     numeric(15,2) NOT NULL CHECK (proposed_price >= 0),
  status             varchar(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','superseded')),
  requested_by       integer,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_by        integer,
  reviewed_at        timestamptz,
  review_note        text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE depot_price_changes IS
  'Every proposed change to a depot product price and what became of it. current_price is only ever moved by approving a row here.';

-- One price can be waiting per depot+product. A second proposal supersedes the
-- first rather than queueing behind it: two pending prices for one product is
-- a question nobody can answer, and the later one is what is meant.
CREATE UNIQUE INDEX IF NOT EXISTS depot_price_changes_one_pending_idx
  ON depot_price_changes (depot_id, product_id)
  WHERE status = 'pending';

-- The two reads this table has: what is waiting, and what happened here.
CREATE INDEX IF NOT EXISTS depot_price_changes_pending_idx
  ON depot_price_changes (requested_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS depot_price_changes_depot_idx
  ON depot_price_changes (depot_id, product_id, requested_at DESC);

-- ── The old trail keeps working, and learns who ────────────────────────────
--
-- depot_price_history is still written on approval so anything already reading
-- it is unaffected. It gains the change that produced the row, which is where
-- the names live, rather than duplicating them.
ALTER TABLE depot_price_history
  ADD COLUMN IF NOT EXISTS change_id integer REFERENCES depot_price_changes(id) ON DELETE SET NULL;
