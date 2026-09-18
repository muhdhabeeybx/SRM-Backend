-- The CFO report is for three people.
--
-- The report is the company's money on one sheet — per batch, per day, what
-- sold, what came in, what it cost, what is left. It was asked to be visible
-- to Habeeb Suleiman, General Admin and Muideen Salami, and to nobody else.
--
-- ── Why rows here and not a role ──────────────────────────────────────────
--
-- There is no role that means "these three". Two of them hold super_admin
-- (staff 1 and 39) and the third is finance (staff 85) — and both of those
-- roles are held by people the request excludes: four staff hold super_admin,
-- and six hold finance. Any role-shaped rule admits the wrong people, so the
-- grant is per-person, which is what staff_page_overrides is for.
--
-- ── Why every other row is written, and not left absent ───────────────────
--
-- The server refuses this report unless an explicit allow exists, so the deny
-- rows below change nothing about what the API will answer. They are here for
-- the DASHBOARD, which falls back to the role-derived page list when a route
-- has no row — so without them the sidebar would keep offering the page to
-- people the API now refuses. That disagreement, a page shown and then refused
-- with nothing on screen to say which layer was wrong, is the documented
-- reason role gating was switched off dashboard-wide. Writing both sides of
-- the allowlist is what keeps the menu and the endpoint saying the same thing.
--
-- This covers the 43 staff on record now. A staff member created later gets no
-- row and is refused by the server regardless — see the header of
-- middleware/cfoReportAccess.js for why absence is refusal here, unlike
-- /delivery-costing.
--
-- ── Idempotent ────────────────────────────────────────────────────────────
--
-- ON CONFLICT rewrites `allowed` on the unique (staff_id, route_path) index,
-- so re-running restores exactly this allowlist rather than failing or, worse,
-- half-applying. Note that means a hand-granted exception is REVOKED by a
-- re-run; the allowlist in this file is the record of who may see the report.

-- Deny first, so that a re-run cannot leave somebody admitted by a row this
-- file no longer writes. The three grants follow and win on conflict.
INSERT INTO staff_page_overrides (staff_id, route_path, allowed)
SELECT s.id, '/cfo-report', FALSE
  FROM staff s
 WHERE s.id NOT IN (1, 39, 85)
    ON CONFLICT (staff_id, route_path)
    DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO staff_page_overrides (staff_id, route_path, allowed)
SELECT s.id, '/cfo-report', TRUE
  FROM staff s
 WHERE s.id IN (1, 39, 85)
    ON CONFLICT (staff_id, route_path)
    DO UPDATE SET allowed = EXCLUDED.allowed;
