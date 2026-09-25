-- Staff can be assigned filling stations, the way they already are depots,
-- LPG plants and PFIs.
--
-- Written by hand in the style of 0002-0056. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- A filling station is a delivery_customers row with customer_type
-- 'filling_station' (see 0055), so that is what the assignment points at.
-- The shape is lpg_station_staff's exactly, and it means the same thing: a
-- person with any stations assigned sees those stations — their list, their
-- truck sales, their expenses — and nobody else's. A person with none
-- assigned is not narrowed at all (lib/scopeFilter.js explains why an empty
-- assignment must never read as "nothing").

CREATE TABLE IF NOT EXISTS filling_station_staff (
  id                   serial      PRIMARY KEY,
  delivery_customer_id integer     NOT NULL REFERENCES delivery_customers(id) ON DELETE CASCADE,
  staff_id             integer     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS filling_station_staff_unique_idx
  ON filling_station_staff (delivery_customer_id, staff_id);
CREATE INDEX IF NOT EXISTS filling_station_staff_staff_idx ON filling_station_staff (staff_id);
