-- Clear up the commissions that were raised without a rate.
--
-- Written by hand in the style of 0002-0034. Idempotent.
--
-- ── Why they exist ─────────────────────────────────────────────────────────
--
-- createForOrder fell back to a rate of 0 when a depot and product had none
-- configured, and created the commission anyway. So every order at a location
-- that pays no commission raised a N0 row: it sat in the desk's pending queue
-- forever, and the customer was shown a commission they were never going to be
-- paid. The service no longer does this — no rate now means no row.
--
-- 160 exist, and they are two different faults wearing the same face:
--
--   44 at depots with NO rate configured. Dangote Refinery has none for
--      Petrol, Diesel or Cooking Gas. There was never a promise here, so the
--      honest record is no row at all. Deleted.
--
--   116 at depots that DO have a rate — Calabar, Liquid Bulk, Keonamex,
--       Avidor, TSL. These were raised before somebody set the rate and were
--       never revisited, because nothing looked back at existing commissions
--       when a rate changed. They are real promises priced at zero. Repriced.
--
-- ── What is not touched ────────────────────────────────────────────────────
--
-- Anything already paid. A paid commission settled at the rate in force when
-- it was paid; repricing that is not a recalculation, it is a rewrite of what
-- somebody was told they were getting. There are none at zero anyway.
--
-- Skipped rows are left too: somebody decided those, and a decision is not a
-- pricing error.

-- Repriced first, while the deletable set is still identifiable by having no
-- rate at all.
UPDATE commissions c
   SET commission_rate = r.commission_rate,
       commission_amount = ROUND(c.quantity * r.commission_rate, 2),
       updated_at = now()
  FROM depot_product_commissions r
 WHERE r.depot_id = c.depot_id
   AND r.product_id = c.product_id
   AND c.status = 'pending'
   AND c.commission_rate::numeric = 0
   AND r.commission_rate::numeric > 0;

-- And the ones with no rate behind them at all.
DELETE FROM commissions c
 WHERE c.status = 'pending'
   AND c.commission_rate::numeric = 0
   AND NOT EXISTS (
     SELECT 1 FROM depot_product_commissions r
      WHERE r.depot_id = c.depot_id
        AND r.product_id = c.product_id
        AND r.commission_rate::numeric > 0
   );
