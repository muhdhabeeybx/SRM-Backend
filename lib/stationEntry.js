const { client } = require("../config/db");
const { STATION_TYPES } = require("./customerTypes");
const { stationVisible, plantVisible } = require("./stationScope");

/**
 * Who may enter a station's records — migration 0067.
 *
 * A station's day is two jobs. What it sold and what it spent is written up
 * from the pump or the till; what it banked is matched off the statement,
 * often by somebody else. Each job can be given to named people, per station,
 * and a PFI at the station can name its own people for either job instead.
 *
 *   sales      a sale or a station expense — a row with a quantity, a sales
 *              value or an expenses amount
 *   deposits   money in — a row with a payment amount, or a credit claimed
 *              off the bank statement
 *
 * Once anybody is named for a kind, rows of that kind at that station (on
 * that PFI) are written, changed and deleted only by them. This narrows who
 * ENTERS and nothing else: everyone who can see the station still sees every
 * row of it.
 *
 * Nobody named leaves the kind open, as it was before — the same rule as every
 * other assignment here: an empty one never reads as "nobody" (see
 * lib/scopeFilter.js). Admins and super admins may always enter, to correct.
 */

const ENTRY_KINDS = ["sales", "deposits"];

/** What a refusal calls each kind. */
const KIND_WORDS = { sales: "Sales and expenses", deposits: "Deposits" };

/** May enter whatever is assigned — to put a wrong row right. */
const ALWAYS_ROLES = ["admin", "super_admin"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const mayAlwaysEnter = (user) =>
  (Array.isArray(user?.roles) ? user.roles : []).some((r) => ALWAYS_ROLES.includes(r));

/**
 * Which kinds one delivery_sales row is, camelCase or snake_case. A row may be
 * both — a sheet line carrying a sale and a payment — and then needs both.
 * A row with no figures at all is neither, and nobody's to guard.
 */
const kindsOfRow = (row) => {
  const kinds = new Set();
  if (!row) return kinds;
  if (num(row.paymentAmount ?? row.payment_amount) !== 0) kinds.add("deposits");
  if (
    num(row.quantity) > 0
    || num(row.salesValue ?? row.sales_value) > 0
    || num(row.expensesAmount ?? row.expenses_amount) > 0
  ) kinds.add("sales");
  return kinds;
};

const stationIdOf = (row) => {
  const v = row?.customerId ?? row?.customer_id ?? null;
  return v == null || v === "" ? null : Number(v);
};

/**
 * The people for one kind on one PFI at one station: the PFI's own when it
 * names any, else the station's. Empty means open. Pure.
 */
const enterersFor = (assignments, stationId, pfiId, kind) => {
  const here = assignments.filter((a) => a.stationId === Number(stationId) && a.kind === kind);
  if (pfiId != null) {
    const own = here.filter((a) => a.pfiId === Number(pfiId));
    if (own.length) return own;
  }
  return here.filter((a) => a.pfiId == null);
};

/** "Ada", "Ada and Bola", "Ada, Bola and Chidi". */
const nameList = (names) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Every assignment, or those at some stations. Each carries the station's
 * type and plant link, so a caller can tell who may see it.
 */
const listAssignments = async (stationIds = null) => {
  const ids = stationIds === null ? null : stationIds.map(Number).filter(Number.isFinite);
  if (ids !== null && ids.length === 0) return [];
  const rows = await client`
    SELECT ses.delivery_customer_id AS station_id,
           ses.pfi_id,
           p.pfi_number,
           ses.entry_kind,
           ses.staff_id,
           COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.surname)), ''), s.email, '') AS staff_name,
           dc.name AS station_name,
           dc.customer_type,
           dc.lpg_station_id
      FROM station_entry_staff ses
      JOIN staff s ON s.id = ses.staff_id
      JOIN delivery_customers dc ON dc.id = ses.delivery_customer_id
      LEFT JOIN pfis p ON p.id = ses.pfi_id
     WHERE ${ids === null ? client`true` : client`ses.delivery_customer_id = ANY(${ids}::int[])`}
     ORDER BY ses.delivery_customer_id, ses.pfi_id NULLS FIRST, ses.entry_kind, staff_name`;
  return rows.map((r) => ({
    stationId: Number(r.station_id),
    stationName: r.station_name,
    customerType: r.customer_type,
    lpgStationId: r.lpg_station_id == null ? null : Number(r.lpg_station_id),
    pfiId: r.pfi_id == null ? null : Number(r.pfi_id),
    pfiNumber: r.pfi_number || null,
    kind: r.entry_kind,
    staffId: Number(r.staff_id),
    staffName: r.staff_name,
  }));
};

/** May this person see the station an assignment is at? Fuel and plant rules both. */
const assignmentVisible = (user, a) =>
  a.customerType === "lpg_plant"
    ? plantVisible(user, { lpgStationId: a.lpgStationId })
    : stationVisible(user, a.stationId);

/**
 * The PFIs a row's load came off — delivery_inventory.pfi_id, which is what
 * the station page files the load under.
 *
 * Found by the load itself first: same plate, same allocation day, the way
 * the station page pairs a sale with its load. Failing that, by the batch
 * code: the PFI its trucks point at, or the PFI that holds the code. Usually
 * one; none when the load has no PFI behind it.
 */
const pfiIdsOfRow = async (row) => {
  const plate = String(row?.truckNumber ?? row?.truck_number ?? "");
  const day = String(row?.dateLoaded ?? row?.date_loaded ?? "").slice(0, 10);
  if (plate.trim() && day) {
    const loads = await client`
      SELECT DISTINCT pfi_id FROM delivery_inventory
       WHERE pfi_id IS NOT NULL
         AND regexp_replace(upper(coalesce(truck_number, '')), '\s', '', 'g')
           = regexp_replace(upper(${plate}), '\s', '', 'g')
         AND left(coalesce(date_allocated, ''), 10) = ${day}`;
    if (loads.length) return loads.map((r) => Number(r.pfi_id));
  }
  const code = String(row?.allocationCode ?? row?.allocation_code ?? "").trim().toUpperCase();
  if (!code) return [];
  const byCode = await client`
    SELECT DISTINCT pfi_id AS id FROM delivery_inventory
     WHERE pfi_id IS NOT NULL AND upper(trim(allocation_code)) = ${code}
    UNION
    SELECT id FROM pfis WHERE upper(trim(allocation_code)) = ${code}`;
  return byCode.map((r) => Number(r.id));
};

/**
 * Why this person may not write these rows, or null when they may.
 *
 * `kinds` overrides what the rows say they are — a credit claimed off the
 * statement is a deposit before it has an amount, and a transfer between
 * trucks moves deposits whatever its rows look like.
 *
 * Rows not at a station, rows that are no kind, and stations nobody is named
 * at all pass without a further query.
 */
const refusalFor = async (user, rows, { kinds: forced = null } = {}) => {
  if (mayAlwaysEnter(user)) return null;
  const atStations = (rows || []).filter((r) => stationIdOf(r) != null);
  if (atStations.length === 0) return null;

  const assignments = await listAssignments([...new Set(atStations.map(stationIdOf))]);
  if (assignments.length === 0) return null;

  const me = Number(user?.id);
  const pfisOf = new Map();
  for (const row of atStations) {
    const stationId = stationIdOf(row);
    const here = assignments.filter((a) => a.stationId === stationId);
    // A plain customer cannot be assigned (the PUT refuses one), but a station
    // whose type was since changed could still have rows here.
    if (here.length === 0 || !STATION_TYPES.includes(here[0].customerType)) continue;
    const kinds = forced ? new Set(forced) : kindsOfRow(row);
    if (kinds.size === 0) continue;

    const loadKey = [row.truckNumber ?? row.truck_number, row.dateLoaded ?? row.date_loaded, row.allocationCode ?? row.allocation_code].join("|");
    if (!pfisOf.has(loadKey)) pfisOf.set(loadKey, await pfiIdsOfRow(row));
    const pfiIds = pfisOf.get(loadKey);

    for (const kind of kinds) {
      for (const pfiId of pfiIds.length ? pfiIds : [null]) {
        const who = enterersFor(here, stationId, pfiId, kind);
        if (who.length === 0 || who.some((a) => a.staffId === me)) continue;
        const onPfi = who[0].pfiId != null ? ` on ${who[0].pfiNumber || `PFI #${who[0].pfiId}`}` : "";
        return `${KIND_WORDS[kind]} at ${here[0].stationName}${onPfi} are entered by ${nameList(who.map((a) => a.staffName))}.`;
      }
    }
  }
  return null;
};

/**
 * Replace who enters each kind at one station, station-wide (pfiId null) or
 * on one PFI. Only the difference is written, so a person kept on keeps the
 * date they were first named. Returns what it was and what it is now.
 */
const setAssignments = async ({ stationId, pfiId = null, staffIds, assignedBy = null }) => {
  const station = Number(stationId);
  const pfi = pfiId == null ? null : Number(pfiId);
  return client.begin(async (tx) => {
    const samePlace = pfi === null ? tx`pfi_id IS NULL` : tx`pfi_id = ${pfi}`;
    const before = await tx`
      SELECT entry_kind, staff_id FROM station_entry_staff
       WHERE delivery_customer_id = ${station} AND ${samePlace}`;
    const was = { sales: [], deposits: [] };
    for (const r of before) was[r.entry_kind].push(Number(r.staff_id));

    for (const kind of ENTRY_KINDS) {
      const next = [...new Set((staffIds[kind] || []).map(Number))];
      const gone = was[kind].filter((id) => !next.includes(id));
      const added = next.filter((id) => !was[kind].includes(id));
      if (gone.length) {
        await tx`
          DELETE FROM station_entry_staff
           WHERE delivery_customer_id = ${station} AND ${samePlace}
             AND entry_kind = ${kind} AND staff_id = ANY(${gone}::int[])`;
      }
      for (const staffId of added) {
        await tx`
          INSERT INTO station_entry_staff (delivery_customer_id, pfi_id, entry_kind, staff_id, assigned_by)
          VALUES (${station}, ${pfi}, ${kind}, ${staffId}, ${assignedBy})
          ON CONFLICT DO NOTHING`;
      }
    }
    const now = {};
    for (const kind of ENTRY_KINDS) now[kind] = [...new Set((staffIds[kind] || []).map(Number))];
    return { was, now };
  });
};

module.exports = {
  ENTRY_KINDS,
  KIND_WORDS,
  mayAlwaysEnter,
  kindsOfRow,
  enterersFor,
  listAssignments,
  assignmentVisible,
  pfiIdsOfRow,
  refusalFor,
  setAssignments,
};
