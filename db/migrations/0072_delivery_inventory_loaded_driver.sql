-- A delivery's kg loaded, beside what was received, and who drove it.
--
-- Written by hand in the style of 0002-0071. Idempotent. Adds two nullable
-- columns; no existing row is read or changed.
--
-- The owner's rule of 7 October 2026: an LPG plant's deliveries are recorded
-- in full — the truck, the driver, when it loaded and when it delivered, how
-- much was loaded and how much the plant received — and past deliveries are
-- uploaded the same way (services/lpgDelivery.service.js).
--
-- quantity_allocated stays what the customer RECEIVED, the figure every
-- screen already reads as the load (a plant's stock, its account, the LPG
-- stock register). quantity_loaded is what left the loading point, so the
-- difference is what was lost in transit. NULL on every row before this, and
-- on any delivery where it was not recorded — never assumed equal.

ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS quantity_loaded real;
ALTER TABLE delivery_inventory ADD COLUMN IF NOT EXISTS driver_name varchar(255);
