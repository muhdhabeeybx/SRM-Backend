-- Notes on a PFI: what happened, what went wrong and what was decided, in the
-- words of the people running it.
--
-- Written by hand in the style of 0002-0057. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── Why notes, when the PFI already records so much ───────────────────────
--
-- The PFI row, its orders, payments and expenses say WHAT the numbers are.
-- None of them says why: that the vessel berthed four days late, that the
-- deficit was disputed with the surveyor, that the last 40,000 litres were
-- held back for one customer. That knowledge lived in people's heads and in
-- WhatsApp, and a PFI report read a month later could not explain itself.
-- These rows are the file's own narrative, printed in the PFI report beside
-- the figures they explain.
--
-- ── The shape ──────────────────────────────────────────────────────────────
--
--   kind         note | issue | decision — enough to find the problems and
--                the calls made on a long file without reading every line
--   occurred_on  the day it HAPPENED, which is not the day it was written:
--                "discharge completed on 12 Aug" is often typed on the 20th,
--                and the file must read in the order things happened
--   author_*     who wrote it. The name is copied as well as the id, so a
--                note outlives its author's staff row
--
-- A note is removed by marking it deleted, never by deleting the row: a line
-- somebody wrote into an audited file and later withdrew is itself a fact.

CREATE TABLE IF NOT EXISTS pfi_notes (
  id              serial       PRIMARY KEY,
  pfi_id          integer      NOT NULL REFERENCES pfis(id) ON DELETE CASCADE,
  kind            varchar(20)  NOT NULL DEFAULT 'note',
  body            text         NOT NULL,
  occurred_on     date         NOT NULL DEFAULT CURRENT_DATE,
  author_id       integer      REFERENCES staff(id) ON DELETE SET NULL,
  author_name     varchar(255) NOT NULL DEFAULT '',
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      integer      REFERENCES staff(id) ON DELETE SET NULL,
  deleted_by_name varchar(255) NOT NULL DEFAULT ''
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pfi_notes_kind_check') THEN
    ALTER TABLE pfi_notes
      ADD CONSTRAINT pfi_notes_kind_check CHECK (kind IN ('note', 'issue', 'decision'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pfi_notes_body_check') THEN
    ALTER TABLE pfi_notes
      ADD CONSTRAINT pfi_notes_body_check CHECK (length(btrim(body)) > 0);
  END IF;
END $$;

-- The file reads a PFI's live notes in the order they happened.
CREATE INDEX IF NOT EXISTS pfi_notes_live_idx
  ON pfi_notes (pfi_id, occurred_on DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE pfi_notes IS
  'The narrative of a PFI: what happened, what went wrong, what was decided. Printed in the PFI report. Withdrawn notes are marked deleted, never removed.';
COMMENT ON COLUMN pfi_notes.occurred_on IS
  'The day the thing noted happened — not when it was written, which is created_at.';
