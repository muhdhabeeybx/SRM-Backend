-- Product may leave before the money arrives — but only because somebody said so.
--
-- Written by hand in the style of 0002-0047. Idempotent.
--
-- ── The practice this is catching up with ──────────────────────────────────
--
-- Tickets are written by hand at the depot today. A customer turns up, a paper
-- ticket is written, the truck loads and goes, and the order is entered here
-- afterwards — by which time the trucks have to be back-filled onto an order
-- that was never Pending in the system at the moment it mattered. The real
-- sequence is: order raised, ticket issued, truck in, truck out, money later.
--
-- The system could not express that. releasableQuantity() in
-- services/order.service.js returns the quantity the RECEIVED money covers, so
-- an unpaid order releases zero litres and can be ticketed for nothing at all.
-- That single line of arithmetic is currently the only thing standing between
-- the yard and product leaving unpaid.
--
-- ── Why not simply relax it ────────────────────────────────────────────────
--
-- Because then nothing replaces it. The arithmetic cannot be argued with; a
-- permission can. So the gate is not loosened — an exception is added beside
-- it, and the exception has to be authorised, has to carry a reason, and is
-- written down with the name of whoever gave it.
--
-- credit_qty is a SECOND allowance, added to the paid one rather than
-- replacing it: an order that has paid for 20,000 and is trusted for 25,000
-- may ticket 45,000, and paying the balance later widens nothing because the
-- paid share simply grows. Capped at the order's own quantity by the same
-- Math.min that has always capped it.
--
-- ── What is NOT solved here ────────────────────────────────────────────────
--
-- Nothing in this migration chases the money. An order released on credit
-- reaches Completed with payment_status still Unpaid — correctly, because the
-- product did leave — and the only thing that then stops it being forgotten is
-- that the desk can see it. That is the receivables view, and it is the real
-- control this feature depends on. Shipping the allowance without the view
-- would be the actual mistake.

-- ── The authorisation, on the order it was given for ───────────────────────
--
-- Columns rather than a table: releasableQuantity() already receives the order
-- row and nothing else, so reading the allowance costs no join and no caller
-- changes signature. The HISTORY of authorisations lives in audit_logs like
-- every other act — this holds what is in force now.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_qty numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_reason text NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_authorised_by integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_authorised_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_credit_authorised_by_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_credit_authorised_by_fkey
      FOREIGN KEY (credit_authorised_by) REFERENCES staff(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Negative credit would be a silent way to REDUCE what a paid order may ticket.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_credit_qty_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_credit_qty_check CHECK (credit_qty >= 0);
  END IF;
END $$;

-- An allowance with nobody's name against it is the thing this whole migration
-- exists to prevent, so the two halves stand or fall together.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_credit_authorised_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_credit_authorised_check CHECK (
      (credit_qty = 0)
      OR (credit_authorised_by IS NOT NULL AND credit_authorised_at IS NOT NULL AND credit_reason <> '')
    );
  END IF;
END $$;

-- Finding what is owed. Partial, because the rows that matter are the few with
-- an allowance on them, not the tens of thousands without.
CREATE INDEX IF NOT EXISTS orders_credit_outstanding_idx
  ON orders (payment_status, created_at)
  WHERE credit_qty > 0;

-- ── The paper ticket the customer is already holding ───────────────────────
--
-- The handwritten ticket has a number of its own, written at the depot before
-- this system saw the order. Recording it against the load is what lets the
-- paper in the driver's hand be reconciled to the row here — without it the two
-- records exist side by side with nothing tying them together, which is the
-- position the depot is in today.
--
-- On the load rather than on `tickets`: tickets.ticket_number is UNIQUE and
-- system-generated (TCK-<order>-<index>), and a handwritten number follows
-- whatever convention the depot's book uses. Forcing one into the other's
-- column would collide the moment two depots start a book at 001.
ALTER TABLE order_trucks ADD COLUMN IF NOT EXISTS manual_ticket_number varchar(50) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS order_trucks_manual_ticket_idx
  ON order_trucks (manual_ticket_number)
  WHERE manual_ticket_number <> '';
