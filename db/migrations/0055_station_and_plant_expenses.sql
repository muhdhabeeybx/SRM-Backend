-- An expense can be against a filling station or an LPG plant.
--
-- Until now an expense was one of two things, and neither was stored as a
-- type: pfi_id set meant a cargo cost, pfi_id null meant general overhead.
-- There was no way to say "this is Kano station's pump repair", so those
-- costs were either filed as overhead — where they tell you nothing about
-- which station is expensive to run — or not raised at all.
--
-- Two columns rather than one, because the two subjects live in two tables:
-- a filling station is a delivery_customers row with customer_type
-- 'filling_station', and an LPG plant is an lpg_stations row.
--
-- ── The type stays derived ─────────────────────────────────────────────────
--
-- As it already is. A stored type column would be a second answer to a
-- question the links already answer, and the two would drift:
--
--   delivery_customer_id set → a station expense
--   lpg_station_id       set → a plant expense
--   pfi_id set, neither of the above → a cargo expense, as before
--   none of the three        → general overhead, as before
--
-- ── pfi_id beside a station is attribution, not a cargo expense ────────────
--
-- A station's costs arise while it is selling a particular consignment, and
-- the desk wants them under that PFI. So pfi_id keeps its meaning of "which
-- cargo this belongs to" and gains a second use: alongside a station or plant
-- it says which of that station's loads the cost sits under. A cargo expense
-- is still the case where pfi_id is set and no subject is.
--
-- ── This is NOT the station's own spending ────────────────────────────────
--
-- delivery_sales.expenses_amount already records cash a station spends out of
-- its pump takings, and that is a DEBIT against the station: it is our money
-- they spent. What lands here is the opposite — money Soroman pays a vendor
-- on a station's behalf. It never touches the station's balance; it comes off
-- our margin on that cargo. Keeping the two apart is the whole reason this is
-- a separate subject rather than another category of overhead.
--
-- Nothing existing is reinterpreted: every current row has both new columns
-- null and keeps exactly the meaning it had.
ALTER TABLE pfi_expenses
  ADD COLUMN IF NOT EXISTS delivery_customer_id integer
    REFERENCES delivery_customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lpg_station_id integer
    REFERENCES lpg_stations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pfi_expenses_delivery_customer_idx
  ON pfi_expenses (delivery_customer_id);
CREATE INDEX IF NOT EXISTS pfi_expenses_lpg_station_idx
  ON pfi_expenses (lpg_station_id);

-- A row cannot be two subjects at once. A station expense and a plant expense
-- are different registers with different owners, and a row claiming both
-- would be counted in each.
ALTER TABLE pfi_expenses
  DROP CONSTRAINT IF EXISTS pfi_expenses_one_subject;
ALTER TABLE pfi_expenses
  ADD CONSTRAINT pfi_expenses_one_subject
  CHECK (delivery_customer_id IS NULL OR lpg_station_id IS NULL);

-- No new chart of accounts, deliberately.
--
-- A pump repair is repairs-and-maintenance whether it was for a station, a
-- plant or head office, so these expenses draw on the same GL accounts as any
-- other. What makes them their own kind is the subject above, not a separate
-- category list — and splitting the chart by subject would mean the same real
-- cost landing in two different accounts depending on who it was for, which
-- is the thing a chart of accounts exists to prevent.
