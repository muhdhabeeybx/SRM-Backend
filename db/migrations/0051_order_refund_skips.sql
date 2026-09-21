-- An overpayment can be set aside instead of refunded.
--
-- Written by hand in the style of 0002-0050. Idempotent, and convergent: it is
-- re-run in full every time by scripts/apply-unjournaled-migrations.js.
--
-- ── Why a refund list needs a way to say "not this one" ────────────────────
--
-- 179 orders hold money beyond their value. Twenty-five of them hold less than
-- ₦1,000 and nine less than ₦100 — a bank transfer costs more to make than the
-- sums involved, and some of the larger ones were already settled by moving
-- the money to another order back when that was how it was done.
--
-- With only "refund it" on offer, every one of those stays on the list for
-- ever. A list that cannot be cleared stops being read, and the ₦1.4bn that
-- genuinely is owed sits among rows nobody intends to act on.
--
-- ── Why it is a refund row and not a column on the order ──────────────────
--
-- Setting one aside is a decision somebody makes, with a reason, at a time,
-- and it is reversible. That is exactly what order_refunds already records —
-- who, when, why, against which order, for how much. A boolean on `orders`
-- would hold the decision and lose the person, the moment and the grounds.
--
-- The amount is the surplus AT THE TIME. That is what makes the decision
-- reviewable: if more money arrives later, the surplus no longer matches what
-- was set aside, and the order comes back onto the list rather than staying
-- hidden behind a judgement made about a smaller sum.
ALTER TABLE order_refunds DROP CONSTRAINT IF EXISTS order_refunds_status_check;

ALTER TABLE order_refunds
  ADD CONSTRAINT order_refunds_status_check
  CHECK (status IN ('requested', 'refunded', 'cancelled', 'skipped'));

COMMENT ON COLUMN order_refunds.status IS
  'requested → refunded | cancelled, or skipped: an overpayment deliberately not refunded, with the reason in `reason` and the surplus at that moment in `amount`. A skip is lifted by cancelling it, which keeps the decision on the record.';

-- One live skip per order, the same shape as the one open request per order.
-- A cancelled skip is history and does not block a new one.
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_one_skip_per_order
  ON order_refunds (order_id) WHERE status = 'skipped';

/*
  ── Verification ─────────────────────────────────────────────────────────

  Nothing above touches a row: the check is widened, never narrowed, and the
  index is partial on a status no row can hold yet. Both existing statuses
  must still be legal.
*/
DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM order_refunds
   WHERE status NOT IN ('requested', 'refunded', 'cancelled', 'skipped');

  IF bad > 0 THEN
    RAISE EXCEPTION 'Migration 0051 left % refund row(s) outside the status constraint. Rolling back.', bad;
  END IF;
END $$;
