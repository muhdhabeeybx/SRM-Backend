-- The books from 1 September 2026, and money out recognised by itself.
--
-- Written by hand in the style of 0002-0084. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── Books from 1 September ────────────────────────────────────────────────
--
-- The owner's choice of 14 Oct 2026: September is the first month in which
-- every payment is tied to an order and a bank line, and expenses are kept —
-- before it, payments went through the wallet with no bank line behind many
-- of them. Moved only while nothing is posted: once the books hold entries,
-- their start is history.

UPDATE accounting_settings SET value = '2026-09-01', updated_at = now()
 WHERE key = 'books_start' AND value <> '2026-09-01'
   AND NOT EXISTS (SELECT 1 FROM journal_entries);

-- ── Money moving between our own accounts ─────────────────────────────────
--
-- Money sent from one of our accounts to another — Warri to Fidelity
-- Expenses, Action Energy to Fidelity — is neither income nor cost. Each side
-- passes through here: out of the first bank on its day, into the second on
-- its own. Both sides on file, it is nought; what it holds is a transfer one
-- side of which is not yet on file.

INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup, system_key, is_system_category)
SELECT 'Money moving between our accounts', '1910', 'assets', 'Suspense', 'transfers_clearing', false
 WHERE NOT EXISTS (SELECT 1 FROM expense_categories c
                    WHERE c.system_key = 'transfers_clearing' OR c.name = 'Money moving between our accounts' OR c.gl_code = '1910');

-- ── What a bank line turned out to be ─────────────────────────────────────
--
-- bank_line_classifications (0083) held the account Finance named a line to.
-- It now says what kind of thing the line was, and who decided:
--
--   kind      account   named to an account by Finance (as before)
--             transfer  money between our own accounts
--             expense   the withdrawal that paid an expense (ref_id)
--             refund    the withdrawal that paid a refund (ref_id: the
--                       order_payments refund row)
--             charges   the bank's own charge
--             supplier  paid for cargo
--             left      looked at and left unexplained — never matched again
--                       by the system
--   ref_id    the record the line was matched to, for expense, refund and a
--             transfer's other side
--   auto      recognised by the posting run (services/accounting/
--             bankMatching), not by a person

ALTER TABLE bank_line_classifications ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'account';
ALTER TABLE bank_line_classifications ADD COLUMN IF NOT EXISTS ref_id integer;
ALTER TABLE bank_line_classifications ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_line_classifications_kind_check') THEN
    ALTER TABLE bank_line_classifications ADD CONSTRAINT bank_line_classifications_kind_check
      CHECK (kind IN ('account', 'transfer', 'expense', 'refund', 'charges', 'supplier', 'left'));
  END IF;
END $$;

-- One withdrawal per expense, and per refund: a payment is not matched twice.
CREATE UNIQUE INDEX IF NOT EXISTS bank_line_classifications_one_payment_idx
  ON bank_line_classifications (kind, ref_id) WHERE kind IN ('expense', 'refund');
