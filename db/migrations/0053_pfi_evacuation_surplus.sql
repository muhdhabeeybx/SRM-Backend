-- Evacuation surplus: product found in the tank when a PFI is run down, over
-- and above what the books say is left.
--
-- Written by hand in the style of 0002-0052. Idempotent, and convergent: it is
-- re-run in full every time by scripts/apply-unjournaled-migrations.js.
--
-- ── Why it is not folded into starting_qty_litres ─────────────────────────
--
-- starting_qty_litres is the tank figure measured when the cargo landed, and
-- lib/pfiFinance.js costs the cargo against it: BL surplus/deficit and the
-- deficit's cost both read it. An evacuation surplus is found weeks later, on
-- the last sales, and adding it to the landing figure would rewrite a cargo's
-- deficit after the fact. So it is its own quantity. It adds to what can be
-- SOLD and to nothing else:
--
--   sellable = starting_qty_litres + evacuation_surplus_litres - sold_qty_litres
--
-- ── Why entries, and a total on the PFI ───────────────────────────────────
--
-- Each surplus is a row — how much, the day it was found, why, and who said
-- so — because stock appearing from nowhere is exactly the figure somebody
-- will later ask about. A wrong one is voided, never deleted, so the record of
-- it having been entered survives.
--
-- The PFI carries the running total as well, maintained in the same
-- transaction as every entry and void (repositories/pfiSurplus.repository.js),
-- because roughly twenty places compute a PFI's balance and each is one
-- column away from being right rather than one join.

CREATE TABLE IF NOT EXISTS pfi_evacuation_surpluses (
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

CREATE INDEX IF NOT EXISTS pfi_evacuation_surpluses_live_idx
  ON pfi_evacuation_surpluses (pfi_id, recorded_on)
  WHERE voided_at IS NULL;

ALTER TABLE pfis
  ADD COLUMN IF NOT EXISTS evacuation_surplus_litres integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pfis_evacuation_surplus_check'
  ) THEN
    ALTER TABLE pfis
      ADD CONSTRAINT pfis_evacuation_surplus_check CHECK (evacuation_surplus_litres >= 0);
  END IF;
END $$;

COMMENT ON COLUMN pfis.evacuation_surplus_litres IS
  'Sum of the live rows in pfi_evacuation_surpluses. Adds to what can be sold (starting + surplus - sold); never to the landed tank figure the cargo is costed on.';

-- Convergent: the total is recomputed from the entries, so a re-run repairs a
-- drifted total rather than trusting it. On first apply there are no entries
-- and every PFI reads 0.
UPDATE pfis p
   SET evacuation_surplus_litres = COALESCE(s.total, 0)
  FROM (
    SELECT p2.id,
           (SELECT SUM(e.qty_litres)
              FROM pfi_evacuation_surpluses e
             WHERE e.pfi_id = p2.id AND e.voided_at IS NULL) AS total
      FROM pfis p2
  ) s
 WHERE p.id = s.id
   AND p.evacuation_surplus_litres IS DISTINCT FROM COALESCE(s.total, 0);
