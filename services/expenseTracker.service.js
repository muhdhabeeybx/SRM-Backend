const { client } = require("../config/db");
const pfiExpenseRepo = require("../repositories/pfiExpense.repository");
const chain = require("../lib/expenseChain");

/**
 * The LPG plants' expenses tracker, brought onto the books.
 *
 * The plants' running costs — diesel for the generators, repairs, permits,
 * the supervisor's transport — were paid by transfer out of the plants'
 * accounts (or by a person and refunded) and written up in a spreadsheet,
 * one row per payment: date, amount, receipt, beneficiary and bank, reason,
 * the place the money was spent for, and the account it came out of. This
 * puts each row into Expenses as money that has ALREADY been paid, the way a
 * super admin records any historical cost (expense.controller createExpense,
 * record_as_paid): status paid, the settlement it arrived with, and an audit
 * entry saying the approval chain was not walked and why.
 *
 * Where each row goes, decided here so the preview and the record agree:
 *
 *   a plant      the town in "Location of Expenses" — or the plant the
 *                reason names ("…to Kano LPG plant") — is an LPG plant: the
 *                expense is that plant's (lpg_station_id). It shows on the
 *                plant's page and comes off its profit, not its balance.
 *   general      Abuja and the like: LPG business, no one plant's.
 *   truck        Lagos, the refinery, Jos — the tracker's own note says
 *                truck expenses are not plant expenses. Booked to the fleet
 *                accounts, no plant.
 *   refund       "Refund for expenses serial number 16 to 24": the money
 *                that repaid a person for rows already on the sheet. Those
 *                rows are the costs; this one is not booked again.
 *
 * No PFI is set. Running costs are booked to general accounts, and the chart
 * allows a PFI only on cargo accounts (resolveBooking) — a plant's diesel on
 * PFI 33 would read as PFI 33's cargo cost. On the plant page they sit on its
 * "No PFI" row.
 *
 * All or nothing: any row that cannot be placed stops the upload, and the
 * same file uploaded again records nothing twice.
 */

const httpErr = (status, message) => Object.assign(new Error(message), { status, statusCode: status });
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const money = (n) => Math.round(Number(n) * 100) / 100;

/** Places that are not a plant, and what a cost there is. */
const GENERAL_PLACES = ["abuja"];
const TRUCK_PLACES = ["lagos", "lagos refinery", "refinery lagos", "refinery", "jos"];

/**
 * The account a reason is booked to, by GL code. First match wins, so the
 * specific comes before the general: "thermal paper and transport" is
 * stationery, "diesel … and transport" is fuel.
 */
const PLANT_ACCOUNTS = [
  [/thermal|thread|eagle|stationer|calculator|kadio|printing/, "6110"],
  [/diesel|desiel|disel|\bpms\b|petrol/, "6080"],
  // Moving a thing is transport, whatever the thing is ("Transportation of Compressor…").
  [/^transport|^transportation/, "6050"],
  [/hotel|feeding|welfare|accommodation|suites/, "6020"],
  [/\bdpr\b|certificate|licen[cs]e|permit|inspection|pressure test|weight and measure|weights and measures/, "6130"],
  [/water ?board|water bill|waer bill/, "6140"],
  // "Additional 5 liters for Jalingo": litres bought for a plant are its generator's fuel.
  [/\bliters?\b|\blitres?\b|\bltrs?\b|\blts\b/, "6080"],
  [/\blte\b|internet|data subscription/, "6120"],
  [/design|consult/, "6180"],
  [/housekeeping|cleaning|grass/, "6290"],
  [/weigh ?bridge|weight ?bridge/, "6310"],
  [/repair|servic|recoil|replace|battery|kickstarter|compressor|generator|electric|capacitor|sumo|accessor|extinguisher|vane pump/, "6090"],
  [/padlock|led ?light|adapter|\bgum\b/, "6290"],
  [/transport|\btp\b|waybill|travel/, "6050"],
];
const TRUCK_ACCOUNTS = [
  [/calibration/, "6400"],
  [/diesel|desiel|fuel/, "6440"],
  [/rescue|towing|recovery/, "6430"],
];
const FALLBACK_PLANT_ACCOUNT = "6310"; // Other General Expenses
const FALLBACK_TRUCK_ACCOUNT = "6480"; // Other Fleet Expenses

const accountFor = (reason, kind) => {
  const r = norm(reason);
  const table = kind === "truck" ? TRUCK_ACCOUNTS : PLANT_ACCOUNTS;
  const hit = table.find(([re]) => re.test(r));
  return hit ? hit[1] : kind === "truck" ? FALLBACK_TRUCK_ACCOUNT : FALLBACK_PLANT_ACCOUNT;
};

/** "Soroman Kano LPG Plant" → "kano". */
const townOf = (plantName) => norm(plantName).replace(/\bsoroman\b|\blpg\b|\bplant\b/g, " ").replace(/\s+/g, " ").trim();

/**
 * Where a row goes. The reason wins only when it names a plant outright
 * ("…to Kano LPG plant") — the tracker's location for that row was the town
 * the compressor came from, not the plant it was for.
 */
function placeOf(row, plants) {
  const loc = norm(row.location);
  const reason = norm(row.reason);
  if (/refer to s ?n|refund for expenses? serial/.test(`${loc} ${reason}`)) return { kind: "refund" };
  const named = plants.filter((p) => new RegExp(`\\b${p.town} lpg plant\\b`).test(reason));
  if (named.length === 1) return { kind: "plant", plant: named[0] };
  const inLocation = plants.filter((p) => new RegExp(`\\b${p.town}\\b`).test(loc));
  if (inLocation.length === 1) return { kind: "plant", plant: inLocation[0] };
  if (TRUCK_PLACES.includes(loc) || /\btru?c?u?cks?\b|trcuks?|\bkuj\b/.test(reason)) return { kind: "truck" };
  if (GENERAL_PLACES.includes(loc)) return { kind: "general" };
  return null;
}

/** One payment as a key: who it was for, the day, the money, the payee and what for. */
const keyOf = ({ subject, date, amount, vendor, reason }) =>
  [subject ?? "general", date, money(amount).toFixed(2), norm(vendor), norm(reason)].join("|");

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));

/**
 * Check every row and, unless asked only to check, record the new ones.
 *
 * rows: [{ line, tab, sn, date, amount, receipt, vendor, vendorBank, reason,
 *          location, source, sourceBank }] — as the sheet says them; the
 *          dashboard reads the workbook (lib/expense-tracker-import).
 */
async function importTracker({ rows, dryRun = false, user, enteredBy = null }) {
  if (!chain.canRecordAsPaid(user)) {
    throw httpErr(403, "Only a super admin can bring paid expenses onto the books.");
  }

  const plantRows = await client`SELECT id, name FROM lpg_stations ORDER BY id`;
  const plants = plantRows.map((p) => ({ id: Number(p.id), name: p.name, town: townOf(p.name) })).filter((p) => p.town);
  const accounts = new Map((await client`
    SELECT id, gl_code, name FROM expense_categories WHERE gl_code IS NOT NULL`).map((c) => [c.gl_code, { id: Number(c.id), code: c.gl_code, name: c.name }]));
  const accountsWithPlant = await client`
    SELECT s.id, c.id AS customer_id FROM lpg_stations s
      LEFT JOIN delivery_customers c ON c.lpg_station_id = s.id AND c.customer_type = 'lpg_plant'`;
  const hasPage = new Set(accountsWithPlant.filter((r) => r.customer_id != null).map((r) => Number(r.id)));

  let enteredByName = [user?.name, user?.email].find(Boolean) || "";
  if (enteredBy != null) {
    const [s] = await client`SELECT first_name, surname FROM staff WHERE id = ${Number(enteredBy)}`;
    if (!s) throw httpErr(400, "The person named as entering these is not on the staff list.");
    enteredByName = [s.first_name, s.surname].filter(Boolean).join(" ");
  }

  // What is already on the books, as keys counted: the same payment twice in
  // a sheet is two payments, so a re-upload takes off only as many as exist.
  const dates = [...new Set(rows.map((r) => r.date).filter(isDay))];
  const existing = dates.length
    ? await client`
        SELECT lpg_station_id, to_char(expense_date AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
               amount, vendor, description
          FROM pfi_expenses
         WHERE deleted_at IS NULL AND delivery_customer_id IS NULL
           AND to_char(expense_date AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') = ANY(${dates})`
    : [];
  const onBooks = new Map();
  for (const e of existing) {
    const k = keyOf({ subject: e.lpg_station_id == null ? null : Number(e.lpg_station_id), date: e.day, amount: e.amount, vendor: e.vendor, reason: e.description });
    onBooks.set(k, (onBooks.get(k) ?? 0) + 1);
  }

  // A row copied onto a second tab is the same payment, not another one.
  const seenOnTab = new Map();
  const results = rows.map((raw, i) => {
    const row = {
      line: raw.line ?? i + 1,
      tab: String(raw.tab ?? ""),
      sn: String(raw.sn ?? "").trim(),
      date: String(raw.date ?? "").slice(0, 10),
      amount: Number(raw.amount),
      receipt: String(raw.receipt ?? "").trim(),
      vendor: String(raw.vendor ?? "").trim(),
      vendorBank: String(raw.vendorBank ?? "").trim(),
      reason: String(raw.reason ?? "").trim(),
      location: String(raw.location ?? "").trim(),
      source: String(raw.source ?? "").trim(),
      sourceBank: String(raw.sourceBank ?? "").trim(),
    };
    const problems = [];
    if (!isDay(row.date)) problems.push("Date is missing or not a date");
    if (!Number.isFinite(row.amount) || row.amount <= 0) problems.push("Amount must be more than 0");
    if (!row.reason) problems.push("Reason for payment is empty");
    const place = placeOf(row, plants);
    if (!place) problems.push(`"${row.location || "(blank)"}" is not a plant, Abuja, or a truck location`);

    const out = { line: row.line, tab: row.tab, sn: row.sn, row, problems, status: "new" };
    if (place) {
      out.kind = place.kind;
      if (place.plant) {
        out.plant = { id: place.plant.id, name: place.plant.name, hasPage: hasPage.has(place.plant.id) };
      }
    }
    if (problems.length) { out.status = "error"; return out; }
    if (place.kind === "refund") { out.status = "skipped"; return out; }

    const code = accountFor(row.reason, place.kind);
    const account = accounts.get(code);
    if (!account) { problems.push(`Account ${code} is not in the chart`); out.status = "error"; return out; }
    out.account = account;

    const key = keyOf({ subject: place.plant?.id ?? null, date: row.date, amount: row.amount, vendor: row.vendor, reason: row.reason });
    out.key = key;
    const copy = seenOnTab.get(key);
    if (copy && copy.tab !== row.tab) { out.status = "repeated in file"; out.copyOf = copy.line; return out; }
    if (!copy) seenOnTab.set(key, { tab: row.tab, line: row.line });
    if ((onBooks.get(key) ?? 0) > 0) {
      onBooks.set(key, onBooks.get(key) - 1);
      out.status = "already recorded";
    }
    return out;
  });

  // The rows a refund repaid: paid by a person, refunded on the refund's S/N.
  for (const r of results.filter((x) => x.kind === "refund")) {
    const m = /(\d+)\s*(?:to|-|–)\s*(\d+)/.exec(`${r.row.location} ${r.row.reason}`);
    if (!m) continue;
    const [from, to] = [Number(m[1]), Number(m[2])];
    r.refunds = { from, to };
    for (const x of results) {
      const sn = Number(x.sn);
      if (x.tab === r.tab && Number.isFinite(sn) && sn >= from && sn <= to) x.refundedOn = r.sn || String(r.line);
    }
  }

  const fresh = results.filter((r) => r.status === "new");
  const errors = results.filter((r) => r.status === "error");
  const sum = (list) => money(list.reduce((s, r) => s + r.row.amount, 0));
  const byPlace = new Map();
  for (const r of fresh) {
    const label = r.plant ? r.plant.name : r.kind === "truck" ? "Trucks (no plant)" : "General LPG (no plant)";
    const p = byPlace.get(label) ?? { label, rows: 0, amount: 0, hasPage: r.plant ? r.plant.hasPage : true };
    p.rows += 1;
    p.amount = money(p.amount + r.row.amount);
    byPlace.set(label, p);
  }
  const summary = {
    rows: results.length,
    toRecord: fresh.length,
    amount: sum(fresh),
    alreadyRecorded: results.filter((r) => r.status === "already recorded").length,
    repeated: results.filter((r) => r.status === "repeated in file").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: errors.length,
    byPlace: [...byPlace.values()].sort((a, b) => a.label.localeCompare(b.label)),
    enteredBy: enteredByName,
  };

  if (dryRun || errors.length || !fresh.length) return { results, summary, recorded: 0 };

  const actorId = user?.id ?? null;
  const actorName = user?.name || user?.email || "";
  const now = new Date().toISOString();
  await client.begin(async (tx) => {
    for (const r of fresh) {
      const { row } = r;
      const paidFrom = [row.source, row.sourceBank].filter(Boolean).join(" · ");
      const notes = [
        `From the LPG plants expenses tracker${row.sn ? `, S/N ${row.sn}` : ""} (sheet row ${row.line}${row.tab ? `, ${row.tab}` : ""}).`,
        r.refundedOn ? `Paid by ${row.source || "a person"} and refunded to them on S/N ${r.refundedOn}.` : "",
        r.kind === "truck" ? "A truck expense — on no plant." : "",
        r.kind === "general" ? `Spent at ${row.location} — on no one plant.` : "",
      ].filter(Boolean).join(" ");
      const paymentDate = new Date(`${row.date}T12:00:00+01:00`).toISOString();
      const expense = await pfiExpenseRepo.createExpense({
        pfi_id: null,
        delivery_customer_id: null,
        lpg_station_id: r.plant?.id ?? null,
        category_id: r.account.id,
        expense_date: paymentDate,
        vendor: row.vendor,
        vendor_id: null,
        description: row.reason,
        amount: row.amount.toFixed(2),
        currency: "NGN",
        exchange_rate: "1",
        receipt_reference: row.receipt,
        payee_bank_name: row.vendorBank,
        status: chain.STATUS.PAID,
        bank_paid_from: paidFrom,
        amount_paid: row.amount.toFixed(2),
        payment_reference: "",
        payment_date: paymentDate,
        payment_method: /^cash$/i.test(row.vendorBank) ? "cash" : "transfer",
        payment_notes: notes,
        paid_by: actorId,
        paid_at: paymentDate,
        reviewed_by: actorId,
        reviewed_at: now,
        entered_by: enteredByName,
        recorded_by: actorId,
        added_by: actorId,
      }, tx);
      await pfiExpenseRepo.writeAudit({
        expenseId: expense.id,
        action: "recorded_as_paid",
        changes: { ...expense, note: "Uploaded from the LPG plants expenses tracker as already paid by a super admin — approval chain bypassed" },
        actorId,
        actorName,
      }, tx);
    }
    await tx`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, actor_staff_id, metadata)
      VALUES ('expense', 0, 'expenses.tracker_uploaded', ${actorId ? "staff" : "system"}, ${actorId},
              ${JSON.stringify({ count: fresh.length, amount: summary.amount, byPlace: summary.byPlace, enteredBy: enteredByName })}::jsonb)`;
  });

  return { results, summary, recorded: fresh.length };
}

module.exports = { importTracker, placeOf, accountFor, townOf };
