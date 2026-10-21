-- Third-party trucks, and the haulage a trip on one is paid.
--
-- Written by hand in the style of 0002-0093. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- A truck allocated off a PFI is sometimes hired, not ours. It goes into the
-- fleet register like any truck, so the order, the gate, the waybill, the
-- inventory and the sales ledger all name it the same way, but marked as a
-- third party's, so it stays off our Fixed Assets and our papers watchlist.
--
--   fleet_trucks.is_third_party   true = hired, not ours
--   fleet_trucks.owner_name       who owns it (blank on our own)
--
-- Its owner charges haulage for the trip and buys AGO from us out of it, so a
-- hired trip is costed differently (lib/tripCosts.js): the haulage is the
-- cost, the AGO given is sold to the owner at the AGO price, and what we pay
-- the owner is haulage − AGO.
--
--   delivery_inventory.haulage_amount   ₦ the owner charges for the trip
--
-- Nothing existing changes: every truck today stays ours (false) and every
-- trip has no haulage, so every trip is costed exactly as before.

ALTER TABLE fleet_trucks ADD COLUMN IF NOT EXISTS is_third_party boolean NOT NULL DEFAULT false;
ALTER TABLE fleet_trucks ADD COLUMN IF NOT EXISTS owner_name varchar(255) NOT NULL DEFAULT '';

ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS haulage_amount numeric(14, 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_inventory_haulage_amount_check') THEN
    ALTER TABLE delivery_inventory
      ADD CONSTRAINT delivery_inventory_haulage_amount_check CHECK (haulage_amount IS NULL OR haulage_amount >= 0);
  END IF;
END $$;
