/**
 * Who may approve moving surplus between orders — the owner's rule of
 * 7 October 2026.
 *
 *   Named: Muideen Salami, the CFO (#85); Usman Manu (#87);
 *          Habeeb Suleiman (#1); General Admin (#39).
 *   And:   any super admin.
 *   Never: the person who asked for that transfer.
 *
 * Named by staff id, the way the CFO and the expense officers are
 * (lib/expenseOfficers.js). TRANSFER_APPROVER_STAFF_IDS overrides the list,
 * comma-separated. Being named is the authority: it needs no particular role.
 */

const idsFrom = (value, fallback) =>
  String(value || fallback)
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

const approverIds = () => idsFrom(process.env.TRANSFER_APPROVER_STAFF_IDS, "85,87,1,39");

const isSuperAdmin = (user) => Array.isArray(user?.roles) && user.roles.includes("super_admin");

/** May this person approve or reject transfer requests at all? */
const mayApprove = (user) => user?.id != null && (isSuperAdmin(user) || approverIds().includes(Number(user.id)));

module.exports = { approverIds, mayApprove, isSuperAdmin };
