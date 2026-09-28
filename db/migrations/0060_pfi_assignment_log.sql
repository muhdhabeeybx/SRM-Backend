-- The record of who was assigned to which PFI: when, by whom, how, and when
-- it ended.
--
-- Written by hand in the style of 0002-0059. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- ── Why this exists ─────────────────────────────────────────────────────────
--
-- pfi_staff holds who is assigned NOW, and nothing else. Nothing recorded a
-- change to it: no audit row was ever written for a staff scope edit, and
-- Manage Users deleted and re-inserted every assignment on every save, so even
-- pfi_staff.created_at only says when the person's row was last saved. Who
-- was on a PFI last month, and who put them there, could not be answered.
--
-- ── What it is ──────────────────────────────────────────────────────────────
--
-- An append-only event log: one row per assignment and per removal. It is
-- written by a trigger on pfi_staff itself, at commit, so every path that
-- changes an assignment is recorded — Manage Users, PFI activation, a deleted account or
-- PFI cascading, a script, a hand-run statement — without depending on each
-- path remembering to. The application says who and how by setting
-- transaction-local settings first (lib/pfiAssignmentContext.js); a change
-- made without them is still recorded, as 'unattributed'.
--
-- Rows are never updated or deleted — a trigger refuses both, and TRUNCATE.
-- A correction is a new row. There are no foreign keys, on purpose: the record
-- must outlive the account and the PFI it describes, so the names are
-- snapshotted onto each row as they were at the time.
--
-- ── Where it starts ─────────────────────────────────────────────────────────
--
-- Every assignment in place when this was first applied gets an opening row
-- (source 'history_start', date_is_approximate true), dated to its pfi_staff
-- created_at. That date is when the assignment was last re-saved, not when it
-- began, and the row says so rather than presenting it as a start date.
-- Nothing earlier can be recovered: no record of it was kept.

CREATE TABLE IF NOT EXISTS pfi_assignment_log (
  id                  bigserial   PRIMARY KEY,
  -- When it happened. For an opening row, the latest date it is known to
  -- have been true by — see date_is_approximate.
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  -- When this row was written. Differs from occurred_at only on opening rows.
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  action              varchar(16) NOT NULL CHECK (action IN ('assigned', 'removed')),

  -- Who was assigned. No foreign key: the record outlives the account.
  staff_id            integer     NOT NULL,
  staff_name          text        NOT NULL DEFAULT '',
  staff_email         text        NOT NULL DEFAULT '',

  -- To what. No foreign key: the record outlives the PFI.
  pfi_id              integer     NOT NULL,
  pfi_number          text        NOT NULL DEFAULT '',

  -- Who made the change, and from where. Null actor: nobody signed in made it
  -- (a script, a cascade outside the app, the opening rows).
  actor_staff_id      integer,
  actor_name          text        NOT NULL DEFAULT '',
  ip_address          text        NOT NULL DEFAULT '',
  user_agent          text        NOT NULL DEFAULT '',

  -- How: manage_users, pfi_activation, account_deleted, pfi_deleted,
  -- history_start, or unattributed.
  source              varchar(32) NOT NULL,
  note                text        NOT NULL DEFAULT '',

  -- True only on the opening rows: the assignment may be older than
  -- occurred_at.
  date_is_approximate boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS pfi_assignment_log_staff_idx ON pfi_assignment_log (staff_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS pfi_assignment_log_pfi_idx   ON pfi_assignment_log (pfi_id, occurred_at, id);

-- ── Append-only ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pfi_assignment_log_refuse_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pfi_assignment_log is append-only: % is not allowed. Record a correction as a new row.', TG_OP;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pfi_assignment_log_no_change ON pfi_assignment_log;
CREATE TRIGGER pfi_assignment_log_no_change
  BEFORE UPDATE OR DELETE ON pfi_assignment_log
  FOR EACH ROW EXECUTE FUNCTION pfi_assignment_log_refuse_change();

DROP TRIGGER IF EXISTS pfi_assignment_log_no_truncate ON pfi_assignment_log;
CREATE TRIGGER pfi_assignment_log_no_truncate
  BEFORE TRUNCATE ON pfi_assignment_log
  FOR EACH STATEMENT EXECUTE FUNCTION pfi_assignment_log_refuse_change();

-- ── Recording every change to pfi_staff ─────────────────────────────────────

-- One row, with the names as they are now. A cascade from a deleted account or
-- PFI can no longer see the row it came from, so the name falls back to the
-- one this log recorded last.
CREATE OR REPLACE FUNCTION pfi_assignment_log_write(p_action text, p_staff integer, p_pfi integer)
RETURNS void AS $$
DECLARE
  v_actor    integer := NULLIF(current_setting('soroman.actor_staff_id', true), '')::integer;
  v_source   text    := COALESCE(NULLIF(current_setting('soroman.assignment_source', true), ''), 'unattributed');
  v_note     text    := COALESCE(current_setting('soroman.assignment_note', true), '');
  v_ip       text    := COALESCE(current_setting('soroman.ip_address', true), '');
  v_agent    text    := COALESCE(current_setting('soroman.user_agent', true), '');
  v_name     text;
  v_email    text;
  v_number   text;
  v_actor_nm text    := '';
BEGIN
  SELECT NULLIF(btrim(concat_ws(' ', s.first_name, s.surname)), ''), s.email
    INTO v_name, v_email
    FROM staff s WHERE s.id = p_staff;
  IF v_name IS NULL THEN
    SELECT l.staff_name, l.staff_email INTO v_name, v_email
      FROM pfi_assignment_log l
     WHERE l.staff_id = p_staff AND l.staff_name <> ''
     ORDER BY l.id DESC LIMIT 1;
  END IF;

  SELECT p.pfi_number INTO v_number FROM pfis p WHERE p.id = p_pfi;
  IF v_number IS NULL THEN
    SELECT l.pfi_number INTO v_number
      FROM pfi_assignment_log l
     WHERE l.pfi_id = p_pfi AND l.pfi_number <> ''
     ORDER BY l.id DESC LIMIT 1;
  END IF;

  IF v_actor IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.surname)), ''), s.email, '')
      INTO v_actor_nm
      FROM staff s WHERE s.id = v_actor;
  END IF;

  INSERT INTO pfi_assignment_log (
    action, staff_id, staff_name, staff_email, pfi_id, pfi_number,
    actor_staff_id, actor_name, ip_address, user_agent, source, note
  ) VALUES (
    p_action, p_staff, COALESCE(v_name, ''), COALESCE(v_email, ''), p_pfi, COALESCE(v_number, ''),
    v_actor, COALESCE(v_actor_nm, ''), v_ip, v_agent, v_source, v_note
  );
END
$$ LANGUAGE plpgsql;

-- What changed for one person on one PFI, recorded once the transaction that
-- changed it commits: the pair is looked at as it now stands and compared with
-- the last thing the log says about it, and only a real difference is written.
--
-- Deferred to commit, and reconciling rather than echoing each statement, on
-- purpose. Code that saves a person by deleting every assignment and inserting
-- them again — what Manage Users did before, and what any build still running
-- that code will do after this is applied — changes nothing, and must record
-- nothing; row-by-row it would log every PFI they hold as ended and begun
-- again, permanently, in a log that cannot be corrected. So an assignment
-- deleted and re-inserted in one transaction is no change; one inserted and
-- deleted again is no change; and a genuine assignment or removal is written
-- exactly once, however many statements it took.
--
-- The transaction's settings (who, how, from where) are still in force at
-- commit, so the record is attributed the same way.
CREATE OR REPLACE FUNCTION pfi_assignment_log_reconcile(p_staff integer, p_pfi integer)
RETURNS void AS $$
DECLARE
  v_now  boolean := EXISTS (SELECT 1 FROM pfi_staff WHERE staff_id = p_staff AND pfi_id = p_pfi);
  v_last text;
BEGIN
  SELECT l.action INTO v_last
    FROM pfi_assignment_log l
   WHERE l.staff_id = p_staff AND l.pfi_id = p_pfi
   ORDER BY l.id DESC LIMIT 1;

  IF v_now AND v_last IS DISTINCT FROM 'assigned' THEN
    PERFORM pfi_assignment_log_write('assigned', p_staff, p_pfi);
  ELSIF NOT v_now AND v_last = 'assigned' THEN
    PERFORM pfi_assignment_log_write('removed', p_staff, p_pfi);
  END IF;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pfi_staff_record_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM pfi_assignment_log_reconcile(OLD.staff_id, OLD.pfi_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pfi_assignment_log_reconcile(NEW.staff_id, NEW.pfi_id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pfi_staff_record_change ON pfi_staff;
CREATE CONSTRAINT TRIGGER pfi_staff_record_change
  AFTER INSERT OR UPDATE OR DELETE ON pfi_staff
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pfi_staff_record_change();

-- ── Opening rows for what is already in place ───────────────────────────────

INSERT INTO pfi_assignment_log (
  occurred_at, action, staff_id, staff_name, staff_email, pfi_id, pfi_number,
  source, note, date_is_approximate
)
SELECT ps.created_at,
       'assigned',
       ps.staff_id,
       COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.surname)), ''), ''),
       COALESCE(s.email, ''),
       ps.pfi_id,
       COALESCE(p.pfi_number, ''),
       'history_start',
       'In place when this record began. The assignment may be older than this date: '
         || 'saving a user used to re-write every assignment, so the date is when it was last saved.',
       true
  FROM pfi_staff ps
  LEFT JOIN staff s ON s.id = ps.staff_id
  LEFT JOIN pfis  p ON p.id = ps.pfi_id
 WHERE NOT EXISTS (
   SELECT 1 FROM pfi_assignment_log l
    WHERE l.staff_id = ps.staff_id AND l.pfi_id = ps.pfi_id
 );
