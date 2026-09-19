-- A truck sale payment is claimed off the bank statement, like an order's is.
--
-- Written by hand in the style of 0002-0043. Idempotent.
--
-- ── Why ────────────────────────────────────────────────────────────────────
--
-- An order's payment names the statement line that paid it: the amount, the
-- payer, the date and the bank reference are copied off the bank's own row and
-- the line is claimed so nothing else can spend it. A truck sale had none of
-- that. The desk typed the amount, the payer name and the date from a phone
-- screen or a WhatsApp forward, and nothing tied the entry to a credit that
-- had actually landed — so a payment could be recorded that the bank never
-- received, recorded twice, or recorded against the wrong truck, and the
-- ledger had no way to tell.
--
-- ── Both directions, because the question gets asked from both ends ────────
--
-- delivery_sales.statement_line_id answers "what credit is this payment?" and
-- bank_statement_lines.matched_delivery_sale_id answers "what claimed this
-- credit?". The second is what keeps the statement screen honest: without it a
-- line claimed by a truck sale would read as MATCHED with nothing against it,
-- indistinguishable from a bug.
--
-- ── Old rows keep working ──────────────────────────────────────────────────
--
-- Every payment written before this has statement_line_id NULL and bank_ref
-- ''. They are not wrong, they are older, and nothing here rewrites them — the
-- ledger shows a dash in the reference column for those, which is the truth.
ALTER TABLE delivery_sales
  ADD COLUMN IF NOT EXISTS statement_line_id integer;

ALTER TABLE delivery_sales
  ADD COLUMN IF NOT EXISTS bank_ref varchar(255) NOT NULL DEFAULT '';

COMMENT ON COLUMN delivery_sales.statement_line_id IS
  'The bank statement line this payment was claimed from. NULL on every row predating bank matching, and on transfers between trucks, which move money already on the ledger rather than bringing new money in.';

-- One credit funds one payment. The database enforces it rather than the
-- application, for the same reason the statement''s own dedup key does: a
-- guarantee that lives in application code can be bypassed by the next caller
-- written against the table.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_sales_statement_line_unique
  ON delivery_sales (statement_line_id)
  WHERE statement_line_id IS NOT NULL;

ALTER TABLE bank_statement_lines
  ADD COLUMN IF NOT EXISTS matched_delivery_sale_id integer;

COMMENT ON COLUMN bank_statement_lines.matched_delivery_sale_id IS
  'The truck sale payment that claimed this credit, where an order did not. Exactly one of matched_order_id and this is set on a matched line.';

CREATE INDEX IF NOT EXISTS bsl_delivery_sale_idx
  ON bank_statement_lines (matched_delivery_sale_id)
  WHERE matched_delivery_sale_id IS NOT NULL;
