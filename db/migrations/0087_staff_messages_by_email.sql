-- Staff messages by email, both ways.
--
-- Written by hand in the style of 0002-0086. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Every message is emailed to its recipient (main / alternate / both, as they
-- chose — staff.email_to), and a reply to that email comes back into the
-- conversation (services/staffMessageEmail.service.js). Nothing existing
-- changes: every message so far reads 'app' and was never emailed.

-- How the message was written: in the dashboard, or as a reply by email.
ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS via varchar(10) NOT NULL DEFAULT 'app';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_messages_via_check') THEN
    ALTER TABLE staff_messages ADD CONSTRAINT staff_messages_via_check
      CHECK (via IN ('app', 'email'));
  END IF;
END $$;

-- The email copy to the recipient: when it went, to which addresses, and why
-- it did not when it did not.
ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS emailed_at timestamptz;
ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS emailed_to text NOT NULL DEFAULT '';
ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS email_error text;

-- The received email a reply came in as (Resend's email_id). Unique, because
-- the provider delivers its webhook at least once: a second delivery of the
-- same email must not post the reply twice.
ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS inbound_email_id varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS staff_messages_inbound_email_idx
  ON staff_messages (inbound_email_id)
  WHERE inbound_email_id IS NOT NULL;
