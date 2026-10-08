-- Operational loss: product that left a PFI's tank without being sold —
-- evaporation, spillage, a meter running over, a tank dip short of the books.
--
-- Written by hand in the style of 0002-0072. Idempotent, and convergent: it is
-- re-run in full every time by scripts/apply-unjournaled-migrations.js.
--
-- The mirror of the evacuation surplus (0053). A surplus adds to what can be
-- sold; a loss takes from it. Neither touches starting_qty_litres, the landed
-- tank figure the cargo is costed on, because a loss found weeks later must
-- not rewrite the landing deficit any more than a surplus may:
--
--   stock    = starting_qty_litres + evacuation_surplus_litres - operational_loss_litres
--   sellable = stock - sold_qty_litres
--
-- Entries, each with the day it was found, why and who said so, voided rather
-- than deleted; and the running total on the PFI, kept in the same
-- transaction as every entry and void (repositories/pfiLoss.repository.js),
-- for the same reason as the surplus: every balance reads one column.
--
-- Nothing existing changes: a new table, and a column that reads 0 on every
-- PFI until a loss is recorded.

CREATE TABLE IF NOT EXISTS pfi_operational_losses (
  id               serial PRIMARY KEY,
  pfi_id           integer NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,
  qty_litres       integer NOT NULL CHECK (qty_litres > 0),
  -- The day it was found. The CFO report counts it from this day on, so the
  -- days before it keep the balance they had.
  recorded_on      date NOT NULL,
  note             text NOT NULL DEFAULT '',
  recorded_by      integer REFERENCES staff(id) ON DELETE SET NULL,
  recorded_by_name varchar(255) NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  voided_by        integer REFERENCES staff(id) ON DELETE SET NULL,
  voided_by_name   varchar(255) NOT NULL DEFAULT '',
  void_reason      text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS pfi_operational_losses_live_idx
  ON pfi_operational_losses (pfi_id, recorded_on)
  WHERE voided_at IS NULL;

ALTER TABLE pfis
  ADD COLUMN IF NOT EXISTS operational_loss_litres integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pfis_operational_loss_check'
  ) THEN
    ALTER TABLE pfis
      ADD CONSTRAINT pfis_operational_loss_check CHECK (operational_loss_litres >= 0);
  END IF;
END $$;

COMMENT ON COLUMN pfis.operational_loss_litres IS
  'Sum of the live rows in pfi_operational_losses. Takes from what can be sold (starting + surplus - loss - sold); never from the landed tank figure the cargo is costed on.';

-- Convergent: the total is recomputed from the entries, so a re-run repairs a
-- drifted total rather than trusting it. On first apply every PFI reads 0.
UPDATE pfis p
   SET operational_loss_litres = COALESCE(s.total, 0)
  FROM (
    SELECT p2.id,
           (SELECT SUM(e.qty_litres)
              FROM pfi_operational_losses e
             WHERE e.pfi_id = p2.id AND e.voided_at IS NULL) AS total
      FROM pfis p2
  ) s
 WHERE p.id = s.id
   AND p.operational_loss_litres IS DISTINCT FROM COALESCE(s.total, 0);
