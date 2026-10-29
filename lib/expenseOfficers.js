/**
 * Who the expenditure officer is — the owner's rule of 29 Oct 2026.
 *
 *   Every expense — filling station and LPG plant ones, customer refunds,
 *   feeding, loading and owner payments included → Ismail Manu Adamu (#104)
 *
 * From 6 Oct to 29 Oct station and LPG plant expenses had an officer of their
 * own, Ibrahim Adamu (#86). The owner then put them under Ismail with the rest.
 *
 * The named officer is the one who verifies it and pays it (lib/expenseChain),
 * is told when it reaches either step (expenseNotifications.service), and is
 * reminded while it waits there (workReminders.service). A super admin may
 * still act on any expense. Being named is the authority: the officer does
 * not also need the expenditure_officer role, and holding that role does not
 * make anybody the officer of an expense they are not named on.
 *
 * Named by staff id, the way the CFO is (EXPENSE_CFO_STAFF_IDS):
 * EXPENSE_OFFICER_STAFF_IDS overrides the default, comma-separated.
 */

const idsFrom = (value, fallback) =>
  String(value || fallback)
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

/** The expenditure officers — the same for every expense. */
const officerIds = () => idsFrom(process.env.EXPENSE_OFFICER_STAFF_IDS, "104");

/** The staff ids of this expense's expenditure officer(s). */
const officerIdsFor = () => officerIds();

/** Is this person named as the expense's officer? */
const isOfficerOf = (user) => user?.id != null && officerIds().includes(Number(user.id));

module.exports = { officerIds, officerIdsFor, isOfficerOf };
