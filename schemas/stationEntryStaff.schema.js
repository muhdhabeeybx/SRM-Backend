const z = require("zod");
const { id } = require("./fields");

/** Who enters a station's records — lib/stationEntry.js, migration 0067. */

const listEntryStaff = z.object({
  station: id("Station").optional(),
});

const staffList = (label) => z.array(id(label)).max(50, `Too many people for ${label.toLowerCase()}`);

/**
 * One station, station-wide or one PFI, both kinds at once. An empty list
 * names nobody for that kind — open to anyone there again, or on a PFI, back
 * to the station's people.
 */
const setEntryStaff = z.object({
  stationId: id("Station"),
  pfiId: id("PFI").nullable().optional().default(null),
  sales: staffList("Sales and expenses").default([]),
  deposits: staffList("Deposits").default([]),
});

module.exports = { listEntryStaff, setEntryStaff };
