-- Close the orders on finished batches whose product demonstrably left.
--
-- Written by hand in the style of 0002-0033. Idempotent.
--
-- ── The sweep that produced this ───────────────────────────────────────────
--
-- 21 of 33 closed PFIs still carry work: 1,089 orders sitting at Paid,
-- Released or Loading, 5,286 trucks never gated in, and 95 recorded as still
-- standing on a yard months after their batch was closed out. None of it shows
-- in a queue any more — the badges and the desk nudges exclude closed batches —
-- but the records themselves are wrong, and this was an attempt to make them
-- right.
--
-- Most of it cannot be. Split by what the data actually proves:
--
--   9 orders     have trucks that GATED OUT. The product left; that is a
--                recorded physical event, not an inference. 6 of them are
--                missing the stock movement that should accompany it.
--   28 orders    have trucks, none gated out. Ambiguous.
--   1,052 orders have no trucks at all — never ticketed, 97,726,650 litres.
--
-- Only the first group is touched here.
--
-- ── Why the 1,052 are left exactly as they are ─────────────────────────────
--
-- Marking them Completed asserts they were fulfilled. Writing their stock
-- movements asserts 97.7 million litres physically left a tank. Neither is
-- knowable from this data: an order paid for and never ticketed looks
-- identical whether the product was delivered off the books or never went at
-- all. Writing either at that scale would put a fabrication into the record
-- and call it a cleanup, which is worse than the untidiness it replaces.
--
-- They need a person per batch, which is what the pre-close check added in
-- 0033's companion work now prevents from recurring.
--
-- Trucks are not touched either. Marking 5,286 as gated_out would invent 5,286
-- departures with timestamps, in the one part of the system whose value is
-- that a gate record means somebody saw the truck.

CREATE TEMP TABLE IF NOT EXISTS _departed ON COMMIT DROP AS
SELECT o.id, o.pfi_id, o.status,
       -- What the trucks that actually left were carrying, not the order's
       -- headline quantity: the movement should record what moved.
       (SELECT COALESCE(SUM(t.quantity), 0)::int
          FROM order_trucks t
         WHERE t.order_id = o.id AND t.status = 'gated_out') AS litres_out
FROM orders o
JOIN pfis p ON p.id = o.pfi_id
WHERE p.status = 'finished'
  AND o.status IN ('Paid', 'Released', 'Loading')
  AND EXISTS (
    SELECT 1 FROM order_trucks t
     WHERE t.order_id = o.id AND t.status = 'gated_out'
  );

-- The movement that should have been written when the trucks were ticketed.
INSERT INTO pfi_movements (pfi_id, order_id, action, qty_litres, notes, recorded_by)
SELECT d.pfi_id, d.id, 'RELEASE', d.litres_out,
       'Trucks gated out on a since-closed batch — backfilled (migration 0034)',
       NULL
FROM _departed d
WHERE d.pfi_id IS NOT NULL AND d.litres_out > 0
ON CONFLICT (order_id, action) DO NOTHING;

INSERT INTO audit_logs (entity_type, entity_id, action, prev_state, new_state, actor_type, metadata)
SELECT 'order', d.id, 'order.completed', o.status::text, 'Completed', 'system',
       jsonb_build_object(
         'trigger', 'backfill',
         'migration', '0034_close_out_departed_orders',
         'evidence', 'trucks gated out',
         'litresOut', d.litres_out
       )
FROM _departed d
JOIN orders o ON o.id = d.id;

UPDATE orders o
   SET status = 'Completed',
       completed_at = COALESCE(o.completed_at, now()),
       loading_started_at = COALESCE(o.loading_started_at, o.released_at, now()),
       updated_at = now()
  FROM _departed d
 WHERE d.id = o.id;
