-- Every message the platform sends, one row each, with what it cost.
--
-- Written by hand in the style of 0002-0063. Idempotent.
--
-- ── Why notification_deliveries was not enough ─────────────────────────────
--
-- It records what the notification ENGINE sends, and nothing else. The order
-- invoice SMS, the ticket SMS, every OTP, the Dangote and LPG texts, the PFI
-- review text, the desk nudges and every WhatsApp reply go out around the
-- engine, straight through services/sms.service.js or whatsapp/client.js, and
-- left no row at all. And no row anywhere said what a message cost.
--
-- ── Where rows come from ───────────────────────────────────────────────────
--
--   origin 'app'       written at the moment of sending, at the provider
--                      boundary itself (sms.service route, email sendMail and
--                      the engine's email channel, whatsapp sendReply) — the
--                      only places a message can leave from, so nothing that
--                      leaves can miss them.
--   origin 'provider'  found in Termii's own message history and not sent
--                      through the app's log: everything before this table
--                      existed, and anything sent from Termii's dashboard.
--
-- ── What it cost ───────────────────────────────────────────────────────────
--
-- `amount` is what Termii says it deducted, read from its message history
-- (services/messageLog.service.js syncTermii). NULL means not known yet — the
-- sync fills it within the half hour — or not billed per message: email is not,
-- and WhatsApp is billed by Meta per conversation, not per message.
CREATE TABLE IF NOT EXISTS message_log (
  id                   bigserial PRIMARY KEY,
  channel              varchar(16)  NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp')),
  provider             varchar(20)  NOT NULL,
  provider_message_id  varchar(255) NOT NULL DEFAULT '',
  recipient            varchar(255) NOT NULL DEFAULT '',
  recipient_name       varchar(255) NOT NULL DEFAULT '',
  -- Who it went to, as a kind of person. 'unknown' until a phone or address is
  -- matched against staff, customers, drivers, stations and contacts.
  audience             varchar(20)  NOT NULL DEFAULT 'unknown'
                         CHECK (audience IN ('customer', 'staff', 'driver', 'station', 'contact', 'unknown')),
  staff_id             integer,
  customer_id          integer,
  -- transactional: something that happened to them; campaign: a broadcast;
  -- otp: a sign-in or verification code.
  category             varchar(20)  NOT NULL DEFAULT 'transactional'
                         CHECK (category IN ('transactional', 'campaign', 'otp')),
  -- What it was: the notification type ("order.paid"), or the sender's label.
  type                 varchar(64)  NOT NULL DEFAULT '',
  campaign_id          integer,
  -- Termii's route (dnd / generic) or sms_type from its history.
  route                varchar(20)  NOT NULL DEFAULT '',
  sender               varchar(64)  NOT NULL DEFAULT '',
  subject              text         NOT NULL DEFAULT '',
  body                 text         NOT NULL DEFAULT '',
  -- sent | failed | delivered | skipped — ours; provider_status is theirs, verbatim.
  status               varchar(24)  NOT NULL DEFAULT 'sent',
  provider_status      varchar(64)  NOT NULL DEFAULT '',
  error                text,
  amount               numeric(12,4),
  currency             varchar(8)   NOT NULL DEFAULT '',
  origin               varchar(20)  NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'provider')),
  sent_at              timestamptz  NOT NULL DEFAULT now(),
  cost_synced_at       timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE message_log IS
  'Every SMS, email and WhatsApp message the platform sent, with Termii''s charge for each SMS. See services/messageLog.service.js.';

-- One row per provider message: the send-time row and the history row for the
-- same SMS are the same row.
CREATE UNIQUE INDEX IF NOT EXISTS message_log_provider_message_idx
  ON message_log (provider, provider_message_id)
  WHERE provider_message_id <> '';

CREATE INDEX IF NOT EXISTS message_log_sent_idx ON message_log (sent_at DESC);
CREATE INDEX IF NOT EXISTS message_log_channel_sent_idx ON message_log (channel, sent_at DESC);
CREATE INDEX IF NOT EXISTS message_log_unclassified_idx ON message_log (id) WHERE audience = 'unknown';
