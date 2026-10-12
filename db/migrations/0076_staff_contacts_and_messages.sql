-- Alternate contacts for staff, and in-house messages between staff.
--
-- Written by hand in the style of 0002-0075. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Nothing existing changes: four new columns on staff, each with a default
-- that sends exactly what is sent today, and one new table.

-- ─── Alternate phone and email ──────────────────────────────────────────────
--
-- Every text and email to a member of staff goes to the numbers and addresses
-- these pick (notifications/recipients.js staffContact):
--   main       the phone_number / email on the account, as before
--   alternate  the alternate one (or the main one, while there is none)
--   both       both, which with no alternate is the main one alone
-- 'both' is the default, so adding an alternate starts copying it in.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS alt_phone_number varchar(30);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS alt_email varchar(255);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS sms_to varchar(10) NOT NULL DEFAULT 'both';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS email_to varchar(10) NOT NULL DEFAULT 'both';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_sms_to_check') THEN
    ALTER TABLE staff ADD CONSTRAINT staff_sms_to_check
      CHECK (sms_to IN ('main', 'alternate', 'both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_email_to_check') THEN
    ALTER TABLE staff ADD CONSTRAINT staff_email_to_check
      CHECK (email_to IN ('main', 'alternate', 'both'));
  END IF;
END $$;

-- ─── Messages between staff ─────────────────────────────────────────────────
--
-- One row per message, one sender and one recipient. Only those two are ever
-- shown its text (services/staffMessages.service.js); admins see who wrote to
-- whom and when, never what.
--
-- Accounts are deleted outright, so the names are kept on the row and the ids
-- go to NULL: the record of a conversation outlives either person's account.
--
-- alerted_at is when the "you have a new message" text went for this message.
-- One goes per conversation until the recipient reads it, so ten quick
-- messages cost one SMS.

CREATE TABLE IF NOT EXISTS staff_messages (
  id              serial PRIMARY KEY,
  sender_id       integer REFERENCES staff(id) ON DELETE SET NULL,
  recipient_id    integer REFERENCES staff(id) ON DELETE SET NULL,
  sender_name     varchar(255) NOT NULL DEFAULT '',
  recipient_name  varchar(255) NOT NULL DEFAULT '',
  body            text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  alerted_at      timestamptz
);

-- A conversation, newest first: the pair in either direction.
CREATE INDEX IF NOT EXISTS staff_messages_pair_idx
  ON staff_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id DESC);

-- Unread counts and the once-until-read alert.
CREATE INDEX IF NOT EXISTS staff_messages_unread_idx
  ON staff_messages (recipient_id, sender_id)
  WHERE read_at IS NULL;
