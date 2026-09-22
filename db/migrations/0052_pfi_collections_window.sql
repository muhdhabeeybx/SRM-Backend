-- When a PFI starts taking money, so an order's payment cannot be matched to
-- a credit belonging to an earlier cargo.
--
-- Written by hand in the style of 0002-0051. Idempotent, and convergent: it is
-- re-run in full every time by scripts/apply-unjournaled-migrations.js.
--
-- ── The problem it answers ────────────────────────────────────────────────
--
-- Thirteen PFIs are active at once, and a single bank account collects for as
-- many as twenty-six of them, so naming the account does not narrow a payment
-- to one cargo. Confirming an order's payment offers every unmatched credit on
-- that account — 366 of them at the time of writing, reaching back to 1 July,
-- 144 older than a month. The desk picks from a list in which a credit paid
-- for a cargo that finished in July sits beside today's.
--
-- ── Why a date and not a hard rule about which PFI a credit belongs to ────
--
-- Because nothing on a bank credit says which cargo it is for. The customer
-- transfers money; which PFI it answers to is a decision made here. The date
-- is the only honest signal, and it is a hint rather than a fact.
--
-- ── Why it is its own column, defaulted from the data ─────────────────────
--
-- `pfi_date` is the document's own date and it is not when money starts
-- arriving. On PFI/32/26/MT PRINCESS, 275 payments worth ₦10.9bn were matched
-- to credits dated in the month BEFORE its pfi_date — entirely legitimately,
-- since customers pay ahead of a cargo being raised. Anchoring the window on
-- pfi_date would have hidden that PFI's own payments from it.
--
-- So each PFI gets a date that can be set to when its collections really
-- opened, and every existing PFI is backfilled to whichever is earlier: its
-- own date, or the earliest credit already matched to one of its orders. That
-- guarantees the window cannot hide a payment the register has already made.
--
-- NULL means "no window" — every credit stays on offer, which is the right
-- behaviour for a PFI nobody has set a date on.
ALTER TABLE pfis
  ADD COLUMN IF NOT EXISTS collections_open_from date;

COMMENT ON COLUMN pfis.collections_open_from IS
  'The day this PFI started taking money. Bank credits older than this are held back when confirming an order on this PFI — shown only behind "include earlier credits", and the choice is recorded on the payment. NULL means no window: every credit is offered.';

/*
  The backfill, convergent and safe to re-run: it only ever fills a NULL, so a
  date somebody has since set by hand is never overwritten.

  LEAST of the PFI's own date and the earliest credit already matched to it,
  because a window that hides payments the register has already accepted would
  make every one of those orders look wrong the moment somebody re-opened it.
*/
UPDATE pfis p
   SET collections_open_from = sub.opens
  FROM (
    SELECT p2.id,
           LEAST(
             COALESCE(p2.pfi_date::date, p2.created_at::date),
             COALESCE((
               SELECT MIN(l.txn_date)
                 FROM order_payments op
                 JOIN orders o ON o.id = op.order_id
                 JOIN bank_statement_lines l ON l.id = op.statement_line_id
                WHERE o.pfi_id = p2.id
             ), COALESCE(p2.pfi_date::date, p2.created_at::date))
           ) AS opens
      FROM pfis p2
  ) AS sub
 WHERE p.id = sub.id
   AND p.collections_open_from IS NULL;

/*
  ── Verification ─────────────────────────────────────────────────────────

  The window must not hide a single payment already matched. If any confirmed
  payment sits before its PFI's new date, the backfill was wrong and this
  rolls back rather than leaving the desk to discover it one order at a time.
*/
DO $$
DECLARE
  hidden INTEGER;
BEGIN
  SELECT COUNT(*) INTO hidden
    FROM order_payments op
    JOIN orders o ON o.id = op.order_id
    JOIN pfis p ON p.id = o.pfi_id
    JOIN bank_statement_lines l ON l.id = op.statement_line_id
   WHERE op.statement_line_id IS NOT NULL
     AND p.collections_open_from IS NOT NULL
     AND l.txn_date < p.collections_open_from;

  IF hidden > 0 THEN
    RAISE EXCEPTION 'Migration 0052 would hide % already-matched payment(s) behind a PFI collections window. Rolling back.', hidden;
  END IF;
END $$;
