-- Make a delivery allocation a first-class PFI.
--
-- Written by hand in the style of 0002-0026, for the reason set out in 0003:
-- drizzle-kit has no snapshot of this database. Every statement is idempotent,
-- so re-running the file is a no-op.
--
-- ── What exists today ──────────────────────────────────────────────────────
--
-- `delivery_inventory` holds 257 truck rows grouped by a free-text
-- `allocation_code` — PFI-40B, PFI-36C, PFI-25C and three others. Each group
-- is, in every respect that matters, already a PFI: product loaded from one
-- depot, drawn on by other locations, carried out on trucks. PFI-25C is 61
-- trucks and 2,995,000 litres.
--
-- What it is NOT is a row in `pfis`, so none of the machinery that hangs off a
-- PFI reaches it. No landing cost, no sell-through, no expense chart, no line
-- in the finance report's stock summary, no profit. Two of the six codes do
-- not even carry a `pfi_number`, so the link back is a string that may or may
-- not have been typed.
--
-- ── What this changes ──────────────────────────────────────────────────────
--
-- A delivery allocation becomes a PFI of type 'delivery'. It is the same
-- table, deliberately: everything that reads a PFI — the stock summary, the
-- expense chart, the sales ledger, the finance report — then works on it
-- without being taught a second concept. What a delivery PFI needs beyond a
-- coastal one is two things a cargo does not have:
--
--   which locations may draw on it   a coastal batch is sold out of the depot
--                                    it landed at; a delivery allocation is
--                                    loaded at one depot and sold at several
--   which trucks carry it, and       a coastal batch's quantity is measured
--   how much each ACTUALLY took      into a tank; a delivery allocation's is
--                                    the sum of what the trucks actually
--                                    loaded, which is not their capacity
--
-- Both get their own table rather than a jsonb column on `pfis`, because both
-- are joined against: "which batches can Bauchi sell from" and "how much has
-- this truck carried" are the two questions the page exists to answer, and
-- neither is answerable against a JSON blob without scanning every row.

-- ── 1. The third type ─────────────────────────────────────────────────────
--
-- Dropped and recreated rather than skipped when present, so a database that
-- already holds the two-value constraint is corrected by re-running this file.

--
-- ── Re-running this must not narrow a list a later migration widened ──────
--
-- Every hand-written migration here is re-run in full by
-- scripts/apply-unjournaled-migrations.js, so each has to be convergent and
-- not merely idempotent. 0045 added a fourth type, 'trucking'. Once a batch
-- of trucks exists, dropping and recreating the three-value constraint fails
-- against those rows — and because the applier runs the files in order, the
-- whole chain stops HERE, so a later migration (0050) never gets applied.
-- That is a broken deploy caused by a file that has been applied for months.
--
-- So: correct a database still holding the two-value constraint, and leave a
-- widened one alone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pfis WHERE pfi_type NOT IN ('coastal', 'gantry', 'delivery')) THEN
    RAISE NOTICE 'pfis_pfi_type_check left alone — a later migration has widened it';
  ELSE
    ALTER TABLE pfis DROP CONSTRAINT IF EXISTS pfis_pfi_type_check;
    ALTER TABLE pfis
      ADD CONSTRAINT pfis_pfi_type_check
      CHECK (pfi_type IN ('coastal', 'gantry', 'delivery'));
  END IF;
END $$;

-- ── 2. Where a delivery batch is loaded from ──────────────────────────────
--
-- `location_id` on `pfis` already means "the depot this batch belongs to", and
-- for a delivery allocation that is the depot it is loaded AT. Nothing new is
-- needed for the source; what is new is everywhere it may be sold.

CREATE TABLE IF NOT EXISTS pfi_allowed_locations (
  id          SERIAL PRIMARY KEY,
  pfi_id      INTEGER NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,
  depot_id    INTEGER NOT NULL REFERENCES depots(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  INTEGER REFERENCES staff(id) ON DELETE SET NULL
);

-- One row per pair. A location listed twice is not "more allowed".
CREATE UNIQUE INDEX IF NOT EXISTS pfi_allowed_locations_pair_idx
  ON pfi_allowed_locations (pfi_id, depot_id);

-- The question asked at order placement: which batches may this location sell
-- from? Indexed from the depot's side because that is the direction it runs.
CREATE INDEX IF NOT EXISTS pfi_allowed_locations_depot_idx
  ON pfi_allowed_locations (depot_id);

-- ── 3. The truck manifest ─────────────────────────────────────────────────
--
-- `loaded_qty_litres` is the point of this table. A 50,000-litre truck that
-- took 47,300 has carried 47,300, and a batch built from capacities would
-- overstate itself on every single truck. Capacity is recorded alongside so
-- the shortfall is visible rather than merely absent.

CREATE TABLE IF NOT EXISTS pfi_trucks (
  id                SERIAL PRIMARY KEY,
  pfi_id            INTEGER NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,
  truck_id          INTEGER REFERENCES fleet_trucks(id) ON DELETE SET NULL,
  -- Kept as text as well as an id: a truck sold or re-plated later must not
  -- rewrite what a past manifest says went out.
  plate_number      VARCHAR(50) NOT NULL DEFAULT '',
  /** What the truck can hold. Copied at load time for the same reason. */
  capacity_litres   NUMERIC(12, 2),
  /** What it actually took. This is what the batch is built from. */
  loaded_qty_litres NUMERIC(12, 2) NOT NULL,
  loaded_at         TIMESTAMPTZ,
  notes             TEXT NOT NULL DEFAULT '',
  recorded_by       INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pfi_trucks_pfi_idx ON pfi_trucks (pfi_id);
CREATE INDEX IF NOT EXISTS pfi_trucks_truck_idx ON pfi_trucks (truck_id);

-- ── 4. Guards ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- A truck that loaded nothing is not on the manifest. Zero would sum into
  -- the batch as a truck that went out empty and count toward its truck total.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pfi_trucks_loaded_positive') THEN
    ALTER TABLE pfi_trucks
      ADD CONSTRAINT pfi_trucks_loaded_positive CHECK (loaded_qty_litres > 0);
  END IF;

  -- Capacity is optional, but a negative one is meaningless and an overload
  -- is a real operational fact worth refusing at the point of entry rather
  -- than discovering in a reconciliation.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pfi_trucks_within_capacity') THEN
    ALTER TABLE pfi_trucks
      ADD CONSTRAINT pfi_trucks_within_capacity
      CHECK (capacity_litres IS NULL OR (capacity_litres > 0 AND loaded_qty_litres <= capacity_litres));
  END IF;
END $$;

-- ── Verification ──────────────────────────────────────────────────────────
--
-- Nothing above touches an existing row: the two tables are new and the only
-- change to `pfis` widens a CHECK. Both existing types must still be legal,
-- and all 44 existing batches must still satisfy the constraint.
--
-- Checked against the constraint the table actually carries, not against this
-- file's own list. On a database where 0045 has since widened the list, a
-- trucking batch is legal and failing here would stop the chain on a file
-- that changed nothing — see the note on the constraint above.

DO $$
DECLARE
  bad INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM pfis p
   WHERE p.pfi_type NOT IN ('coastal', 'gantry', 'delivery')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'pfis_pfi_type_check'
          AND pg_get_constraintdef(c.oid) LIKE '%' || p.pfi_type || '%'
     );

  IF bad > 0 THEN
    RAISE EXCEPTION 'Migration 0027 left % PFI row(s) outside the type constraint. Rolling back.', bad;
  END IF;
END $$;
