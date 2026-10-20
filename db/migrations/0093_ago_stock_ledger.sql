-- The AGO stock ledger: the company's own diesel, bought in, given to trucks
-- trip by trip, and the balance left after every entry.
--
-- Written by hand in the style of 0002-0092. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- One stock, one balance (the owner's choice, 2026-10-20). Each row moves it
-- one way:
--
--   in    opening      the balance the book starts from — once
--         received     new stock bought in
--         retrieved    taken back off a truck: a diversion, a shorter trip
--         adjust_in    a count found more than the book
--   out   given        given to a truck for a trip
--         top_up       more for the same trip: he went farther than planned
--         adjust_out   a count found less than the book
--
-- A top-up or retrieval belongs to the AGO given it changes (issue_id), and
-- carries that entry's trip, truck and PFI. So a trip's AGO is its given +
-- top-ups - retrieved, and Delivery Costing reads that figure for the trip in
-- place of the one typed there (repositories/deliveryInventory.repository.js).
-- The typed figure is never overwritten: a trip whose ledger entries are all
-- deleted shows it again.
--
-- The balance is not stored. It is worked out from the live entries every
-- time they are read (services/agoStock.service.js), so a corrected or
-- back-dated entry can never leave a stale balance behind it. Deleted entries
-- are kept, marked, for the record.
--
-- Nothing existing changes: a new table only.

CREATE TABLE IF NOT EXISTS ago_stock_entries (
  id               serial PRIMARY KEY,
  entry_date       date NOT NULL,
  kind             varchar(20) NOT NULL,
  litres           numeric(12,2) NOT NULL,
  -- The AGO given a top-up or retrieval changes.
  issue_id         integer REFERENCES ago_stock_entries(id) ON DELETE RESTRICT,
  -- The trip (a truck's load on a PFI) the AGO was given for. Null for AGO
  -- given to a truck on no PFI, and for stock entries.
  trip_id          integer REFERENCES delivery_inventory(id) ON DELETE SET NULL,
  truck_id         integer REFERENCES fleet_trucks(id) ON DELETE SET NULL,
  -- As it read when the entry was made, so the row still names its truck if
  -- the trip or the fleet record goes.
  truck_number     varchar(30) NOT NULL DEFAULT '',
  -- What the truck carried. Read from the trip while there is one; this is
  -- what was entered for a truck on no trip.
  truck_qty        numeric(12,2),
  pfi_id           integer REFERENCES pfis(id) ON DELETE SET NULL,
  description      text NOT NULL DEFAULT '',
  recorded_by      integer REFERENCES staff(id) ON DELETE SET NULL,
  recorded_by_name varchar(255) NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_name  varchar(255) NOT NULL DEFAULT '',
  deleted_at       timestamptz,
  deleted_by       integer REFERENCES staff(id) ON DELETE SET NULL,
  deleted_by_name  varchar(255) NOT NULL DEFAULT '',
  CONSTRAINT ago_stock_entries_kind_check
    CHECK (kind IN ('opening', 'received', 'given', 'top_up', 'retrieved', 'adjust_in', 'adjust_out')),
  CONSTRAINT ago_stock_entries_litres_check CHECK (litres > 0),
  -- A top-up or retrieval always changes an AGO given; nothing else does.
  CONSTRAINT ago_stock_entries_issue_check
    CHECK ((kind IN ('top_up', 'retrieved')) = (issue_id IS NOT NULL)),
  -- AGO that went to a truck names the truck.
  CONSTRAINT ago_stock_entries_truck_check
    CHECK (kind NOT IN ('given', 'top_up', 'retrieved') OR truck_number <> '')
);

-- The book starts from one opening balance.
CREATE UNIQUE INDEX IF NOT EXISTS ago_stock_entries_one_opening
  ON ago_stock_entries ((kind))
  WHERE kind = 'opening' AND deleted_at IS NULL;

-- A trip is given its AGO once; more for the same trip is a top-up. This is
-- what catches the same truck entered twice.
CREATE UNIQUE INDEX IF NOT EXISTS ago_stock_entries_one_given_per_trip
  ON ago_stock_entries (trip_id)
  WHERE kind = 'given' AND deleted_at IS NULL AND trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ago_stock_entries_live_idx
  ON ago_stock_entries (entry_date, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ago_stock_entries_trip_idx
  ON ago_stock_entries (trip_id)
  WHERE deleted_at IS NULL AND trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ago_stock_entries_issue_idx
  ON ago_stock_entries (issue_id)
  WHERE deleted_at IS NULL AND issue_id IS NOT NULL;

COMMENT ON TABLE ago_stock_entries IS
  'The AGO (diesel) stock book: opening, received, given to trucks per trip, top-ups, retrievals, count adjustments. The balance is worked out from the live rows, never stored.';
