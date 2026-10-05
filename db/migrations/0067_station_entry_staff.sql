-- Who enters a station's records, by kind: the day's sales and expenses, and
-- its deposits. A filling station or an LPG plant.
--
-- Written by hand in the style of 0002-0066. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── Two jobs, often two people ────────────────────────────────────────────
--
-- What a station sold and spent is written up from the pump or the till by
-- whoever runs it. What it banked is matched off the bank statement, often by
-- somebody else entirely. Each can now be given to named people, and a row of
-- that kind is then written, changed or deleted only by them. Everybody who
-- can see the station still sees every row — this decides who ENTERS, never
-- who reads. One person may hold both.
--
-- ── Station-wide, and a PFI that differs ──────────────────────────────────
--
--   pfi_id NULL   the people for that kind on every PFI at the station
--   pfi_id set    the people for that kind on that PFI only, instead
--
-- The two kinds are separate: a PFI may name its own deposits people and
-- leave sales to the station-wide ones. pfi_id is the PFI the station's load
-- came off — delivery_inventory.pfi_id, the PFI the station page files it
-- under.
--
-- Nobody named for a kind leaves it open to anyone who can see the station,
-- as it was before this table. Admins and super admins may always enter, to
-- correct. lib/stationEntry.js holds the rule.

CREATE TABLE IF NOT EXISTS station_entry_staff (
  id                   serial      PRIMARY KEY,
  delivery_customer_id integer     NOT NULL REFERENCES delivery_customers(id) ON DELETE CASCADE,
  pfi_id               integer     REFERENCES pfis(id) ON DELETE CASCADE,
  entry_kind           text        NOT NULL CHECK (entry_kind IN ('sales', 'deposits')),
  staff_id             integer     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  assigned_by          integer     REFERENCES staff(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- One row per person, per kind, per PFI (or station-wide) at a station.
-- coalesce, because NULLs are never equal to each other in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS station_entry_staff_unique_idx
  ON station_entry_staff (delivery_customer_id, coalesce(pfi_id, 0), entry_kind, staff_id);
CREATE INDEX IF NOT EXISTS station_entry_staff_staff_idx ON station_entry_staff (staff_id);
