const { client } = require("../db");
const { lagosToday } = require("../lib/zonedDay");
const { tripAgoFor } = require("../lib/tripAgo");

/**
 * The AGO stock ledger (0093): the company's own diesel. A balance to start
 * from, stock bought in, AGO given to trucks trip by trip, top-ups and
 * retrievals on those trips, and the balance after every entry.
 *
 * ── The balance is worked out, never stored ───────────────────────────────
 *
 * Every read sorts the live entries into book order and runs the balance down
 * them. A stored balance would go stale the moment an entry was corrected or
 * back-dated; this one cannot disagree with its entries.
 *
 * Book order is the day, then within a day the opening and stock bought in
 * first — stock that came in that day was there to give that day — then
 * everything else in the order it was entered.
 *
 * ── What every write must leave true ──────────────────────────────────────
 *
 *   the stock never goes below nothing, at any entry
 *   nothing is dated before the opening balance, or after today
 *   a top-up or retrieval is not dated before the AGO given it changes
 *   no more is retrieved from a trip than it was given
 *   a trip is given its AGO once (more for the same trip is a top-up)
 *
 * Each write takes one advisory lock, reads every live entry, applies the
 * change in memory, checks the whole book, and only then writes — so two
 * people giving the last of the stock at the same moment cannot both succeed.
 *
 * ── Trips and Delivery Costing ────────────────────────────────────────────
 *
 * AGO given for a trip (a truck's load on a PFI, a delivery_inventory row)
 * carries the trip's id, and so do its top-ups and retrievals. The trip's AGO
 * is given + top-ups − retrieved, and Delivery Costing reads that in place of
 * the figure typed there (lib/tripAgo.js).
 */

const IN_KINDS = ["opening", "received", "retrieved", "adjust_in"];
const STOCK_KINDS = ["opening", "received", "adjust_in", "adjust_out"];
const CHANGE_KINDS = ["top_up", "retrieved"];
const KINDS = ["opening", "received", "given", "top_up", "retrieved", "adjust_in", "adjust_out"];

const LABEL = {
  opening: "Opening balance",
  received: "Stock received",
  given: "AGO given",
  top_up: "Top-up",
  retrieved: "Retrieved",
  adjust_in: "Count adjustment (+)",
  adjust_out: "Count adjustment (−)",
};

/** The station loads off a deskless parent carry this plate and no truck. */
const STATION_LOAD_PLATE = "DANGOTE DELIVERY";
/** A trip's plate as typed on it, else its fleet truck's (joined as `ft`). */
const PLATE = client`COALESCE(NULLIF(trim(di.truck_number), ''), ft.plate_number, '')`;

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const litresOf = (v) => Math.round((Number(v) || 0) * 100) / 100;
const signOf = (kind) => (IN_KINDS.includes(kind) ? 1 : -1);
const L = (n) => `${litresOf(n).toLocaleString("en-NG")} L`;
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-14" → "14 Oct 2026", read off the string so no clock can shift it. */
const dayLabel = (day) => {
  const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** Opening first, then stock that came in that day, then the rest as entered. */
const rankOf = (kind) => (kind === "opening" ? 0 : kind === "received" || kind === "adjust_in" ? 1 : 2);
/** Ids for entries being checked before they are written. */
const UNSAVED = 2 ** 31;
const bookOrder = (a, b) =>
  (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || rankOf(a.kind) - rankOf(b.kind) || a.id - b.id;

/**
 * Check a whole book — the live entries as they would stand after a write.
 * Entries not yet written carry an id above any real one (UNSAVED + n), so
 * they sort after the entries already made that day, in the order sent —
 * which is where they will land once written.
 *
 * @param {Array<{id:number, kind:string, litres:number, day:string, issueId:number|null, truckNumber?:string}>} entries
 */
function assertBookHolds(entries) {
  const today = lagosToday();
  const sorted = [...entries].sort(bookOrder);

  const future = sorted.find((e) => e.day > today);
  if (future) throw httpError(409, `${dayLabel(future.day)} is after today. Entries can only be dated today or earlier.`);

  const opening = sorted.find((e) => e.kind === "opening");
  if (opening) {
    const before = sorted.find((e) => e.day < opening.day);
    if (before) {
      throw httpError(
        409,
        `The opening balance is dated ${dayLabel(opening.day)}, so nothing can be dated before it (${LABEL[before.kind]} on ${dayLabel(before.day)}).`,
      );
    }
  }

  const byId = new Map(sorted.map((e) => [e.id, e]));
  const tripNet = new Map();
  for (const e of sorted) {
    if (e.kind === "given") tripNet.set(e.id, (tripNet.get(e.id) || 0) + e.litres);
    if (!CHANGE_KINDS.includes(e.kind)) continue;
    const issue = byId.get(e.issueId);
    if (!issue) throw httpError(409, "The AGO given this changes is no longer on the ledger.");
    if (e.day < issue.day) {
      throw httpError(
        409,
        `A ${LABEL[e.kind].toLowerCase()} cannot be dated before the AGO it changes was given (${dayLabel(issue.day)}).`,
      );
    }
    tripNet.set(issue.id, (tripNet.get(issue.id) || 0) + (e.kind === "top_up" ? e.litres : -e.litres));
  }
  for (const [issueId, net] of tripNet) {
    if (litresOf(net) < 0) {
      const issue = byId.get(issueId);
      throw httpError(
        409,
        `${issue.truckNumber || "This truck"} would have more taken back than it was given (${L(net)} left on the trip). Only what is still on the truck can be retrieved.`,
      );
    }
  }

  let balance = 0;
  for (const e of sorted) {
    const before = balance;
    balance = litresOf(balance + signOf(e.kind) * e.litres);
    if (balance < 0) {
      throw httpError(
        409,
        `On ${dayLabel(e.day)} only ${L(before)} is in stock, so ${L(e.litres)} cannot go out (${LABEL[e.kind]}${e.truckNumber ? ` to ${e.truckNumber}` : ""}). Record the stock received first.`,
      );
    }
  }
  return balance;
}

/** The live book, as the checks need it. */
const liveBook = (tx) => tx`
  SELECT id, kind, litres, issue_id, trip_id, truck_number, to_char(entry_date, 'YYYY-MM-DD') AS day
    FROM ago_stock_entries
   WHERE deleted_at IS NULL`.then((rows) => rows.map((r) => ({
  id: Number(r.id),
  kind: r.kind,
  litres: litresOf(r.litres),
  day: r.day,
  issueId: r.issue_id == null ? null : Number(r.issue_id),
  tripId: r.trip_id == null ? null : Number(r.trip_id),
  truckNumber: r.truck_number,
})));

/** One writer at a time; reads are never blocked. */
const lock = (tx) => tx`SELECT pg_advisory_xact_lock(hashtext('ago_stock_entries'))`;

const audit = (tx, { entryId, action, staffId, metadata }) => tx`
  INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, actor_staff_id, metadata)
  VALUES ('ago_stock_entry', ${entryId}, ${action}, ${staffId ? "staff" : "system"}, ${staffId || null},
          ${JSON.stringify(metadata)}::jsonb)`;

const shape = (r) => ({
  id: Number(r.id),
  date: r.day,
  kind: r.kind,
  litres: litresOf(r.litres),
  /** Signed: what this entry did to the stock. */
  change: litresOf(signOf(r.kind) * Number(r.litres)),
  issueId: r.issue_id == null ? null : Number(r.issue_id),
  tripId: r.trip_id == null ? null : Number(r.trip_id),
  truckId: r.truck_id == null ? null : Number(r.truck_id),
  truckNumber: r.truck_number || "",
  /** The trip's load while there is a trip, else what was entered. */
  truckQty: num(r.trip_qty ?? r.truck_qty),
  pfiId: r.pfi_ref == null ? null : Number(r.pfi_ref),
  pfiNumber: r.pfi_number || "",
  allocationCode: r.allocation_code || "",
  tripDate: r.trip_date || null,
  description: r.description || "",
  recordedByName: r.recorded_by_name || "",
  createdAt: r.created_at,
  updatedByName: r.updated_by_name || "",
  updatedAt: r.updated_at,
});

/**
 * The ledger: every live entry in book order with its S/N and the balance
 * after it, and on each AGO given what its trip came to.
 */
async function list() {
  const rows = await client`
    SELECT e.*, to_char(e.entry_date, 'YYYY-MM-DD') AS day,
           di.quantity_allocated AS trip_qty, di.date_allocated AS trip_date, di.allocation_code,
           COALESCE(di.pfi_id, e.pfi_id) AS pfi_ref, p.pfi_number
      FROM ago_stock_entries e
      LEFT JOIN delivery_inventory di ON di.id = e.trip_id
      LEFT JOIN pfis p ON p.id = COALESCE(di.pfi_id, e.pfi_id)
     WHERE e.deleted_at IS NULL`;

  const entries = rows.map((r) => ({ ...shape(r), day: r.day })).sort(bookOrder);
  const sn = new Map();
  let balance = 0;
  const byIssue = new Map();
  for (const [i, e] of entries.entries()) {
    sn.set(e.id, i + 1);
    balance = litresOf(balance + e.change);
    e.sn = i + 1;
    e.balanceAfter = balance;
    if (e.issueId) {
      const list = byIssue.get(e.issueId) || [];
      list.push(e);
      byIssue.set(e.issueId, list);
    }
  }
  for (const e of entries) {
    delete e.day;
    if (e.issueId) e.issueSn = sn.get(e.issueId) ?? null;
    if (e.kind !== "given") continue;
    const changes = byIssue.get(e.id) || [];
    e.topUps = litresOf(changes.filter((c) => c.kind === "top_up").reduce((s, c) => s + c.litres, 0));
    e.retrieved = litresOf(changes.filter((c) => c.kind === "retrieved").reduce((s, c) => s + c.litres, 0));
    /** What the trip came to: given + top-ups − retrieved. */
    e.tripAgo = litresOf(e.litres + e.topUps - e.retrieved);
    e.changeIds = changes.map((c) => c.id);
  }
  return { entries, balance };
}

/**
 * The trucks AGO can be given to: every load on Delivery Inventory, newest
 * first, with its PFI and whether it has had its AGO. Station loads (no truck)
 * are left out.
 */
async function trips() {
  const rows = await client`
    SELECT di.id, di.truck_id, ${PLATE} AS truck_number, di.quantity_allocated, di.date_allocated, di.loading_status,
           di.pfi_id, di.allocation_code, p.pfi_number, p.status AS pfi_status,
           g.id AS given_id, to_char(g.entry_date, 'YYYY-MM-DD') AS given_on, g.litres AS given_litres
      FROM delivery_inventory di
      LEFT JOIN pfis p ON p.id = di.pfi_id
      LEFT JOIN fleet_trucks ft ON ft.id = di.truck_id
      LEFT JOIN ago_stock_entries g
        ON g.trip_id = di.id AND g.kind = 'given' AND g.deleted_at IS NULL
     WHERE upper(trim(COALESCE(di.truck_number, ''))) <> ${STATION_LOAD_PLATE}
       AND (di.truck_id IS NOT NULL OR trim(COALESCE(di.truck_number, '')) <> '')
     ORDER BY di.created_at DESC, di.id DESC`;
  return rows.map((r) => ({
    tripId: Number(r.id),
    truckId: r.truck_id == null ? null : Number(r.truck_id),
    truckNumber: r.truck_number || "",
    truckQty: num(r.quantity_allocated),
    dateAllocated: r.date_allocated || null,
    loadingStatus: r.loading_status,
    pfiId: r.pfi_id == null ? null : Number(r.pfi_id),
    pfiNumber: r.pfi_number || "",
    pfiStatus: r.pfi_status || null,
    allocationCode: r.allocation_code || "",
    givenEntryId: r.given_id == null ? null : Number(r.given_id),
    givenOn: r.given_on || null,
    givenLitres: r.given_litres == null ? null : litresOf(r.given_litres),
  }));
}

/** Opening balance, stock received, or a count adjustment either way. */
async function addStock({ kind, entryDate, litres, description = "" }, actor = {}) {
  if (!STOCK_KINDS.includes(kind)) throw httpError(400, "That is not a stock entry");
  return client.begin(async (tx) => {
    await lock(tx);
    const book = await liveBook(tx);
    if (kind === "opening" && book.some((e) => e.kind === "opening")) {
      throw httpError(409, "The ledger already has its opening balance. Correct that entry, or record the stock received.");
    }
    if (kind === "opening" && book.length) {
      const first = [...book].sort(bookOrder)[0];
      if (entryDate > first.day) {
        throw httpError(409, `The opening balance must come first. The earliest entry is dated ${dayLabel(first.day)}.`);
      }
    }
    if (kind !== "opening" && !book.some((e) => e.kind === "opening")) {
      throw httpError(409, "Enter the opening balance first: what was in stock on the day this ledger starts.");
    }
    assertBookHolds([...book, { id: UNSAVED, kind, litres: litresOf(litres), day: entryDate, issueId: null }]);

    const [row] = await tx`
      INSERT INTO ago_stock_entries (entry_date, kind, litres, description, recorded_by, recorded_by_name)
      VALUES (${entryDate}, ${kind}, ${litres}, ${description}, ${actor.staffId || null}, ${actor.staffName || ""})
      RETURNING id`;
    await audit(tx, {
      entryId: row.id, action: `ago_stock.${kind}`, staffId: actor.staffId,
      metadata: { kind, entryDate, litres: litresOf(litres), description },
    });
    return { id: Number(row.id) };
  });
}

/**
 * AGO given — to one truck or a whole batch at once. Each truck is a trip off
 * Delivery Inventory, or a fleet truck on no trip.
 *
 * @param {{entryDate:string, description?:string, trucks:Array<{tripId?:number, truckId?:number, truckQty?:number, pfiId?:number, litres:number, description?:string}>}} body
 */
async function give({ entryDate, description = "", trucks }, actor = {}) {
  const tripIds = trucks.map((t) => t.tripId).filter(Boolean).map(Number);
  const dup = tripIds.find((id, i) => tripIds.indexOf(id) !== i);
  if (dup) throw httpError(400, "The same truck is on the list twice.");

  return client.begin(async (tx) => {
    await lock(tx);
    const book = await liveBook(tx);
    if (!book.some((e) => e.kind === "opening")) {
      throw httpError(409, "Enter the opening balance first: what was in stock on the day this ledger starts.");
    }

    const tripRows = tripIds.length
      ? await tx`
          SELECT di.id, di.truck_id, ${PLATE} AS truck_number, di.quantity_allocated, di.pfi_id, p.pfi_number, di.allocation_code
            FROM delivery_inventory di LEFT JOIN pfis p ON p.id = di.pfi_id LEFT JOIN fleet_trucks ft ON ft.id = di.truck_id
           WHERE di.id = ANY(${tripIds}::int[])`
      : [];
    const tripById = new Map(tripRows.map((r) => [Number(r.id), r]));
    const truckIds = trucks.filter((t) => !t.tripId && t.truckId).map((t) => Number(t.truckId));
    const fleetRows = truckIds.length
      ? await tx`SELECT id, plate_number FROM fleet_trucks WHERE id = ANY(${truckIds}::int[])`
      : [];
    const fleetById = new Map(fleetRows.map((r) => [Number(r.id), r]));

    const rows = trucks.map((t, i) => {
      if (t.tripId) {
        const trip = tripById.get(Number(t.tripId));
        if (!trip) throw httpError(404, "One of the trucks is no longer on Delivery Inventory. Reopen the list and try again.");
        const given = book.find((e) => e.kind === "given" && e.tripId === Number(t.tripId));
        if (given) {
          throw httpError(
            409,
            `${trip.truck_number} on ${trip.pfi_number || trip.allocation_code || "this PFI"} was already given AGO on ${dayLabel(given.day)}. Record a top-up on that entry instead.`,
          );
        }
        return {
          tripId: Number(trip.id),
          truckId: trip.truck_id == null ? null : Number(trip.truck_id),
          truckNumber: trip.truck_number || "",
          truckQty: null,
          pfiId: trip.pfi_id == null ? null : Number(trip.pfi_id),
          litres: t.litres,
          description: t.description || description,
          tempId: UNSAVED + i,
        };
      }
      const truck = fleetById.get(Number(t.truckId));
      if (!truck) throw httpError(404, "That truck is not in the fleet directory.");
      return {
        tripId: null,
        truckId: Number(truck.id),
        truckNumber: truck.plate_number,
        truckQty: t.truckQty ?? null,
        pfiId: t.pfiId ?? null,
        litres: t.litres,
        description: t.description || description,
        tempId: UNSAVED + i,
      };
    });

    assertBookHolds([
      ...book,
      ...rows.map((r) => ({ id: r.tempId, kind: "given", litres: litresOf(r.litres), day: entryDate, issueId: null, truckNumber: r.truckNumber })),
    ]);

    const ids = [];
    for (const r of rows) {
      const [row] = await tx`
        INSERT INTO ago_stock_entries
          (entry_date, kind, litres, trip_id, truck_id, truck_number, truck_qty, pfi_id, description, recorded_by, recorded_by_name)
        VALUES (${entryDate}, 'given', ${r.litres}, ${r.tripId}, ${r.truckId}, ${r.truckNumber}, ${r.truckQty}, ${r.pfiId},
                ${r.description}, ${actor.staffId || null}, ${actor.staffName || ""})
        RETURNING id`;
      ids.push(Number(row.id));
      await audit(tx, {
        entryId: row.id, action: "ago_stock.given", staffId: actor.staffId,
        metadata: { entryDate, litres: litresOf(r.litres), tripId: r.tripId, truckNumber: r.truckNumber, pfiId: r.pfiId, description: r.description },
      });
    }
    const total = litresOf(rows.reduce((s, r) => s + litresOf(r.litres), 0));
    return { ids, trucks: rows.length, litres: total };
  });
}

/** A top-up or a retrieval on AGO already given. */
async function change(issueId, { kind, entryDate, litres, description = "" }, actor = {}) {
  if (!CHANGE_KINDS.includes(kind)) throw httpError(400, "That is not a top-up or a retrieval");
  return client.begin(async (tx) => {
    await lock(tx);
    const [issue] = await tx`
      SELECT * FROM ago_stock_entries WHERE id = ${issueId} AND deleted_at IS NULL AND kind = 'given'`;
    if (!issue) throw httpError(404, "That AGO given is not on the ledger.");
    const book = await liveBook(tx);
    assertBookHolds([
      ...book,
      { id: UNSAVED, kind, litres: litresOf(litres), day: entryDate, issueId: Number(issue.id), truckNumber: issue.truck_number },
    ]);
    const [row] = await tx`
      INSERT INTO ago_stock_entries
        (entry_date, kind, litres, issue_id, trip_id, truck_id, truck_number, truck_qty, pfi_id, description, recorded_by, recorded_by_name)
      VALUES (${entryDate}, ${kind}, ${litres}, ${issue.id}, ${issue.trip_id}, ${issue.truck_id}, ${issue.truck_number},
              ${issue.truck_qty}, ${issue.pfi_id}, ${description}, ${actor.staffId || null}, ${actor.staffName || ""})
      RETURNING id`;
    await audit(tx, {
      entryId: row.id, action: `ago_stock.${kind}`, staffId: actor.staffId,
      metadata: { issueId: Number(issue.id), entryDate, litres: litresOf(litres), truckNumber: issue.truck_number, description },
    });
    return { id: Number(row.id), truckNumber: issue.truck_number };
  });
}

/**
 * Correct an entry: its day, litres or description — and on AGO given, the
 * trip it was for (linking a truck entered before its load was on Delivery
 * Inventory, or the wrong load picked). Its top-ups and retrievals follow it.
 */
async function update(id, body, actor = {}) {
  return client.begin(async (tx) => {
    await lock(tx);
    const [entry] = await tx`
      SELECT *, to_char(entry_date, 'YYYY-MM-DD') AS day FROM ago_stock_entries WHERE id = ${id} AND deleted_at IS NULL`;
    if (!entry) throw httpError(404, "That entry is not on the ledger.");

    const next = {
      entryDate: body.entryDate ?? entry.day,
      litres: body.litres ?? entry.litres,
      description: body.description ?? entry.description,
    };

    let trip = null;
    const tripChanging = body.tripId !== undefined && Number(body.tripId || 0) !== Number(entry.trip_id || 0);
    if (tripChanging) {
      if (entry.kind !== "given") throw httpError(400, "Only AGO given can be moved to another trip. A top-up or retrieval follows its AGO given.");
      if (!body.tripId) throw httpError(400, "Pick the trip this AGO was given for.");
      [trip] = await tx`
        SELECT di.id, di.truck_id, ${PLATE} AS truck_number, di.pfi_id, p.pfi_number, di.allocation_code
          FROM delivery_inventory di LEFT JOIN pfis p ON p.id = di.pfi_id LEFT JOIN fleet_trucks ft ON ft.id = di.truck_id
         WHERE di.id = ${body.tripId}`;
      if (!trip) throw httpError(404, "That trip is no longer on Delivery Inventory.");
      const [taken] = await tx`
        SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS day FROM ago_stock_entries
         WHERE trip_id = ${trip.id} AND kind = 'given' AND deleted_at IS NULL AND id <> ${entry.id}`;
      if (taken) {
        throw httpError(
          409,
          `${trip.truck_number} on ${trip.pfi_number || trip.allocation_code || "that PFI"} was already given AGO on ${dayLabel(taken.day)}.`,
        );
      }
    }

    const book = await liveBook(tx);
    assertBookHolds(book.map((e) => (e.id === Number(entry.id)
      ? { ...e, day: next.entryDate, litres: litresOf(next.litres), truckNumber: trip ? trip.truck_number : e.truckNumber }
      : e)));

    const truckQty = body.truckQty !== undefined && !entry.trip_id && !trip ? body.truckQty : entry.truck_qty;
    await tx`
      UPDATE ago_stock_entries
         SET entry_date = ${next.entryDate}, litres = ${next.litres}, description = ${next.description},
             truck_qty = ${truckQty},
             updated_at = now(), updated_by_name = ${actor.staffName || ""}
       WHERE id = ${entry.id}`;
    if (trip) {
      // The AGO given and everything that changes it move to the trip together.
      await tx`
        UPDATE ago_stock_entries
           SET trip_id = ${trip.id}, truck_id = ${trip.truck_id}, truck_number = ${trip.truck_number},
               pfi_id = ${trip.pfi_id}, truck_qty = NULL, updated_at = now(), updated_by_name = ${actor.staffName || ""}
         WHERE deleted_at IS NULL AND (id = ${entry.id} OR issue_id = ${entry.id})`;
    }

    const was = { entryDate: entry.day, litres: litresOf(entry.litres), description: entry.description, tripId: entry.trip_id == null ? null : Number(entry.trip_id) };
    const now = { ...next, litres: litresOf(next.litres), tripId: trip ? Number(trip.id) : was.tripId };
    await audit(tx, { entryId: entry.id, action: "ago_stock.corrected", staffId: actor.staffId, metadata: { kind: entry.kind, was, now } });
    return { id: Number(entry.id) };
  });
}

/** Take an entry off the ledger. It is kept, marked, for the record. */
async function remove(id, actor = {}) {
  return client.begin(async (tx) => {
    await lock(tx);
    const [entry] = await tx`
      SELECT *, to_char(entry_date, 'YYYY-MM-DD') AS day FROM ago_stock_entries WHERE id = ${id} AND deleted_at IS NULL`;
    if (!entry) throw httpError(404, "That entry is not on the ledger.");
    const book = await liveBook(tx);
    if (entry.kind === "given") {
      const changes = book.filter((e) => e.issueId === Number(entry.id));
      if (changes.length) {
        throw httpError(
          409,
          `This AGO given has ${changes.length} top-up${changes.length === 1 ? "" : "s"} or retrieval${changes.length === 1 ? "" : "s"} on it. Delete those first.`,
        );
      }
    }
    if (entry.kind === "opening" && book.length > 1) {
      throw httpError(409, "The opening balance holds the ledger up. Correct its litres instead, or delete every other entry first.");
    }
    assertBookHolds(book.filter((e) => e.id !== Number(entry.id)));

    await tx`
      UPDATE ago_stock_entries
         SET deleted_at = now(), deleted_by = ${actor.staffId || null}, deleted_by_name = ${actor.staffName || ""}
       WHERE id = ${entry.id}`;
    await audit(tx, {
      entryId: entry.id, action: "ago_stock.deleted", staffId: actor.staffId,
      metadata: { kind: entry.kind, entryDate: entry.day, litres: litresOf(entry.litres), truckNumber: entry.truck_number, description: entry.description },
    });
    return { id: Number(entry.id), kind: entry.kind };
  });
}

module.exports = {
  list, trips, tripAgoFor, addStock, give, change, update, remove,
  assertBookHolds, bookOrder, LABEL, KINDS, STOCK_KINDS, CHANGE_KINDS,
};
