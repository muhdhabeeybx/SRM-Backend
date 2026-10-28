const asyncHandler = require("express-async-handler");
const { staffRepo, staffScopeRepo } = require("../../repositories");
const { PFI_SLOTS } = require("../../lib/pfiSlots");
const { isConfined, pfiScopedOpen } = require("../../lib/pfiScope");
const rolePages = require("../../services/rolePages.service");
const pfiRoles = require("../../services/pfiRoles.service");

/**
 * The Role pages screen (migration 0096): the pages each role opens, the
 * switch that makes them decide people's pages, and what changes for each
 * person when it does.
 *
 * Read by any signed-in staff member — Manage Users needs the sets to show
 * what a person's roles already give. Changed by admins only (the route).
 */

/** GET / — the sets, the switch, and the PFI slots with the role each gives. */
const getRolePages = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      ...(await rolePages.overview()),
      // A slot that gives another role on a trucking PFI is listed under both.
      slots: PFI_SLOTS.flatMap((s) => [
        { key: s.idKey, label: s.label, role: s.role },
        ...(s.trucking ? [{ key: s.idKey, label: `${s.label} (trucking PFI)`, role: s.trucking }] : []),
      ]),
    },
  });
});

/** PUT /:role — replace one role's pages. */
const setRolePages = asyncHandler(async (req, res) => {
  const pages = await rolePages.setPages(req.params.role, req.body.pages, req.user?.id ?? null);
  res.json({ success: true, message: "Pages saved", data: { role: req.params.role, pages } });
});

/**
 * PUT /switch — turn role pages on or off.
 *
 * On: every open PFI slot gives its role now. Off: every role a PFI gave is
 * taken back, and pages are decided as they were before.
 */
const setSwitch = asyncHandler(async (req, res) => {
  const enabled = req.body.enabled === true;
  const actorId = req.user?.id ?? null;
  await rolePages.setEnabled(enabled, actorId);
  const changes = enabled ? await pfiRoles.recompute({ actorId }) : await pfiRoles.takeBackAll({ actorId });
  res.json({
    success: true,
    message: enabled ? "Role pages are on" : "Role pages are off",
    data: { ...(await rolePages.overview()), changed: changes.length },
  });
});

/**
 * GET /preview — every active account, with the roles they hold, the roles
 * their open PFI slots give, and what decides their pages today. The
 * dashboard works out pages before and after from this with the same rule
 * the menu uses (soromanfe lib/rbac.ts), so the two cannot disagree.
 */
const getPreview = asyncHandler(async (req, res) => {
  const { staff } = await staffRepo.findAll({ page: 1, limit: 1000 });
  const people = staff.filter((s) => s.isActive && !s.suspended);
  const ids = people.map((s) => s.id);
  const [scopeByStaff, overridesByStaff, slotsByStaff, slots] = await Promise.all([
    staffScopeRepo.getScopeWithNamesForStaffIds(ids),
    staffScopeRepo.getPageOverridesForStaffIds(ids),
    pfiRoles.forStaff(ids),
    pfiRoles.slotsNaming(ids),
  ]);

  const rows = people.map((s) => {
    const roles = s.roles || [];
    const given = slotsByStaff.get(s.id)?.pfiRoles || [];
    const ownRoles = roles.filter((r) => !given.includes(r));
    const fromPfis = {};
    for (const slot of slots) {
      if (slot.staffId !== s.id || !slot.open) continue;
      (fromPfis[slot.role] ||= []).push(slot.pfiNumber);
    }
    const superAdmin = roles.includes("super_admin");
    return {
      id: s.id,
      name: [s.firstName, s.surname].filter(Boolean).join(" ") || s.email,
      email: s.email,
      roles,
      ownRoles,
      // role -> the open PFIs whose slots give it
      fromPfis,
      pfiScoped: !superAdmin && isConfined({ canViewAllLocations: s.canViewAllLocations, scope: scopeByStaff.get(s.id) }),
      pfiScopedOpen: pfiScopedOpen({ scope: scopeByStaff.get(s.id) }),
      pageOverrides: (overridesByStaff.get(s.id) || []).map((o) => ({ routePath: o.routePath, allowed: o.allowed, viewOnly: Boolean(o.viewOnly) })),
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data: { people: rows } });
});

module.exports = { getRolePages, setRolePages, setSwitch, getPreview };
