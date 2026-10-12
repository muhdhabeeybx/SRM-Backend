-- Gantry tickets: the paper tickets a gantry allocation is split into, by
-- number, and which order each one went to.
--
-- Written by hand in the style of 0002-0074. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The owner's rule of 12 Oct 2026, for gantry PFIs raised from then on:
--
--   1. the PFI's ticket numbers are entered, each with its litres, before it
--      is released to trade;
--   2. a paid order no longer completes on payment — it waits at Released
--      until a stock officer picks the tickets it is sold on, whose litres
--      must come to the order's quantity, and that is what completes it;
--   3. the PFI shows every ticket: left, or sold to which order.
--
-- gantry_ticket_registers says which PFIs work this way. A row is written
-- when a gantry PFI is raised, so the gantry PFIs that were already trading
-- carry on completing on payment, exactly as before. It is its own table, not
-- a column on pfis, so a server running this code before the migration
-- reaches its database reads every PFI as it always did.
--
-- Nothing existing changes: two new tables.

CREATE TABLE IF NOT EXISTS gantry_ticket_registers (
  pfi_id          integer PRIMARY KEY REFERENCES pfis(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      integer REFERENCES staff(id) ON DELETE SET NULL
);

COMMENT ON TABLE gantry_ticket_registers IS
  'Gantry PFIs sold ticket by ticket: tickets entered before trading, each paid order completed by a stock officer picking its tickets. See gantry_tickets.';

CREATE TABLE IF NOT EXISTS gantry_tickets (
  id               serial PRIMARY KEY,
  pfi_id           integer NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,
  ticket_number    varchar(100) NOT NULL,
  qty_litres       integer NOT NULL CHECK (qty_litres > 0),
  -- The order it was sold on. Null while the ticket is left.
  order_id         integer REFERENCES orders(id) ON DELETE SET NULL,
  issued_at        timestamptz,
  issued_by        integer REFERENCES staff(id) ON DELETE SET NULL,
  issued_by_name   varchar(255) NOT NULL DEFAULT '',
  entered_by       integer REFERENCES staff(id) ON DELETE SET NULL,
  entered_by_name  varchar(255) NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Entered by mistake: taken off the register, never deleted. Only a ticket
  -- that has not been sold can be.
  voided_at        timestamptz,
  voided_by        integer REFERENCES staff(id) ON DELETE SET NULL,
  voided_by_name   varchar(255) NOT NULL DEFAULT '',
  void_reason      text NOT NULL DEFAULT '',
  CONSTRAINT gantry_tickets_sold_not_voided CHECK (order_id IS NULL OR voided_at IS NULL)
);

-- One live ticket per number per PFI, whatever the case it was typed in.
CREATE UNIQUE INDEX IF NOT EXISTS gantry_tickets_number_live_uniq
  ON gantry_tickets (pfi_id, upper(ticket_number))
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS gantry_tickets_order_idx
  ON gantry_tickets (order_id)
  WHERE order_id IS NOT NULL;

COMMENT ON TABLE gantry_tickets IS
  'Each paper ticket of a gantry PFI with its litres; order_id is the order it was sold on, null while it is left.';
