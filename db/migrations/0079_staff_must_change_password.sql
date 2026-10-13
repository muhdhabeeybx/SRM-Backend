-- A password a super admin set for someone, which they must replace with
-- their own at their next sign-in.
--
-- Written by hand in the style of 0002-0078. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Nothing existing changes: one new column, false for everybody, which is
-- exactly how every account behaves today.
--
-- While it is true the API answers nothing but "choose your password"
-- (middleware/verifyStaff.js); changing it, or setting it through a reset
-- link, clears it.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
