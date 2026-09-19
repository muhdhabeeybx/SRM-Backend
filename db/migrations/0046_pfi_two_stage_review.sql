-- A PFI is raised, then reviewed, then trades.
--
-- Written by hand in the style of 0002-0045. Idempotent.
--
-- ── The lifecycle already existed; the gate did not ────────────────────────
--
-- pfi_status has read not_started | active | finished since migration 0025,
-- and the form has carried a "not started" tick since. What was missing is
-- that nothing MADE a new PFI start there, and nothing had to happen before it
-- could leave. A batch could be raised and trading in one save, with no bank
-- account against it and no officer answerable for it.
--
-- So: raising a PFI captures the cargo and nothing else, and it lands
-- not_started. Assigning the bank and the officers is a second, separate act
-- by somebody who did not raise it, and that act is what activates it.
--
-- ── Who did what, kept ─────────────────────────────────────────────────────
--
-- Both halves are recorded. An approval nobody is named on is not an approval,
-- and "who let this batch trade" is the question an auditor asks first.
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS raised_by integer;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS raised_at timestamptz;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS activated_by integer;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';

COMMENT ON COLUMN pfis.activated_by IS
  'Who released this PFI to trade, and therefore who assigned its bank account and officers. NULL on every PFI predating the review gate, and on one still waiting.';

/*
  ── A trucking batch waits with its PFI ──────────────────────────────────

  A trucking PFI is raised WITH its trucks — the code, the depot, the date and
  each plate with what it actually loaded. Those loads must not reach the
  inventory or the sales ledger before the PFI is approved, or the gate means
  nothing: the money would already be owed against a batch nobody had signed
  off. So the selection is parked here and written as delivery_inventory rows
  at activation, by which point there is a bank account and an officer
  answerable for it.

  jsonb rather than a table: this is a draft with a lifetime of hours, it is
  read exactly once, and it stops being true the moment it is spent.
*/
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS pending_batch jsonb;

COMMENT ON COLUMN pfis.pending_batch IS
  'A trucking PFI''s unwritten batch: {code, depotName, productName, dateAllocated, trucks:[{truckId, plateNumber, loadedQty}]}. Cleared once activation writes the delivery_inventory rows.';

-- Finding what is waiting is the review queue's only query.
CREATE INDEX IF NOT EXISTS pfis_awaiting_review_idx
  ON pfis (raised_at DESC)
  WHERE status = 'not_started';
