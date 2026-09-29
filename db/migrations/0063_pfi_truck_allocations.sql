-- Trucks allocated off a cargo become that cargo's lettered trucking PFI.
--
-- Written by hand in the style of 0002-0062. Idempotent.
--
-- ── What this replaces ─────────────────────────────────────────────────────
--
-- A trucking batch drawn from a cargo (PFI-14B off PFI/14, PFI-41C off PFI/41)
-- was raised by hand: somebody typed a name, picked trucks, and the parent
-- cargo never heard about it. Its product was either not deducted from the
-- parent at all, or deducted by loading the trucks against the parent's own
-- pfi_id, which is why 14B, 19B and 24B were kept from ever having a PFI of
-- their own — a second PFI beside the parent would have counted the same
-- litres twice.
--
-- ── The allocation is the record ───────────────────────────────────────────
--
-- A row here is the request: the parent, the trucks and what each carries,
-- the day's price, who asked, who decided. Approving it does two things in
-- the one act — places an ORDER on the parent for the whole quantity at that
-- price (so the parent's stock goes down the ordinary way, through
-- reserveStock, and the order goes through payment, tickets and the gates
-- like any other), and raises the lettered trucking PFI holding exactly those
-- litres. Rejected and withdrawn rows are kept, as depot_price_changes keeps
-- its refusals.
--
-- ── The letter ─────────────────────────────────────────────────────────────
--
-- A cargo's family shares one run of letters, whatever kind each member is:
-- PFI/25B is a coastal cargo and PFI-25C a batch of trucks. The next letter is
-- the first one nobody in the family holds — not a PFI number, not a truck
-- allocation code, and not an allocation still pending or approved here. The
-- partial unique index is the last word on the third: two allocations raised
-- at the same moment cannot both hold 47C.
CREATE TABLE IF NOT EXISTS pfi_truck_allocations (
  id               serial PRIMARY KEY,
  parent_pfi_id    integer NOT NULL REFERENCES pfis(id) ON DELETE RESTRICT,
  -- The family's serial, as it appears in every member's number: "47".
  family_serial    varchar(10) NOT NULL,
  suffix           varchar(2)  NOT NULL CHECK (suffix ~ '^[B-Z]$'),
  -- The name the trucking PFI takes on approval, and its batch code.
  pfi_number       varchar(100) NOT NULL,
  allocation_code  varchar(100) NOT NULL,
  depot_id         integer REFERENCES depots(id)   ON DELETE SET NULL,
  product_id       integer REFERENCES products(id) ON DELETE SET NULL,
  -- The day's rate the parent sells to trucking at: the order's price and the
  -- trucking PFI's cost per unit.
  price_per_unit   numeric(15,2) NOT NULL CHECK (price_per_unit > 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  -- [{ truckId, plateNumber, driverName, driverPhone, loadedQty }]
  trucks           jsonb NOT NULL,
  loading_date     date NOT NULL,
  note             text NOT NULL DEFAULT '',
  status           varchar(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  raised_by        integer REFERENCES staff(id) ON DELETE SET NULL,
  raised_by_name   varchar(255) NOT NULL DEFAULT '',
  raised_at        timestamptz NOT NULL DEFAULT now(),
  decided_by       integer REFERENCES staff(id) ON DELETE SET NULL,
  decided_by_name  varchar(255) NOT NULL DEFAULT '',
  decided_at       timestamptz,
  decision_note    text NOT NULL DEFAULT '',
  -- What approval made. Both set together, by the same transaction.
  order_id         integer REFERENCES orders(id) ON DELETE SET NULL,
  sub_pfi_id       integer REFERENCES pfis(id)   ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pfi_truck_allocations IS
  'Trucks allocated off a cargo, and what became of each request. Approval places an order on the parent and raises the lettered trucking PFI.';

CREATE UNIQUE INDEX IF NOT EXISTS pfi_truck_allocations_live_suffix_idx
  ON pfi_truck_allocations (family_serial, suffix)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS pfi_truck_allocations_parent_idx
  ON pfi_truck_allocations (parent_pfi_id, raised_at DESC);

CREATE INDEX IF NOT EXISTS pfi_truck_allocations_pending_idx
  ON pfi_truck_allocations (raised_at DESC) WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS pfi_truck_allocations_sub_pfi_idx
  ON pfi_truck_allocations (sub_pfi_id) WHERE sub_pfi_id IS NOT NULL;

-- ── The trucking PFI names its parent ──────────────────────────────────────
--
-- Nullable: every PFI raised before this, trucking or not, has no recorded
-- parent, and guessing one from the number would claim a link nobody made.
ALTER TABLE pfis
  ADD COLUMN IF NOT EXISTS parent_pfi_id integer REFERENCES pfis(id) ON DELETE SET NULL;

COMMENT ON COLUMN pfis.parent_pfi_id IS
  'The cargo this trucking PFI was allocated from (pfi_truck_allocations). NULL on everything raised any other way.';

CREATE INDEX IF NOT EXISTS pfis_parent_pfi_idx
  ON pfis (parent_pfi_id) WHERE parent_pfi_id IS NOT NULL;

-- ── The house customer ─────────────────────────────────────────────────────
--
-- An order needs a customer, and the one approval places is the company
-- selling to its own trucks. It is a single customer row marked by what it is
-- for, created by the service the first time it is needed — not inserted here,
-- so a database that never allocates trucks never carries it.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS house_account varchar(30);

COMMENT ON COLUMN customers.house_account IS
  'Set on the company''s own internal customers, naming what each is for (''trucking''). NULL on every real customer.';

CREATE UNIQUE INDEX IF NOT EXISTS customers_house_account_idx
  ON customers (house_account) WHERE house_account IS NOT NULL;
