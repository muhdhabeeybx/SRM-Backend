const asyncHandler = require("express-async-handler");
const { client } = require("../../config/db");
const audit = require("../../services/audit.service");
const { isStationType } = require("../../lib/customerTypes");
const stationEntry = require("../../lib/stationEntry");

/**
 * Who enters a station's sales and expenses, and who enters its deposits —
 * lib/stationEntry.js holds the rule, migration 0067 the table.
 *
 * Read by anybody who can see the station, so the page can say who enters
 * what and offer each person only their own part. Set by admins only: the
 * point is that the person entering a kind is not the person deciding who
 * may, so nobody can hand the other half to themselves.
 */

const actorName = (user) =>
  user ? user.name || [user.firstName, user.surname].filter(Boolean).join(" ") || user.email || "" : "";

const shape = (a) => ({
  stationId: a.stationId,
  pfiId: a.pfiId,
  pfiNumber: a.pfiNumber,
  kind: a.kind,
  staffId: a.staffId,
  staffName: a.staffName,
});

/** GET ?station= — one station's assignments, or every station this person can see. */
const listEntryStaff = asyncHandler(async (req, res) => {
  const station = req.query.station ?? null;
  const rows = await stationEntry.listAssignments(station == null ? null : [station]);
  const visible = rows.filter((a) => stationEntry.assignmentVisible(req.user, a));
  res.json({
    success: true,
    data: {
      assignments: visible.map(shape),
      you: { id: Number(req.user?.id), mayAlwaysEnter: stationEntry.mayAlwaysEnter(req.user) },
    },
  });
});

/** PUT — replace both kinds at one station, station-wide or on one PFI. */
const setEntryStaff = asyncHandler(async (req, res) => {
  const { stationId, pfiId, sales, deposits } = req.body;

  const [station] = await client`
    SELECT id, name, customer_type FROM delivery_customers WHERE id = ${stationId}`;
  if (!station || !isStationType(station.customer_type)) {
    return res.status(404).json({ success: false, message: "Station not found" });
  }

  let pfiNumber = null;
  if (pfiId != null) {
    const [pfi] = await client`SELECT id, pfi_number FROM pfis WHERE id = ${pfiId}`;
    if (!pfi) return res.status(404).json({ success: false, message: "PFI not found" });
    pfiNumber = pfi.pfi_number;
  }

  const named = [...new Set([...sales, ...deposits])];
  if (named.length) {
    const found = await client`
      SELECT id, suspended, is_active FROM staff WHERE id = ANY(${named}::int[])`;
    const live = new Set(found.filter((s) => s.is_active !== false && !s.suspended).map((s) => Number(s.id)));
    const missing = named.filter((id) => !live.has(id));
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: missing.length === 1
          ? "One of those people is not an active member of staff."
          : `${missing.length} of those people are not active members of staff.`,
      });
    }
  }

  const { was, now } = await stationEntry.setAssignments({
    stationId,
    pfiId,
    staffIds: { sales, deposits },
    assignedBy: req.user?.id ?? null,
  });

  const changed = stationEntry.ENTRY_KINDS.some(
    (k) => was[k].length !== now[k].length || was[k].some((id) => !now[k].includes(id)),
  );
  if (changed) {
    await audit.record({
      action: "station.entry_staff_changed",
      actor: { type: "staff", id: req.user?.id ?? null, name: actorName(req.user) },
      entityType: "delivery_customer",
      entityId: stationId,
      metadata: { station: station.name, pfiId, pfiNumber, before: was, after: now },
    });
  }

  const rows = await stationEntry.listAssignments([stationId]);
  res.json({
    success: true,
    message: changed ? "Saved" : "Nothing changed",
    data: { assignments: rows.map(shape) },
  });
});

module.exports = { listEntryStaff, setEntryStaff };
