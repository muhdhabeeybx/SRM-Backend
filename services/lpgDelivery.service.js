const { client } = require("../config/db");
const { plantVisible } = require("../lib/stationScope");

/**
 * An LPG plant's deliveries, recorded in full — the owner's rule of 7 October
 * 2026: the truck, the driver, when it loaded and when it delivered, the kg
 * loaded and the kg the plant received, and what the gas cost per kg.
 *
 * ── A delivery is a load on the inventory ──────────────────────────────────
 *
 * Each one is a delivery_inventory row with the plant as its customer — the
 * row every screen already reads a delivery from: the plant's account (stock
 * in its tanks, the value handed over), its PFI files, and the LPG stock
 * register's "received". quantity_allocated is what the plant RECEIVED;
 * quantity_loaded (0072) what left the loading point. product_price is the
 * cost per kg, as delivery costing keeps it for every other load.
 *
 * ── Record only, for now ───────────────────────────────────────────────────
 *
 * The PFI is named so the delivery sits in that cargo's file, but nothing is
 * taken off the PFI's stock and no order, allocation or approval is made: the
 * owner is loading history before plants follow the standard route. Any
 * PFI selling a product weighed in kg may be named.
 *
 * ── Uploads ────────────────────────────────────────────────────────────────
 *
 * Many at once, all or nothing, and the same file twice is safe: a delivery
 * already recorded — this plant, this truck, this day, these kg received — is
 * skipped and said so. A preview runs every check and writes nothing.
 */

const httpError = (status, message, details) =>
  Object.assign(new Error(message), { status, statusCode: status, details });

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const plate = (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase();
const day = (v) => {
  const s = String(v ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
};
const round2 = (v) => Math.round(Number(v) * 100) / 100;

/** Same gate as delivery costing: costs are seen, and so set, by whoever may open it. */
const COSTING_ROUTE = "/delivery-costing";
const maySeeCosts = (user) => {
  if (!user) return false;
  const override = (user.pageOverrides || []).find((o) => o.routePath === COSTING_ROUTE);
  if (override) return Boolean(override.allowed);
  return (user.roles || []).includes("super_admin");
};

async function loadPlant(plantId, user) {
  const [plant] = await client`
    SELECT id, name, customer_type, lpg_station_id AS "lpgStationId"
      FROM delivery_customers WHERE id = ${Number(plantId)}`;
  if (!plant || plant.customer_type !== "lpg_plant") throw httpError(404, "LPG plant not found");
  if (!plantVisible(user, plant)) throw httpError(404, "LPG plant not found");
  return plant;
}

/** The PFIs a delivery may name: any selling a product weighed in kg. */
async function lpgPfis() {
  return client`
    SELECT p.id, p.pfi_number AS "pfiNumber", pr.name AS "productName"
      FROM pfis p JOIN products pr ON pr.id = p.product_id
     WHERE lower(trim(pr.unit)) IN ('kg', 'kgs', 'kilogram', 'kilograms')
     ORDER BY p.id DESC`;
}

/**
 * A PFI named in a file, found among the LPG PFIs: its id, its full number,
 * or the short form people write ("PFI 51/26", "PFI 51").
 */
const pfiFinder = (pfis) => {
  const squash = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9/]/g, "");
  const shortOf = (v) => {
    const m = String(v ?? "").toUpperCase().match(/PFI\D*(\d+)(?:\s*\/\s*(\d{2}))?/);
    return m ? `${m[1]}${m[2] ? `/${m[2]}` : ""}` : null;
  };
  return (given) => {
    if (given == null || given === "") return { error: "No PFI given" };
    if (/^\d+$/.test(String(given).trim())) {
      const byId = pfis.find((p) => Number(p.id) === Number(given));
      if (byId) return { pfi: byId };
    }
    const exact = pfis.filter((p) => squash(p.pfiNumber) === squash(given));
    if (exact.length === 1) return { pfi: exact[0] };
    const s = shortOf(given);
    if (s) {
      const hits = pfis.filter((p) => shortOf(p.pfiNumber) === s
        || (!s.includes("/") && shortOf(p.pfiNumber)?.split("/")[0] === s));
      if (hits.length === 1) return { pfi: hits[0] };
      if (hits.length > 1) return { error: `"${given}" matches ${hits.length} LPG PFIs — write it in full` };
    }
    return { error: `No LPG PFI "${given}" — create it in PFI Tracking first` };
  };
};

/** Checks one delivery and turns it into the row to write, or says what is wrong. */
function shapeRow(input, { findPfi, trucksByPlate, trucksById, costsAllowed }) {
  const problems = [];
  const dateDelivered = day(input.dateDelivered);
  const dateLoaded = input.dateLoaded ? day(input.dateLoaded) : null;
  if (!dateDelivered) problems.push("Date delivered is missing or not a date");
  if (input.dateLoaded && !dateLoaded) problems.push("Date loaded is not a date");
  if (dateLoaded && dateDelivered && dateLoaded > dateDelivered) problems.push("Loaded after it was delivered");

  const received = num(input.kgReceived);
  const loaded = num(input.kgLoaded);
  if (!(received > 0)) problems.push("Kg received must be more than 0");
  if (input.kgLoaded != null && input.kgLoaded !== "" && !(loaded > 0)) problems.push("Kg loaded must be more than 0");

  const cost = num(input.costPerKg);
  if (input.costPerKg != null && input.costPerKg !== "") {
    if (!costsAllowed) problems.push("Only someone with Delivery Costing access can set the cost per kg");
    else if (!(cost > 0)) problems.push("Cost per kg must be more than 0");
  }

  const { pfi, error: pfiError } = findPfi(input.pfi ?? input.pfiId);
  if (pfiError) problems.push(pfiError);

  let truck = input.truckId ? trucksById.get(Number(input.truckId)) : null;
  if (input.truckId && !truck) problems.push("That truck is not on the fleet register");
  if (!truck && input.truckNumber) truck = trucksByPlate.get(plate(input.truckNumber)) || null;
  const truckNumber = truck ? truck.plate_number : String(input.truckNumber ?? "").trim().toUpperCase();
  if (!truckNumber) problems.push("Truck is missing");

  const driver = String(input.driverName ?? "").trim() || (truck?.driver_name ?? "");

  return {
    problems,
    row: {
      truckId: truck ? Number(truck.id) : null,
      truckNumber,
      driverName: driver.slice(0, 255),
      pfiId: pfi ? Number(pfi.id) : null,
      pfiNumber: pfi?.pfiNumber ?? "",
      productName: pfi?.productName ?? "",
      dateLoaded: dateLoaded || dateDelivered,
      dateDelivered,
      kgReceived: received > 0 ? round2(received) : null,
      kgLoaded: loaded > 0 ? round2(loaded) : null,
      costPerKg: costsAllowed && cost > 0 ? round2(cost) : null,
      note: String(input.note ?? "").trim().slice(0, 1000),
    },
  };
}

const dupKey = (r) => `${plate(r.truckNumber)}|${r.dateDelivered}|${Number(r.kgReceived).toFixed(2)}`;

/**
 * Check, and unless it is a preview, record. Returns every row with what
 * became of it: "new" (recorded), "already recorded", or its problems.
 */
/** The signed-in person's name as the ledger writes it ("First Surname"), else their email — verifyStaff carries it as `name`. */
const actorName = (user) =>
  user ? user.name || [user.firstName, user.surname].filter(Boolean).join(" ") || user.email || "" : "";

async function record({ plantId, rows, dryRun = false, user }) {
  const plant = await loadPlant(plantId, user);
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, "No deliveries to record");
  if (rows.length > 2000) throw httpError(400, "Too many rows in one go — split the file");

  const costsAllowed = maySeeCosts(user);
  const findPfi = pfiFinder(await lpgPfis());
  const trucks = await client`SELECT id, plate_number, driver_name FROM fleet_trucks`;
  const trucksByPlate = new Map(trucks.map((t) => [plate(t.plate_number), t]));
  const trucksById = new Map(trucks.map((t) => [Number(t.id), t]));

  const existing = await client`
    SELECT truck_number, date_offloaded, quantity_allocated FROM delivery_inventory
     WHERE customer_id = ${Number(plant.id)} AND date_offloaded IS NOT NULL`;
  const onFile = new Set(existing.map((e) => dupKey({ truckNumber: e.truck_number, dateDelivered: String(e.date_offloaded).slice(0, 10), kgReceived: e.quantity_allocated })));

  const seen = new Set();
  const results = rows.map((input, i) => {
    const { problems, row } = shapeRow(input || {}, { findPfi, trucksByPlate, trucksById, costsAllowed });
    if (problems.length) return { line: i + 1, status: "error", problems, row };
    const key = dupKey(row);
    if (onFile.has(key)) return { line: i + 1, status: "already recorded", problems: [], row };
    if (seen.has(key)) return { line: i + 1, status: "repeated in this file", problems: [], row };
    seen.add(key);
    return { line: i + 1, status: "new", problems: [], row };
  });

  const errors = results.filter((r) => r.status === "error");
  const fresh = results.filter((r) => r.status === "new");
  const summary = {
    rows: results.length,
    toRecord: fresh.length,
    alreadyRecorded: results.filter((r) => r.status === "already recorded").length,
    repeated: results.filter((r) => r.status === "repeated in this file").length,
    errors: errors.length,
    kgReceived: round2(fresh.reduce((s, r) => s + r.row.kgReceived, 0)),
  };
  if (dryRun || errors.length || !fresh.length) {
    return { plant: { id: Number(plant.id), name: plant.name }, results, summary, recorded: 0, costsAllowed };
  }

  const actor = actorName(user);
  await client.begin(async (tx) => {
    for (const { row } of fresh) {
      await tx`
        INSERT INTO delivery_inventory
          (truck_id, truck_number, driver_name, pfi_id, pfi_number, pfi_product, customer_id, customer_name,
           quantity_allocated, quantity_loaded, rate, date_allocated, date_offloaded, loading_status,
           location, notes, product_price, costed_at, costed_by, created_by, offloaded_by)
        VALUES (${row.truckId}, ${row.truckNumber}, ${row.driverName || null}, ${row.pfiId}, ${row.pfiNumber},
                ${row.productName}, ${Number(plant.id)}, ${plant.name}, ${row.kgReceived}, ${row.kgLoaded}, '0',
                ${row.dateLoaded}, ${row.dateDelivered}, 'offloaded', ${plant.name}, ${row.note},
                ${row.costPerKg == null ? null : row.costPerKg.toFixed(2)},
                CASE WHEN ${row.costPerKg != null} THEN now() END, ${row.costPerKg == null ? null : actor || null},
                ${actor || "System"}, ${actor || null})`;
    }
    await tx`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, actor_staff_id, metadata)
      VALUES ('delivery_customer', ${Number(plant.id)}, 'lpg.deliveries_recorded',
              ${user?.id ? "staff" : "system"}, ${user?.id ?? null},
              ${JSON.stringify({ count: fresh.length, kgReceived: summary.kgReceived, skipped: summary.alreadyRecorded + summary.repeated })}::jsonb)`;
  });
  return { plant: { id: Number(plant.id), name: plant.name }, results, summary, recorded: fresh.length, costsAllowed };
}

/** A plant's deliveries, newest first, costs only for those who may see them. */
async function list({ plantId, user }) {
  const plant = await loadPlant(plantId, user);
  const rows = await client`
    SELECT d.id, d.truck_id AS "truckId", d.truck_number AS "truckNumber", d.driver_name AS "driverName",
           d.pfi_id AS "pfiId", d.pfi_number AS "pfiNumber", d.date_allocated AS "dateLoaded",
           d.date_offloaded AS "dateDelivered", d.quantity_allocated AS "kgReceived",
           d.quantity_loaded AS "kgLoaded", d.product_price AS "costPerKg", d.notes AS note,
           d.created_by AS "recordedBy", d.created_at AS "recordedAt"
      FROM delivery_inventory d
     WHERE d.customer_id = ${Number(plant.id)}
     ORDER BY COALESCE(d.date_offloaded, d.date_allocated) DESC, d.id DESC`;
  const costsAllowed = maySeeCosts(user);
  return {
    plant: { id: Number(plant.id), name: plant.name },
    costsAllowed,
    deliveries: rows.map((r) => ({
      ...r,
      id: Number(r.id),
      kgReceived: num(r.kgReceived),
      kgLoaded: num(r.kgLoaded),
      costPerKg: costsAllowed ? num(r.costPerKg) : undefined,
    })),
  };
}

async function loadDelivery(id, user) {
  const [d] = await client`
    SELECT d.*, c.customer_type, c.lpg_station_id AS "lpgStationId", c.name AS plant_name
      FROM delivery_inventory d JOIN delivery_customers c ON c.id = d.customer_id
     WHERE d.id = ${Number(id)}`;
  if (!d || d.customer_type !== "lpg_plant") throw httpError(404, "Delivery not found");
  if (!plantVisible(user, { lpgStationId: d.lpgStationId })) throw httpError(404, "Delivery not found");
  return d;
}

/** Correct one delivery. Every field is checked as an upload's would be. */
async function update({ id, patch, user }) {
  const d = await loadDelivery(id, user);
  const costsAllowed = maySeeCosts(user);
  const merged = {
    truckId: patch.truckId !== undefined ? patch.truckId : d.truck_id,
    truckNumber: patch.truckNumber !== undefined ? patch.truckNumber : d.truck_number,
    driverName: patch.driverName !== undefined ? patch.driverName : d.driver_name,
    pfi: patch.pfiId !== undefined ? patch.pfiId : d.pfi_id,
    dateLoaded: patch.dateLoaded !== undefined ? patch.dateLoaded : d.date_allocated,
    dateDelivered: patch.dateDelivered !== undefined ? patch.dateDelivered : d.date_offloaded,
    kgReceived: patch.kgReceived !== undefined ? patch.kgReceived : d.quantity_allocated,
    kgLoaded: patch.kgLoaded !== undefined ? patch.kgLoaded : d.quantity_loaded,
    costPerKg: patch.costPerKg !== undefined ? patch.costPerKg : (costsAllowed ? d.product_price : undefined),
    note: patch.note !== undefined ? patch.note : d.notes,
  };
  const trucks = await client`SELECT id, plate_number, driver_name FROM fleet_trucks`;
  const { problems, row } = shapeRow(merged, {
    findPfi: pfiFinder(await lpgPfis()),
    trucksByPlate: new Map(trucks.map((t) => [plate(t.plate_number), t])),
    trucksById: new Map(trucks.map((t) => [Number(t.id), t])),
    costsAllowed,
  });
  if (problems.length) throw httpError(400, problems.join(". "));
  const actor = actorName(user);
  const costChanged = costsAllowed && patch.costPerKg !== undefined;
  const [saved] = await client`
    UPDATE delivery_inventory SET
      truck_id = ${row.truckId}, truck_number = ${row.truckNumber}, driver_name = ${row.driverName || null},
      pfi_id = ${row.pfiId}, pfi_number = ${row.pfiNumber}, pfi_product = ${row.productName},
      quantity_allocated = ${row.kgReceived}, quantity_loaded = ${row.kgLoaded},
      date_allocated = ${row.dateLoaded}, date_offloaded = ${row.dateDelivered}, notes = ${row.note},
      product_price = CASE WHEN ${costChanged} THEN ${row.costPerKg == null ? null : row.costPerKg.toFixed(2)}::numeric ELSE product_price END,
      costed_at = CASE WHEN ${costChanged} THEN now() ELSE costed_at END,
      costed_by = CASE WHEN ${costChanged} THEN ${actor || null} ELSE costed_by END,
      updated_at = now()
     WHERE id = ${Number(id)}
    RETURNING id`;
  await client`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, actor_staff_id, metadata)
    VALUES ('delivery_inventory', ${Number(id)}, 'lpg.delivery_updated', ${user?.id ? "staff" : "system"}, ${user?.id ?? null},
            ${JSON.stringify({ plant: d.plant_name, before: { truck: d.truck_number, date: d.date_offloaded, kg: d.quantity_allocated }, after: { truck: row.truckNumber, date: row.dateDelivered, kg: row.kgReceived } })}::jsonb)`;
  return { id: Number(saved.id) };
}

/** Take a delivery off the record, keeping a copy of it in the audit log. */
async function remove({ id, user }) {
  const d = await loadDelivery(id, user);
  const [used] = await client`SELECT count(*)::int AS n FROM delivery_sales WHERE customer_id = ${d.customer_id}
                               AND upper(replace(truck_number, ' ', '')) = ${plate(d.truck_number)}
                               AND left(date_loaded, 10) = ${String(d.date_allocated || "").slice(0, 10)}`;
  if (used.n > 0) throw httpError(409, "Sales or money are entered against this truck's load — move or delete those first.");
  await client.begin(async (tx) => {
    await tx`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, actor_staff_id, metadata)
      VALUES ('delivery_inventory', ${Number(id)}, 'lpg.delivery_deleted', ${user?.id ? "staff" : "system"}, ${user?.id ?? null},
              ${JSON.stringify({ plant: d.plant_name, delivery: d })}::jsonb)`;
    await tx`DELETE FROM delivery_inventory WHERE id = ${Number(id)}`;
  });
  return { id: Number(id) };
}

module.exports = { record, list, update, remove, lpgPfis, maySeeCosts };
