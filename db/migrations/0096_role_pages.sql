-- Standard pages for each role, and roles given by naming someone on a PFI.
--
-- Written by hand in the style of 0002-0095. Idempotent: it is re-run in full
-- every time by scripts/apply-unjournaled-migrations.js.
--
--   role_pages_switch  one row. While it is off nothing below changes what
--                      anybody sees or holds: pages stay as they are today and
--                      no PFI slot gives a role. Turned on from the Role pages
--                      screen (services/rolePages.service.js).
--   role_page_sets     the pages each role opens. 'everyone' is the set every
--                      signed-in staff member gets. A person's own ticks in
--                      Manage Users (staff_page_overrides) still add to it or
--                      take a page away.
--   staff_pfi_roles    roles a person holds only because a PFI names them in
--                      one of its officer slots (services/pfiRoles.service.js).
--                      staff.roles carries them too, so every desk, text and
--                      gate reads them as it reads any role; this table says
--                      which to take back when the slot is emptied or the PFI
--                      is closed.
--   four new slots     ticketing, gate entry, truck sales and stock officer,
--                      beside the six a PFI already names.
--
-- Nothing changes on its own: the switch starts off and staff_pfi_roles starts
-- empty, so every role held today stays the person's own.

CREATE TABLE IF NOT EXISTS role_pages_switch (
  id          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     boolean     NOT NULL DEFAULT false,
  -- Set once the starting sets below are written, so a re-run never puts back
  -- a page somebody has since taken off.
  seeded      boolean     NOT NULL DEFAULT false,
  changed_by  integer,
  changed_at  timestamptz
);
INSERT INTO role_pages_switch (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS role_page_sets (
  role        varchar(64)  NOT NULL,
  route_path  varchar(255) NOT NULL,
  view_only   boolean      NOT NULL DEFAULT false,
  updated_by  integer,
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (role, route_path)
);

CREATE TABLE IF NOT EXISTS staff_pfi_roles (
  staff_id  integer     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  role      varchar(64) NOT NULL,
  given_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, role)
);

ALTER TABLE pfis ADD COLUMN IF NOT EXISTS ticketing_officer_id integer REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS ticketing_officer_name varchar(255) DEFAULT '';
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS gate_entry_officer_id integer REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS gate_entry_officer_name varchar(255) DEFAULT '';
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS truck_sales_officer_id integer REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS truck_sales_officer_name varchar(255) DEFAULT '';
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS stock_officer_id integer REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE pfis ADD COLUMN IF NOT EXISTS stock_officer_name varchar(255) DEFAULT '';

-- The owner's lists of 22 Oct 2026. Roles nobody listed (expenditure,
-- transport, audit, LPG) start from the draft they were shown, to be changed
-- on the Role pages screen. Gantry Tickets is not here: the stock officer role
-- opens it already (soromanfe lib/rbac.ts ROLE_OPENED).
DO $$
BEGIN
  IF NOT (SELECT seeded FROM role_pages_switch WHERE id = 1) THEN
    INSERT INTO role_page_sets (role, route_path, view_only) VALUES
      ('everyone', '/overview', false),
      ('everyone', '/messages', false),
      ('everyone', '/my-report', false),
      ('everyone', '/expense-requests', false),
      ('everyone', '/profile', false),

      ('finance', '/orders', false),
      ('finance', '/payable-orders', false),
      ('finance', '/confirmed-payments', false),

      ('sales_manager', '/orders', false),
      ('sales_manager', '/admin-order', false),

      ('product_manager', '/orders', false),

      ('commissions', '/orders', false),
      ('commissions', '/commissions', false),

      ('it_compliance', '/orders', false),
      ('it_compliance', '/people', false),

      ('security_exit', '/orders', false),
      ('security_exit', '/security/exit', false),
      ('security_exit', '/security/entry', false),
      ('security_exit', '/security-report', false),
      ('security_entry', '/orders', false),
      ('security_entry', '/security/exit', false),
      ('security_entry', '/security/entry', false),
      ('security_entry', '/security-report', false),

      ('ticketing', '/orders', false),
      ('ticketing', '/ticket', false),
      ('dispatch', '/orders', false),
      ('dispatch', '/ticket', false),
      ('release', '/orders', false),
      ('release', '/ticket', false),

      ('truck_sales', '/delivery-operations', false),
      ('truck_sales', '/sales-ledger', false),
      ('truck_sales', '/delivery-customer', false),
      ('truck_sales', '/filing-stations', false),
      ('truck_sales', '/lpg/plants', false),

      ('stock_officer', '/orders', false),

      ('expenditure_officer', '/expenses', false),
      ('expenditure_officer', '/vendors', false),
      ('expenditure_officer', '/bank-statements', true),

      ('transport', '/fleet-trucks', false),
      ('transport', '/fleet-ledger', false),
      ('transport', '/ago-ledger', false),
      ('transport', '/delivery-operations', false),

      ('audit', '/orders', true),
      ('audit', '/payable-orders', true),
      ('audit', '/confirmed-payments', true),
      ('audit', '/deposits', true),
      ('audit', '/bank-statements', true),
      ('audit', '/sales-ledger', true),
      ('audit', '/expenses', true),
      ('audit', '/security-report', true),
      ('audit', '/pfi', true),
      ('audit', '/admin-reports', true),
      ('audit', '/activity', true),

      ('lpg_plants', '/lpg/plants', false),
      ('lpg_plants', '/sales-ledger', false),
      ('lpg_sales', '/lpg/plants', false),
      ('lpg_sales', '/sales-ledger', false),
      ('lpg_stock', '/lpg/plants', false),
      ('lpg_stock', '/sales-ledger', false),
      ('lpg_dashboard', '/lpg/plants', false),
      ('lpg_dashboard', '/sales-ledger', false)
    ON CONFLICT (role, route_path) DO NOTHING;

    UPDATE role_pages_switch SET seeded = true WHERE id = 1;
  END IF;
END
$$;
