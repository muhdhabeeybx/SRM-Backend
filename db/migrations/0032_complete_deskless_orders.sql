-- Complete the gantry and delivery orders that were already paid for.
--
-- Written by hand in the style of 0002-0031. Idempotent: every statement is
-- restricted to rows still in the old state, so re-running the file changes
-- nothing.
--
-- ── Why ────────────────────────────────────────────────────────────────────
--
-- A gantry lifting and a delivery batch have no loading desk and no gate.
-- Nobody at the depot issues their tickets or admits their trucks, so the
-- Loading and Completed states existed for them and nobody was ever going to
-- move them. 1,536 fully-paid orders sat at Released waiting on a desk that
-- does not handle them.
--
-- Payment completes them from now on (services/order.service.js,
-- completeDesklessOrder). This is the same act applied backwards, once, to the
-- orders raised before that.
--
-- ── Stock is the substantive half ──────────────────────────────────────────
--
-- Stock leaves a PFI at ticket generation — that is where the RELEASE movement
-- is written, and where "litres loaded" on every report comes from. 1,451 of
-- these orders never had one, so their batches read as sold-but-not-loaded:
-- 94,471,355 litres sold with no record of leaving. Those rows are written
-- here, which is what makes the reports agree with themselves.
--
-- The other 85 already carry a movement (they were ticketed by hand before
-- anybody noticed the desk did not apply to them) and are left alone by the
-- NOT EXISTS — writing a second row would deduct their batch twice.
--
-- ── Done in SQL, deliberately ──────────────────────────────────────────────
--
-- Not by calling the service in a loop. transition() announces every move, and
-- 1,536 orders through it is 1,536 notifications to customers about orders
-- they received weeks ago. The state change is what is wanted; the
-- announcement is not.
--
-- ── What is NOT touched ────────────────────────────────────────────────────
--
--   85 already Completed, 35 Cancelled, 7 Pending (never paid), and 1
--   Released that is only part paid. An order that is not fully paid does not
--   complete here for the same reason it does not complete on the live path:
--   the business is not finished with an order still owing money.
--
--   No truck rows are created. Nothing is recorded as having arrived at or
--   departed from a gate, because nothing did.

-- The set, fixed once so the movement rows and the status update cannot
-- disagree if a payment lands while this runs.
CREATE TEMP TABLE IF NOT EXISTS _deskless_paid ON COMMIT DROP AS
SELECT o.id, o.pfi_id, o.quantity, p.pfi_type
FROM orders o
JOIN pfis p ON p.id = o.pfi_id
WHERE p.pfi_type IN ('gantry', 'delivery')
  AND o.payment_status = 'Paid'
  AND o.status IN ('Paid', 'Released', 'Loading');

-- The stock that left and was never recorded as leaving.
INSERT INTO pfi_movements (pfi_id, order_id, action, qty_litres, notes, recorded_by)
SELECT d.pfi_id, d.id, 'RELEASE', d.quantity,
       d.pfi_type || ' order — no loading desk, backfilled (migration 0032)',
       NULL
FROM _deskless_paid d
WHERE d.pfi_id IS NOT NULL
  AND d.quantity > 0
ON CONFLICT (order_id, action) DO NOTHING;

-- One audit row per order, so the change is answerable for later. Written
-- before the update, while prev_state is still true.
INSERT INTO audit_logs (entity_type, entity_id, action, prev_state, new_state, actor_type, metadata)
-- prev_state/new_state are plain varchar and hold the status itself, matching
-- every order.completed row transition() has ever written.
SELECT 'order', d.id, 'order.completed',
       o.status::text,
       'Completed',
       'system',
       jsonb_build_object(
         'trigger', 'backfill',
         'migration', '0032_complete_deskless_orders',
         'pfiType', d.pfi_type,
         'reason', 'gantry and delivery orders have no loading desk or gate'
       )
FROM _deskless_paid d
JOIN orders o ON o.id = d.id;

UPDATE orders o
   SET status = 'Completed',
       completed_at = COALESCE(o.completed_at, now()),
       -- Loading is a state these orders passed through in name only; stamped
       -- so the lifecycle timestamps are not left with a hole in the middle.
       loading_started_at = COALESCE(o.loading_started_at, o.released_at, now()),
       updated_at = now()
  FROM _deskless_paid d
 WHERE d.id = o.id;
