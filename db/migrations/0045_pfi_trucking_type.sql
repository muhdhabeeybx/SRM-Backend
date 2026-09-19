-- A trucking PFI is the batch, rather than a record of one kept elsewhere.
--
-- Written by hand in the style of 0002-0044. Idempotent.
--
-- ── Why a fourth type ──────────────────────────────────────────────────────
--
-- A delivery batch has never been a row anywhere: it is every
-- delivery_inventory row sharing an allocation_code, grouped on the way to the
-- screen (see db/schema/deliveryBatch.js). That was fine while batches were
-- raised on the delivery screens, and stopped being fine once the PFI register
-- became the place cargo is accounted for — a batch of trucks was the one kind
-- of cargo with no PFI behind it, so it appeared in no PFI report, had no
-- officers assigned and no cost recorded against it.
--
-- 'trucking' is raised in the PFI register and creates the batch as it saves.
-- It is a FOURTH type rather than an extension of 'delivery': that one already
-- exists, one PFI uses it, and it means something narrower — a cargo loaded at
-- one depot and sold at several, counted in trucks but not itself a batch.
-- Widening it would have changed what that existing row claims to be.
--
-- ── allocation_code is the link ────────────────────────────────────────────
--
-- The batch has no id to point at, so the PFI keeps the code and the
-- delivery_inventory rows carry the same one. That is the whole join.
ALTER TABLE pfis
  ADD COLUMN IF NOT EXISTS allocation_code varchar(100);

COMMENT ON COLUMN pfis.allocation_code IS
  'The delivery batch this PFI raised, by its allocation_code. NULL on every type but trucking, and on trucking PFIs raised before a batch was attached. A batch is not a row — it is the delivery_inventory rows sharing this code.';

CREATE INDEX IF NOT EXISTS pfis_allocation_code_idx
  ON pfis (allocation_code)
  WHERE allocation_code IS NOT NULL;

-- The type is a varchar guarded by a CHECK, not an enum, so widening it is a
-- constraint swap. Dropped and recreated rather than altered because Postgres
-- has no ALTER for a check's expression.
ALTER TABLE pfis DROP CONSTRAINT IF EXISTS pfis_pfi_type_check;

ALTER TABLE pfis
  ADD CONSTRAINT pfis_pfi_type_check
  CHECK (pfi_type IN ('coastal', 'gantry', 'delivery', 'trucking'));
