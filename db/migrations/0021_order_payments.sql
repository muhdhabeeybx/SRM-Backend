-- Order-first payments: money is received against an ORDER, matched to a bank
-- statement line, and never against a customer's wallet.
--
-- Written by hand in the style of 0002–0020, for the reason set out in 0003:
-- drizzle-kit has no snapshot of this database. Every statement is idempotent,
-- so re-running the file is a no-op.
--
-- ── Why this exists ────────────────────────────────────────────────────────
--
-- Until now the money path was: bank statement line → a `deposits` credit on
-- the CUSTOMER's wallet → `customers.balance` → a `wallet_holds` row debiting
-- that balance for an order. Which deposit paid which order was not recorded
-- by any of that. It was reconstructed afterwards into
-- `order_deposit_allocations` by walking the wallet oldest-credit-first, and
-- where even that was missing the finance report walked it newest-first at
-- read time and printed the guess in the same columns as real bank data.
--
-- Three things followed, all of them found in the live data:
--
--   * An order confirmed against one specific ₦18m bank credit was written up
--     as slices of three unrelated ones, because the wallet, not the order,
--     was the thing being debited.
--   * 101 orders read as overpaid by ₦1.19bn in total and 41 read short,
--     against payments that had in fact been made correctly.
--   * The two ledgers disagree outright: `balance = credits − debits − holds`
--     fails for 254 customers, by ₦213.6bn.
--
-- None of that is auditable against a bank statement, which is the only thing
-- an external auditor will accept.
--
-- After this migration there is ONE record of money received against an order,
-- `order_payments`, and each row carries the bank statement line's own
-- details — value date, depositor, narration, bank reference, the account it
-- was paid into — copied onto it at match time. The report prints that row.
-- It does not reconstruct anything.
--
-- Surplus stays on the order that received it. Moving it to another order is
-- an explicit, recorded act (`order_payment_transfers`) rather than a wallet
-- debit with the destination typed into a free-text description, which is how
-- it was done before and which the report recovered with a regex.
--
-- The wallet tables (`deposits`, `wallet_holds`, `order_deposit_allocations`)
-- are deliberately NOT dropped here. They hold the history this backfill is
-- derived from, and ₦31.7m of live customer credit still to be reconciled
-- onto orders. They stop being written for order payments; they stay readable.

-- ── 1. Explicit order → order movement of surplus ──────────────────────────
--
-- Created before order_payments because that table carries an FK to this one.
--
-- The two legs of a transfer are ordinary order_payments rows (a negative one
-- on the order it leaves, a positive one on the order it lands on), both
-- pointing here. So the report needs no special case: it sums the payment
-- rows on an order, and an order that has given its surplus away nets down to
-- what it actually kept.
CREATE TABLE IF NOT EXISTS order_payment_transfers (
  id            serial PRIMARY KEY,
  from_order_id integer NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  to_order_id   integer NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  amount        numeric(15, 2) NOT NULL,
  reason        text NOT NULL DEFAULT '',
  recorded_by   integer REFERENCES staff (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_payment_transfers_amount_check CHECK (amount > 0),
  -- An order cannot transfer to itself. Without this the two legs would
  -- cancel out on the same order and the movement would be invisible.
  CONSTRAINT order_payment_transfers_distinct_check CHECK (from_order_id <> to_order_id)
);

CREATE INDEX IF NOT EXISTS order_payment_transfers_from_idx ON order_payment_transfers (from_order_id);
CREATE INDEX IF NOT EXISTS order_payment_transfers_to_idx   ON order_payment_transfers (to_order_id);

-- ── 2. Money received against an order ─────────────────────────────────────
--
-- One row per bank statement line matched to the order, plus one row per leg
-- of a transfer, plus one 'legacy' row per historical order whose funding was
-- never recorded.
--
-- The bank columns (txn_date … account_number) are a SNAPSHOT taken from the
-- statement line when it is matched, not a join to be resolved at read time.
-- That is the whole point of the table. The previous report resolved them by
-- joining back through `deposits` to whichever line had the lowest id, which
-- on a deposit funded by several lines from different days produced an
-- effectively arbitrary date under a column headed "Deposit Date". A snapshot
-- also survives the line being re-matched elsewhere, which a join does not.
CREATE TABLE IF NOT EXISTS order_payments (
  id                serial PRIMARY KEY,
  order_id          integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  -- The bank row this payment IS. Null only for a transfer leg or a legacy
  -- row, i.e. exactly where no bank line exists — never as "not filled in".
  statement_line_id integer REFERENCES bank_statement_lines (id) ON DELETE RESTRICT,
  bank_account_id   integer REFERENCES bank_accounts (id) ON DELETE SET NULL,

  -- Signed. Negative on the outgoing leg of a transfer, so an order's total
  -- received is a plain SUM with no case analysis anywhere above it.
  amount            numeric(15, 2) NOT NULL,

  --   statement     a bank statement line matched to THIS order
  --   transfer_in   surplus moved onto this order from another
  --   transfer_out  surplus moved off this order to another (negative amount)
  --   legacy        recorded before this table existed; no bank evidence
  source            varchar(16) NOT NULL DEFAULT 'statement',

  -- ── the statement line, verbatim ──
  txn_date          timestamptz,
  depositor         varchar(255) NOT NULL DEFAULT '',
  narration         text NOT NULL DEFAULT '',
  bank_ref          varchar(255) NOT NULL DEFAULT '',
  bank_name         varchar(255) NOT NULL DEFAULT '',
  account_name      varchar(255) NOT NULL DEFAULT '',
  account_number    varchar(64)  NOT NULL DEFAULT '',

  -- ── provenance ──
  transfer_id       integer REFERENCES order_payment_transfers (id) ON DELETE RESTRICT,
  -- The wallet row this was derived from, where the backfill had one. Kept so
  -- a figure on the new report can still be traced to the old ledger.
  deposit_id        integer REFERENCES deposits (id) ON DELETE SET NULL,
  recorded_by       integer REFERENCES staff (id) ON DELETE SET NULL,
  note              text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_payments_source_check
    CHECK (source IN ('statement', 'transfer_in', 'transfer_out', 'legacy')),
  -- The sign is a function of the source, not an independent field, so a
  -- transfer-out can never be written positive and quietly inflate an order.
  CONSTRAINT order_payments_sign_check
    CHECK ((source = 'transfer_out' AND amount < 0) OR (source <> 'transfer_out' AND amount > 0)),
  -- A bank line is either present with its date, or absent entirely.
  CONSTRAINT order_payments_statement_check
    CHECK (statement_line_id IS NULL OR txn_date IS NOT NULL)
);

-- ONE order per statement line, ever. This is the constraint that makes the
-- report reconcile against the bank statement line by line: a line appears
-- once on the report, under one order. Where a payment overshot the order it
-- was made for, the surplus is moved by an explicit transfer, which is
-- traceable — rather than the line being split across two orders, which is
-- what made the same ₦54,450,000 appear twice on one report.
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_statement_line_unique
  ON order_payments (statement_line_id)
  WHERE statement_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_payments_order_idx    ON order_payments (order_id);
CREATE INDEX IF NOT EXISTS order_payments_source_idx   ON order_payments (source);
CREATE INDEX IF NOT EXISTS order_payments_txn_date_idx ON order_payments (txn_date);
CREATE INDEX IF NOT EXISTS order_payments_transfer_idx ON order_payments (transfer_id);

-- ── 3. Backfill: the statement-backed payments ─────────────────────────────
--
-- Every allocation whose deposit came off a bank statement line becomes an
-- order_payments row carrying that line's own details.
--
-- One order per line, and which order is not a guess: `source = 'bank'` was
-- written at confirm time and means "this line was claimed FOR this order".
-- Where nothing says so (a handful of legacy rows), the order that consumed
-- the most of it wins, with the lowest order id breaking a tie — the same
-- ordering the old report used for its `primaryOrderId`, kept only because
-- for those rows nothing better was ever written down.
--
-- `amount` is the line at FACE value, not the slice the order consumed. That
-- is the figure on the bank statement, and reconciling against the statement
-- one line at a time is the entire purpose of this table. Where the line
-- overshot the order, the surplus shows on the order as a surplus — which is
-- what it is — and section 4 turns any onward movement of it into a transfer.
INSERT INTO order_payments (
  order_id, statement_line_id, bank_account_id, amount, source,
  txn_date, depositor, narration, bank_ref,
  bank_name, account_name, account_number,
  deposit_id, recorded_by, note, created_at
)
SELECT
  chosen.order_id,
  chosen.line_id,
  chosen.bank_account_id,
  chosen.line_amount,
  'statement',
  chosen.txn_date,
  COALESCE(chosen.depositor, ''),
  COALESCE(chosen.narration, ''),
  COALESCE(chosen.bank_ref, ''),
  COALESCE(ba.bank_name, ''),
  COALESCE(ba.account_name, ''),
  COALESCE(ba.account_number, ''),
  chosen.deposit_id,
  chosen.recorded_by,
  'Backfilled from the wallet allocation ledger (migration 0021)',
  chosen.created_at
FROM (
  SELECT DISTINCT ON (l.id)
    l.id              AS line_id,
    l.bank_account_id AS bank_account_id,
    l.amount          AS line_amount,
    l.txn_date        AS txn_date,
    l.depositor       AS depositor,
    l.narration       AS narration,
    l.bank_ref        AS bank_ref,
    a.order_id        AS order_id,
    a.deposit_id      AS deposit_id,
    d.recorded_by     AS recorded_by,
    a.created_at      AS created_at
  FROM bank_statement_lines l
  JOIN order_deposit_allocations a ON a.deposit_id = l.matched_deposit_id
  JOIN deposits d ON d.id = a.deposit_id
  -- A reversed credit is not a payment. reverseDeposit() writes a mirror
  -- debit under a REV-<id> reference precisely to cut the original off, and
  -- carrying its allocation over would resurrect a payment that was undone.
  WHERE NOT EXISTS (
    SELECT 1 FROM deposits r WHERE r.type = 'debit' AND r.reference = 'REV-' || a.deposit_id
  )
  ORDER BY l.id, (a.source = 'bank') DESC, a.applied_amount::numeric DESC, a.order_id ASC
) chosen
LEFT JOIN bank_accounts ba ON ba.id = chosen.bank_account_id
/*
  ── A payment somebody deleted stays deleted ─────────────────────────────

  Every section of this backfill treats "no such row" as "never recorded".
  A row a person REMOVED is also absent, so each re-run of this file — and
  scripts/apply-unjournaled-migrations.js re-runs all of them, every time —
  put it back.

  That is not hypothetical: 23 payments totalling ₦504,879,000 have been
  removed by staff across 8 orders, and on three of those the removal was
  undone this way. Order 11332 is the clearest: its ₦62,400,000 wallet-era
  duplicate was deleted on 11 September and re-created by the next run, which
  is why a fully settled order went on reporting an overpayment of its entire
  value on the refunds page.

  The same reasoning the reversed-deposit guard above already applies: a
  payment that was undone must not come back.
*/
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs al
   WHERE al.entity_type = 'order'
     AND al.action = 'order.payment_removed'
     AND al.entity_id = chosen.order_id
     AND (al.metadata->>'amount')::numeric = chosen.line_amount
)
-- Idempotent: the unique index on statement_line_id is what makes re-running
-- this file a no-op rather than a duplicate-key failure.
ON CONFLICT (statement_line_id) WHERE statement_line_id IS NOT NULL DO NOTHING;

-- ── 4. Backfill: surplus that had already moved between orders ─────────────
--
-- The case this converts, from the live data: line 3895 is a ₦100,000,000
-- credit matched to order 11448 (a ₦45,550,000 order). Order 11489 later drew
-- the ₦54,450,000 difference, recorded as a `wallet` allocation against the
-- same deposit. Under the old shape that put the SAME bank line on two orders
-- — the report showed ₦100m against one and ₦54.45m against the other, and
-- the ₦54.45m was counted twice.
--
-- It is one payment and one movement, and that is how it is recorded now: the
-- line lands whole on 11448 (section 3), and the draw becomes a transfer of
-- ₦54,450,000 from 11448 to 11489, with a leg on each order.
--
-- Every one of the 17 such lines in the live data has exactly this shape — one
-- 'bank' allocation and one later 'wallet' draw — so the conversion is a
-- faithful restatement, not an interpretation.
INSERT INTO order_payment_transfers (from_order_id, to_order_id, amount, reason, recorded_by, created_at)
SELECT
  owner.order_id,
  draw.order_id,
  draw.applied_amount::numeric,
  'Backfilled (migration 0021) — this order drew the surplus of a bank payment made against order #' || owner.order_id,
  d.recorded_by,
  draw.created_at
FROM order_deposit_allocations draw
JOIN bank_statement_lines l ON l.matched_deposit_id = draw.deposit_id
JOIN order_payments owner ON owner.statement_line_id = l.id
JOIN deposits d ON d.id = draw.deposit_id
WHERE draw.order_id <> owner.order_id
  AND draw.applied_amount::numeric > 0
  -- Only once, however many times this file is run.
  AND NOT EXISTS (
    SELECT 1 FROM order_payment_transfers t
    WHERE t.from_order_id = owner.order_id AND t.to_order_id = draw.order_id
      AND t.amount = draw.applied_amount::numeric
  );

-- The two legs of each backfilled transfer. Written from the transfer rows
-- themselves rather than re-derived, so a leg cannot disagree with the
-- movement it belongs to.
INSERT INTO order_payments (order_id, amount, source, transfer_id, recorded_by, note, created_at)
SELECT t.from_order_id, -t.amount, 'transfer_out', t.id, t.recorded_by,
       'Surplus moved to order #' || t.to_order_id, t.created_at
FROM order_payment_transfers t
WHERE t.reason LIKE 'Backfilled (migration 0021)%'
  AND NOT EXISTS (
    SELECT 1 FROM order_payments p WHERE p.transfer_id = t.id AND p.source = 'transfer_out'
  );

INSERT INTO order_payments (order_id, amount, source, transfer_id, recorded_by, note, created_at)
SELECT t.to_order_id, t.amount, 'transfer_in', t.id, t.recorded_by,
       'Surplus received from order #' || t.from_order_id, t.created_at
FROM order_payment_transfers t
WHERE t.reason LIKE 'Backfilled (migration 0021)%'
  AND NOT EXISTS (
    SELECT 1 FROM order_payments p WHERE p.transfer_id = t.id AND p.source = 'transfer_in'
  );

-- ── 5. Backfill: allocations with no bank line behind them ─────────────────
--
-- 1,632 of the 4,709 allocation rows were written by the oldest-credit-first
-- walk that predates any of this being recorded. They name a deposit and an
-- amount and nothing else — no statement line, so nothing an auditor can
-- check. They are carried over as `legacy` and labelled as such rather than
-- being quietly dressed in the same columns as bank-matched money, which is
-- what the old report did.
--
-- Whatever the deposit itself carries still comes across: its reference, its
-- description, and its `deposit_date` where migration 0017's column was ever
-- filled in. Where there is no banking date there is no date — deliberately
-- not defaulted to created_at, which is when somebody keyed the row in and is
-- a different fact (see 0017).
INSERT INTO order_payments (
  order_id, amount, source, txn_date, depositor, narration, bank_ref,
  deposit_id, recorded_by, note, created_at
)
SELECT
  a.order_id,
  a.amount::numeric,
  'legacy',
  d.deposit_date,
  '',
  COALESCE(d.description, ''),
  COALESCE(d.reference, ''),
  a.deposit_id,
  d.recorded_by,
  'Backfilled from the wallet allocation ledger (migration 0021) — no bank statement line was ever recorded for this payment',
  a.created_at
FROM order_deposit_allocations a
JOIN deposits d ON d.id = a.deposit_id
WHERE a.amount::numeric > 0
  -- Sections 3 and 4 own every allocation whose deposit has a line.
  AND NOT EXISTS (
    SELECT 1 FROM bank_statement_lines l WHERE l.matched_deposit_id = a.deposit_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM deposits r WHERE r.type = 'debit' AND r.reference = 'REV-' || a.deposit_id
  )
  -- Idempotent: one legacy row per (order, deposit), the same grain the
  -- allocation table's own unique index enforces.
  AND NOT EXISTS (
    SELECT 1 FROM order_payments p
    WHERE p.order_id = a.order_id AND p.deposit_id = a.deposit_id AND p.source = 'legacy'
  )
  -- And stays gone once a person has removed it. See the note in section 3.
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs al
     WHERE al.entity_type = 'order'
       AND al.action = 'order.payment_removed'
       AND al.entity_id = a.order_id
       AND (al.metadata->>'amount')::numeric = a.amount::numeric
  );

-- ── 6. Backfill: paid orders the ledger never recorded at all ──────────────
--
-- 5,741 of the 7,227 orders marked Paid or Part Paid — everything before the
-- allocation ledger began in June 2026 — have no funding record whatsoever.
--
-- The old report did not leave those blank. It walked the customer's wallet
-- newest-credit-first at read time, took whichever credits happened to cover
-- the order total, and printed them under the same "Depositor" and "Bank
-- Reference" headings as genuinely matched money. Nothing on the row said it
-- was inferred. That inference is being deleted, and this is what replaces it:
-- one row that says the order was paid, for how much, and that no bank
-- evidence exists for it.
--
-- The amount comes from orders.amount_paid, which is the order's own record of
-- what it received and is what every other screen already shows. No bank
-- columns are filled in, because there is nothing truthful to put in them.
INSERT INTO order_payments (order_id, amount, source, note, created_at)
SELECT
  o.id,
  o.amount_paid::numeric,
  'legacy',
  'No payment record exists for this order — it was confirmed before payments were recorded against orders (migration 0021)',
  COALESCE(o.payment_confirmed_at, o.created_at)
FROM orders o
WHERE o.payment_status IN ('Paid', 'Part Paid')
  AND o.amount_paid::numeric > 0
  AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id)
  /*
    An order left with no payments because somebody removed them is not an
    order whose funding was never recorded — it is one where the record was
    deliberately taken away. Refilling it from amount_paid would overwrite
    that decision with a figure the person had just rejected.
  */
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs al
     WHERE al.entity_type = 'order'
       AND al.action = 'order.payment_removed'
       AND al.entity_id = o.id
  );

-- ── 7. What the backfill is expected to leave behind ───────────────────────
--
-- Not assertions — a migration that aborts on a data condition is a migration
-- that cannot be run. These are the queries to run after it, and what they
-- should say:
--
--   -- every paid order now has at least one payment row
--   SELECT count(*) FROM orders o
--   WHERE o.payment_status IN ('Paid','Part Paid') AND o.amount_paid::numeric > 0
--     AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id);
--   -- expected: 0
--
--   -- every statement line matched to a deposit that funded an order now
--   -- appears exactly once, under exactly one order
--   SELECT count(*) FROM bank_statement_lines l
--   WHERE l.status = 'MATCHED'
--     AND EXISTS (SELECT 1 FROM order_deposit_allocations a WHERE a.deposit_id = l.matched_deposit_id)
--     AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.statement_line_id = l.id);
--   -- expected: 0
--
--   -- transfers balance: every transfer has exactly two legs summing to zero
--   SELECT count(*) FROM order_payment_transfers t
--   WHERE (SELECT COALESCE(SUM(p.amount),0) FROM order_payments p WHERE p.transfer_id = t.id) <> 0;
--   -- expected: 0
