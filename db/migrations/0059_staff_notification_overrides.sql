-- Which notifications each staff member gets, where an admin has said so.
--
-- Written by hand in the style of 0002-0058. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- The shape is staff_page_overrides' exactly, and it means the same thing: a
-- row is a per-person exception to what their roles would give them. `choice`
-- is a key from notifications/staffChoices.js — one notification or a small
-- family of them ("expenses", "desk_reminders") — and `enabled` says whether
-- this person gets it regardless of role. No row means "whatever their role
-- gets", so nothing changes for anybody until an admin ticks something.

CREATE TABLE IF NOT EXISTS staff_notification_overrides (
  id         serial      PRIMARY KEY,
  staff_id   integer     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  choice     varchar(64) NOT NULL,
  enabled    boolean     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_notification_overrides_unique_idx
  ON staff_notification_overrides (staff_id, choice);
-- The send path asks "who has an exception for this choice", by choice.
CREATE INDEX IF NOT EXISTS staff_notification_overrides_choice_idx
  ON staff_notification_overrides (choice);
