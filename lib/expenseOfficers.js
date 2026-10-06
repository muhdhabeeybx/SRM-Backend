/**
 * Which expenditure officer an expense belongs to — the owner's rule of
 * 6 Oct 2026.
 *
 *   An expense raised for a filling station or an LPG plant
 *   (delivery_customer_id or lpg_station_id set)     → Ibrahim Adamu (#86)
 *   Every other expense, customer refunds included   → Ismail Adamu (#104)
 *
 * The named officer is the one who verifies it and pays it (lib/expenseChain),
 * is told when it reaches either step (expenseNotifications.service), and is
 * reminded while it waits there (workReminders.service). A super admin may
 * still act on any expense. Being named is the authority: the officer does
 * not also need the expenditure_officer role, and holding that role does not
 * make anybody the officer of an expense they are not named on.
 *
 * Named by staff id, the way the CFO is (EXPENSE_CFO_STAFF_IDS):
 * EXPENSE_OFFICER_STATION_STAFF_IDS and EXPENSE_OFFICER_STAFF_IDS override the
 * defaults, comma-separated.
 */

const idsFrom = (value, fallback) =>
  String(value || fallback)
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

/** The officers for station and LPG plant expenses. */
const stationOfficerIds = () => idsFrom(process.env.EXPENSE_OFFICER_STATION_STAFF_IDS, "86");

/** The officers for every other expense, refunds included. */
const generalOfficerIds = () => idsFrom(process.env.EXPENSE_OFFICER_STAFF_IDS, "104");

/** Raised for a filling station or an LPG plant. Takes a row in either case. */
const isStationExpense = (expense) =>
  (expense?.delivery_customer_id ?? expense?.deliveryCustomerId) != null
  || (expense?.lpg_station_id ?? expense?.lpgStationId) != null;

/** The staff ids of this expense's expenditure officer(s). */
const officerIdsFor = (expense) => (isStationExpense(expense) ? stationOfficerIds() : generalOfficerIds());

/** Is this person named as the expense's officer? */
const isOfficerOf = (user, expense) => user?.id != null && officerIdsFor(expense).includes(Number(user.id));

module.exports = { stationOfficerIds, generalOfficerIds, isStationExpense, officerIdsFor, isOfficerOf };
