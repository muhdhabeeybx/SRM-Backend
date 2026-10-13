-- The Gantry Tickets page is not everyone's: the owner's instruction of
-- 13 Oct 2026 is admins, Muideen Salami, and the stock officers.
--
-- Written by hand in the style of 0002-0076. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
-- Admins, super admins and stock officers are let in by their role (soromanfe
-- lib/rbac.ts ROLE_OPENED; Sman-Backend services/gantryTickets.service.js
-- maySeeDesk). Muideen Salami (#85) holds none of those roles, so he is given
-- the page by name, with the same per-person grant Manage Users writes — which
-- is also where it can be taken away again.
--
-- DO NOTHING on conflict: this file is re-run on every apply, and a later
-- decision made in Manage Users must not be put back by it.

INSERT INTO staff_page_overrides (staff_id, route_path, allowed)
SELECT s.id, '/gantry-tickets', TRUE
  FROM staff s
 WHERE s.id = 85
    ON CONFLICT (staff_id, route_path) DO NOTHING;
