const { client } = require("../../db");
const { SUGGESTED_LIFE, wearTo, valueOn, wearSchedule } = require("../../lib/accounting/depreciation");
const { lagosToday } = require("../../lib/zonedDay");
const { settings } = require("./posting.service");

/**
 * The Fixed Assets register (0088): what the company owns and keeps — trucks,
 * generators, tanks, buildings, land, equipment — what each cost, how it was
 * paid for, and what it stands at after wear and tear. The books read it
 * (lib/accounting/postingSources/assets.js); this is the page's side.
 *
 * Every Fleet Truck is listed, the ones nobody has costed yet as rows to fill
 * — the owner's choice of 15 Oct 2026 — so a truck added to the fleet turns up
 * here by itself.
 */

const KINDS = ["truck", "vehicle", "generator", "tank", "building", "land", "equipment", "computer", "furniture", "other"];
const UNITS = ["depot", "trucking", "stations", "lpg_plants", "fleet", "head_office"];

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const dayText = (d) => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** What an expense put in the books — the same figure assets.js and expenses.js book. */
const EXPENSE_BOOKED = (e) => client.unsafe(`(
  SELECT x.owed + ROUND(COALESCE(${e}.wht_deduction, 0) * x.rate, 2)
         + CASE WHEN ${e}.vat_withheld THEN ROUND(COALESCE(${e}.vat_amount, 0) * x.rate, 2) ELSE 0 END
    FROM (SELECT CASE WHEN COALESCE(${e}.currency, 'NGN') = 'NGN' THEN 1 ELSE ${e}.exchange_rate END AS rate,
                 COALESCE(${e}.amount_ngn, CASE WHEN COALESCE(${e}.currency, 'NGN') = 'NGN' THEN ${e}.amount END) AS owed) x
)`);

/** Every asset, and every truck still to cost. */
async function list({ today = lagosToday() } = {}) {
  const rows = await client`
    SELECT a.*, to_char(a.bought_on, 'YYYY-MM-DD') AS bought_day, to_char(a.disposed_on, 'YYYY-MM-DD') AS disposed_day,
           t.plate_number, t.truck_make, t.model,
           b.bank_name, b.account_name, b.account_number,
           db.bank_name AS disposed_bank_name, db.account_name AS disposed_account_name,
           n.lender, n.kind AS loan_kind,
           e.reference_number AS expense_ref, e.status::text AS expense_status, e.deleted_at AS expense_deleted,
           CASE WHEN a.paid_how = 'expense' AND e.deleted_at IS NULL AND e.status IN ('admin_approved', 'paid')
                THEN ${EXPENSE_BOOKED("e")} END AS expense_cost
      FROM fixed_assets a
      LEFT JOIN fleet_trucks t ON t.id = a.fleet_truck_id
      LEFT JOIN bank_accounts b ON b.id = a.bank_account_id
      LEFT JOIN bank_accounts db ON db.id = a.disposed_bank_account_id
      LEFT JOIN loans n ON n.id = a.loan_id
      LEFT JOIN pfi_expenses e ON e.id = a.expense_id
     WHERE a.deleted_at IS NULL
     ORDER BY a.bought_on DESC, a.id DESC`;
  const toFill = await client`
    SELECT t.id, t.plate_number, t.truck_make, t.model, t.year
      FROM fleet_trucks t
     WHERE t.is_active
       AND NOT EXISTS (SELECT 1 FROM fixed_assets a WHERE a.fleet_truck_id = t.id AND a.deleted_at IS NULL)
     ORDER BY t.plate_number`;

  const assets = rows.map((r) => {
    // An asset entered as an expense costs what the expense booked, live; an
    // expense deleted or not approved leaves it out of the books.
    const cost = r.paid_how === "expense" ? (r.expense_cost == null ? null : money(r.expense_cost)) : money(r.cost);
    const shape = {
      boughtOn: r.bought_day,
      cost: cost ?? 0,
      residual: Math.min(money(r.residual), cost ?? 0),
      lifeMonths: r.life_months == null ? null : Number(r.life_months),
      disposedOn: r.disposed_day,
    };
    const worn = cost == null ? 0 : wearTo(shape, r.disposed_day || today);
    const monthly = wearSchedule({ ...shape, disposedOn: null }, "9999-12-31")[0]?.amount ?? 0;
    return {
      id: Number(r.id),
      name: r.name,
      kind: r.kind,
      fleetTruckId: r.fleet_truck_id == null ? null : Number(r.fleet_truck_id),
      plate: r.plate_number || null,
      boughtOn: r.bought_day,
      cost,
      residual: money(r.residual),
      lifeMonths: shape.lifeMonths,
      monthlyWear: monthly,
      worn,
      valueNow: r.disposed_day ? 0 : cost == null ? null : money(cost - worn),
      paidHow: r.paid_how,
      bankAccountId: r.bank_account_id == null ? null : Number(r.bank_account_id),
      bankName: r.bank_name ? `${r.bank_name} · ${r.account_name}${r.account_number ? ` ••${String(r.account_number).slice(-4)}` : ""}` : null,
      expenseId: r.expense_id == null ? null : Number(r.expense_id),
      expenseRef: r.expense_ref || null,
      /** Entered as an expense that no longer stands or is not approved: not in the books. */
      expenseMissing: r.paid_how === "expense" && cost == null,
      loanId: r.loan_id == null ? null : Number(r.loan_id),
      lender: r.lender || null,
      financed: r.financed == null ? null : money(r.financed),
      unit: r.unit || (r.kind === "truck" || r.kind === "vehicle" ? "fleet" : "head_office"),
      location: r.location_type ? `${r.location_type}:${r.location_id}` : null,
      notes: r.notes || "",
      disposedOn: r.disposed_day,
      disposedFor: r.disposed_for == null ? null : money(r.disposed_for),
      disposedBankAccountId: r.disposed_bank_account_id == null ? null : Number(r.disposed_bank_account_id),
      disposedBankName: r.disposed_bank_name ? `${r.disposed_bank_name} · ${r.disposed_account_name}` : null,
      status: r.disposed_day ? (Number(r.disposed_for) > 0 ? "sold" : "written_off") : "in_use",
    };
  });
  const inUse = assets.filter((a) => a.status === "in_use" && a.cost != null);
  return {
    today,
    assets,
    trucksToFill: toFill.map((t) => ({
      fleetTruckId: Number(t.id),
      plate: t.plate_number,
      name: [t.plate_number, [t.truck_make, t.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      year: t.year == null ? null : Number(t.year),
    })),
    totals: {
      cost: money(inUse.reduce((t, a) => t + a.cost, 0)),
      worn: money(inUse.reduce((t, a) => t + a.worn, 0)),
      value: money(inUse.reduce((t, a) => t + (a.valueNow || 0), 0)),
      monthlyWear: money(inUse.reduce((t, a) => t + (a.worn < a.cost - a.residual ? a.monthlyWear : 0), 0)),
    },
    suggestedLife: SUGGESTED_LIFE,
  };
}

/** A bought-on day as written, or the expense's day when it came from one. */
async function expenseFor(expenseId, assetId = null) {
  const [e] = await client`
    SELECT e.id, e.reference_number, e.status::text AS status, e.deleted_at, c.is_refund, c.system_key,
           to_char(COALESCE(e.payment_date, e.expense_date, e.admin_approved_at, e.created_at) AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
           ${EXPENSE_BOOKED("e")} AS booked,
           (SELECT fa.id FROM fixed_assets fa WHERE fa.expense_id = e.id AND fa.deleted_at IS NULL
               AND fa.id IS DISTINCT FROM ${assetId} LIMIT 1) AS taken_by
      FROM pfi_expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.id = ${expenseId}`;
  if (!e || e.deleted_at) throw httpError(400, "That expense is not on the Expenses page");
  if (!["admin_approved", "paid"].includes(e.status)) throw httpError(400, "That expense is not approved yet — an asset can come from an approved or paid expense");
  if (e.is_refund || e.system_key === "customer_commission") throw httpError(400, "A refund or commission money is not something the company owns");
  if (e.taken_by) throw httpError(409, "That expense is already on the register as another asset");
  if (!(Number(e.booked) > 0)) throw httpError(400, "That expense has no naira amount yet");
  return { day: e.day, cost: money(e.booked) };
}

/** The fields as stored, checked. `prev` is the asset being changed. */
async function shapeOf(body, prev = null) {
  const v = { ...(prev || {}), ...body };
  const name = String(v.name || "").trim();
  if (!name) throw httpError(400, "Give the asset a name");
  if (!KINDS.includes(v.kind)) throw httpError(400, "Pick what kind of asset it is");
  if (v.unit && !UNITS.includes(v.unit)) throw httpError(400, "That part of the business is not one the books know");
  const paidHow = v.paidHow;
  if (!["bank", "expense", "loan", "owned"].includes(paidHow)) throw httpError(400, "Say how it was paid for");

  let boughtOn = v.boughtOn ? dayText(v.boughtOn) : null;
  let cost = Number(v.cost);
  let expenseId = null;
  if (paidHow === "expense") {
    if (!v.expenseId) throw httpError(400, "Pick the expense it was entered as");
    expenseId = Number(v.expenseId);
    const e = await expenseFor(expenseId, prev?.id ?? null);
    cost = e.cost;
    boughtOn = boughtOn || e.day;
  }
  if (!boughtOn || !/^\d{4}-\d{2}-\d{2}$/.test(boughtOn)) throw httpError(400, "Say the day it was bought");
  if (!(cost > 0)) throw httpError(400, "Say what it cost");
  const residual = Number(v.residual || 0);
  if (residual < 0 || residual > cost) throw httpError(400, "What it should fetch at the end cannot be more than it cost");
  const life = v.kind === "land" || v.lifeMonths == null || v.lifeMonths === "" ? null : Number(v.lifeMonths);
  if (life != null && !(Number.isInteger(life) && life > 0 && life <= 1200)) throw httpError(400, "Say how many months it is used for");

  let bankAccountId = v.bankAccountId ? Number(v.bankAccountId) : null;
  let loanId = null;
  let financed = null;
  if (paidHow === "bank" && !bankAccountId) throw httpError(400, "Say which bank account it was paid from");
  if (paidHow === "loan") {
    if (!v.loanId) throw httpError(400, "Pick the hire purchase or loan it is on");
    loanId = Number(v.loanId);
    const [n] = await client`SELECT id FROM loans WHERE id = ${loanId} AND deleted_at IS NULL`;
    if (!n) throw httpError(400, "That loan is not on the Loans page");
    financed = v.financed == null || v.financed === "" ? cost : Number(v.financed);
    if (!(financed > 0 && financed <= cost)) throw httpError(400, "What the loan paid must be more than nought and no more than the cost");
    if (financed < cost && !bankAccountId) throw httpError(400, "Say which bank account the deposit was paid from");
    if (financed === cost) bankAccountId = null;
  }
  if (paidHow === "owned") {
    const { booksStart } = await settings();
    if (boughtOn >= booksStart) throw httpError(400, `"Owned before the books" is for things bought before ${booksStart} — this one was paid from a bank, an expense or a loan`);
    bankAccountId = null;
  }
  if (paidHow === "expense") bankAccountId = null;

  const fleetTruckId = v.fleetTruckId ? Number(v.fleetTruckId) : null;
  if (fleetTruckId) {
    const [taken] = await client`
      SELECT id FROM fixed_assets WHERE fleet_truck_id = ${fleetTruckId} AND deleted_at IS NULL AND id IS DISTINCT FROM ${prev?.id ?? null}`;
    if (taken) throw httpError(409, "That truck is on the register already");
  }
  const location = v.location ? String(v.location) : null;
  if (location && !/^(depot|station|plant):\d+$/.test(location)) throw httpError(400, "That place is not one the books know");

  return {
    name,
    kind: v.kind,
    fleet_truck_id: fleetTruckId,
    bought_on: boughtOn,
    cost: money(cost),
    residual: money(residual),
    life_months: life,
    paid_how: paidHow,
    bank_account_id: bankAccountId,
    expense_id: expenseId,
    loan_id: loanId,
    financed: financed == null ? null : money(financed),
    unit: v.unit || null,
    location_type: location ? location.split(":")[0] : null,
    location_id: location ? Number(location.split(":")[1]) : null,
    notes: String(v.notes || "").trim().slice(0, 2000),
  };
}

/** The asset as the form last saved it, in the form's own names. */
async function current(id) {
  const [r] = await client`
    SELECT a.*, to_char(a.bought_on, 'YYYY-MM-DD') AS bought_day FROM fixed_assets a WHERE a.id = ${id} AND a.deleted_at IS NULL`;
  if (!r) throw httpError(404, "That asset is not on the register");
  return {
    id: Number(r.id), name: r.name, kind: r.kind, fleetTruckId: r.fleet_truck_id, boughtOn: r.bought_day, cost: Number(r.cost),
    residual: Number(r.residual), lifeMonths: r.life_months, paidHow: r.paid_how, bankAccountId: r.bank_account_id,
    expenseId: r.expense_id, loanId: r.loan_id, financed: r.financed == null ? null : Number(r.financed), unit: r.unit,
    location: r.location_type ? `${r.location_type}:${r.location_id}` : null, notes: r.notes,
    disposedOn: r.disposed_on,
  };
}

/**
 * Its matches on the statement are let go, so the next posting run matches
 * the asset as it stands now — a new bank, a new amount, a new day.
 */
const forgetMatches = (tx, id) =>
  tx`DELETE FROM bank_line_classifications WHERE kind IN ('asset', 'asset_sale') AND ref_id = ${id} AND auto`;

async function create(body, staffId = null) {
  const row = await shapeOf(body);
  const [r] = await client`
    INSERT INTO fixed_assets ${client({ ...row, created_by: staffId, updated_by: staffId })} RETURNING id`;
  return { id: Number(r.id) };
}

async function update(id, body, staffId = null) {
  const prev = await current(id);
  const row = await shapeOf(body, prev);
  await client.begin(async (tx) => {
    await tx`UPDATE fixed_assets SET ${tx({ ...row, updated_by: staffId, updated_at: new Date() })} WHERE id = ${id}`;
    await forgetMatches(tx, id);
  });
  return { id };
}

async function remove(id, staffId = null) {
  await current(id);
  await client.begin(async (tx) => {
    await tx`UPDATE fixed_assets SET deleted_at = now(), updated_by = ${staffId}, updated_at = now() WHERE id = ${id}`;
    await forgetMatches(tx, id);
  });
  return { id };
}

/** Sold, scrapped or lost: the day, what it fetched, the bank it went into. */
async function dispose(id, { disposedOn, disposedFor = 0, bankAccountId = null }, staffId = null) {
  const prev = await current(id);
  const day = dayText(disposedOn);
  if (!day) throw httpError(400, "Say the day it was sold or written off");
  if (day < prev.boughtOn) throw httpError(400, "It cannot go before the day it was bought");
  const fetched = Number(disposedFor) || 0;
  if (fetched < 0) throw httpError(400, "What it fetched cannot be below nought");
  if (fetched > 0 && !bankAccountId) throw httpError(400, "Say which bank account the money went into");
  await client.begin(async (tx) => {
    await tx`
      UPDATE fixed_assets
         SET disposed_on = ${day}, disposed_for = ${money(fetched)},
             disposed_bank_account_id = ${fetched > 0 ? Number(bankAccountId) : null},
             updated_by = ${staffId}, updated_at = now()
       WHERE id = ${id}`;
    await forgetMatches(tx, id);
  });
  return { id };
}

/** Back in use: a sale entered by mistake. */
async function undispose(id, staffId = null) {
  await current(id);
  await client.begin(async (tx) => {
    await tx`
      UPDATE fixed_assets SET disposed_on = NULL, disposed_for = NULL, disposed_bank_account_id = NULL,
             updated_by = ${staffId}, updated_at = now()
       WHERE id = ${id}`;
    await forgetMatches(tx, id);
  });
  return { id };
}

/** Assets in use at the end of a day, by what they stand at — for the report. */
async function standingAt(day) {
  const { assets } = await list({ today: day });
  return assets
    .filter((a) => a.cost != null && a.boughtOn <= day && (!a.disposedOn || a.disposedOn > day))
    .map((a) => {
      const shape = { boughtOn: a.boughtOn, cost: a.cost, residual: a.residual, lifeMonths: a.lifeMonths, disposedOn: a.disposedOn };
      return { id: a.id, name: a.name, kind: a.kind, cost: a.cost, worn: wearTo(shape, day), value: valueOn(shape, day) };
    });
}

module.exports = { list, create, update, remove, dispose, undispose, standingAt, KINDS };
