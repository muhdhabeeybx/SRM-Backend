// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles, grantPage } = require("./helpers");

/**
 * Trucks' loading money, entered in Delivery Costing and raised as a Truck
 * Loading request (0099) — and what was paid already, written in as paid
 * (the user, 2026-10-27): loading, and an owner's advance.
 *
 *   loading   one request per batch for what its trucks carry, hired trucks
 *             too; counted on the truck until paid, then by the PFI.
 *   paid      a super admin records loading or an advance as already paid,
 *             with the account, date and reference; the chain is skipped.
 */
const RUN = Date.now();
const TAG = String(RUN % 1000000);
let token;
let loadingCat;
const made = { categories: [], pfis: [], trucks: [], trips: [] };
let pfi;   // loading raised for approval
let paidPfi; // loading paid already
let hiredPfi; // an owner's advance paid already
const t = {};

const as = (tok = token) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${tok}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${tok}`).send(body),
  del: (url) => request(app).delete(url).set("Authorization", `Bearer ${tok}`),
});
const cost = (ids, body) => as().post("/api/delivery-inventory/costs", { ids, ...body });
const row = async (id) => {
  const res = await as().get("/api/delivery-inventory?limit=1000");
  return res.body.data.inventory.find((r) => r.id === id);
};
const live = async (pfiId) => (await client`
  SELECT id, reference_number, amount::numeric AS amount, amount_paid::numeric AS paid, status::text AS status,
         category_id, description, bank_paid_from, payment_reference, paid_at
    FROM pfi_expenses WHERE pfi_id = ${pfiId} AND deleted_at IS NULL ORDER BY id`);
const PAID = { bankPaidFrom: "Soroman Trucks — Zenith Bank (1311924986)", paymentDate: "2026-10-20", paymentReference: `TRF-${TAG}` };

describe("truck loading in Delivery Costing, and costs paid already", () => {
  before(async () => {
    token = await staffToken(request, app);
    let [c] = await client`SELECT id FROM expense_categories WHERE pfi_id IS NULL AND gl_code = '5435' LIMIT 1`;
    if (!c) {
      [c] = await client`
        INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup)
        VALUES ('Truck Loading', '5435', 'pfi_direct', 'PFI Operational Expenses') RETURNING id`;
      made.categories.push(c.id);
    }
    loadingCat = Number(c.id);
    const [h] = await client`SELECT id FROM expense_categories WHERE pfi_id IS NULL AND gl_code = '5120' LIMIT 1`;
    if (!h) {
      const [x] = await client`
        INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup)
        VALUES ('Transportation/Haulage', '5120', 'pfi_direct', 'Cargo / Vessel Costs') RETURNING id`;
      made.categories.push(x.id);
    }

    const mk = async (n) => {
      const [p] = await client`
        INSERT INTO pfis (pfi_number, status, pfi_type, starting_qty_litres, allocation_code)
        VALUES (${`PFI/LD${n}/${RUN}`}, 'active', 'trucking', 500000, ${`PFI-LD${n}${TAG}`})
        RETURNING id, pfi_number, allocation_code`;
      made.pfis.push(p.id);
      return p;
    };
    pfi = await mk("A");
    paidPfi = await mk("B");
    hiredPfi = await mk("C");

    const truck = async (plate, owner) => {
      const [f] = await client`
        INSERT INTO fleet_trucks (plate_number, is_third_party, owner_name, max_capacity)
        VALUES (${plate}, ${owner != null}, ${owner || ""}, 50000) RETURNING id`;
      made.trucks.push(f.id);
      return Number(f.id);
    };
    const trip = async (p, plate, truckId) => {
      const [r] = await client`
        INSERT INTO delivery_inventory (truck_number, truck_id, pfi_id, pfi_number, allocation_code, quantity_allocated, rate, product_price)
        VALUES (${plate}, ${truckId}, ${p.id}, ${p.pfi_number}, ${p.allocation_code}, 50000, 1400, 1300) RETURNING id`;
      made.trips.push(Number(r.id));
      return Number(r.id);
    };
    for (const k of ["a", "b"]) {
      const plate = `LDA${k.toUpperCase()}${TAG}`;
      t[k] = await trip(pfi, plate, await truck(plate, null));
    }
    t.hiredA = await trip(pfi, `LDAH${TAG}`, await truck(`LDAH${TAG}`, `OWNER A ${TAG}`));
    for (const k of ["d", "e"]) {
      const plate = `LDB${k.toUpperCase()}${TAG}`;
      t[k] = await trip(paidPfi, plate, await truck(plate, null));
    }
    for (const k of ["h1", "h2"]) {
      const plate = `LDH${k.toUpperCase()}${TAG}`;
      t[k] = await trip(hiredPfi, plate, await truck(plate, `GOLOLO ${TAG}`));
    }
  });

  after(async () => {
    try {
      const exp = await client`SELECT id FROM pfi_expenses WHERE pfi_id = ANY(${made.pfis}::int[])`;
      const ids = exp.map((e) => e.id);
      await client`DELETE FROM trip_owner_payments WHERE trip_id = ANY(${made.trips}::int[])`;
      await client`DELETE FROM delivery_inventory WHERE id = ANY(${made.trips}::int[])`;
      if (ids.length) {
        await client`DELETE FROM pfi_expense_audits WHERE expense_id = ANY(${ids}::int[])`;
        await client`DELETE FROM notifications WHERE data->>'expenseId' = ANY(${ids.map(String)}::text[])`.catch(() => {});
        await client`DELETE FROM pfi_expenses WHERE id = ANY(${ids}::int[])`;
      }
      await client`DELETE FROM fleet_trucks WHERE id = ANY(${made.trucks}::int[])`;
      await client`DELETE FROM pfis WHERE id = ANY(${made.pfis}::int[])`;
      if (made.categories.length) await client`DELETE FROM expense_categories WHERE id = ANY(${made.categories}::int[])`;
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  // ── Loading raised for approval ─────────────────────────────────────────

  test("loading on the batch's trucks, hired ones too, raises one Truck Loading request", async () => {
    const res = await cost([t.a, t.b, t.hiredA], { loadingCost: 90000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /Truck loading request .* raised .* for ₦270,000, 3 trucks/);
    const reqs = await live(pfi.id);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].category_id, loadingCat);
    assert.equal(reqs[0].status, "pending");
    assert.equal(Number(reqs[0].amount), 270000);
    assert.match(reqs[0].description, /Truck loading: 3 trucks on .*₦90,000 each/);

    const a = await row(t.a);
    assert.equal(a.loadingCost, 90000);
    assert.equal(a.loadingRequest.status, "pending");
    assert.equal(a.totalExpenses, 90000, "what the truck cost");
    assert.equal(a.stillToPay, 90000, "not paid yet");
  });

  test("a truck changed or ticked as in Expenses re-totals the request", async () => {
    await cost([t.b], { loadingCost: 100000 });
    assert.equal(Number((await live(pfi.id))[0].amount), 280000);
    const res = await cost([t.hiredA], { loadingCostInExpenses: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /Loading on 1 truck marked as already in Expenses/);
    const [req] = await live(pfi.id);
    assert.equal(Number(req.amount), 190000);
    assert.equal((await row(t.hiredA)).paidInExpenses, 90000, "in Expenses already");
  });

  test("once finance takes it forward the loading is fixed, and once paid the truck adds nothing", async () => {
    const [req] = await live(pfi.id);
    await client`UPDATE pfi_expenses SET status = 'verified' WHERE id = ${req.id}`;
    const refused = await cost([t.a], { loadingCost: 1 });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.message, /finance has already taken forward/);

    await client`UPDATE pfi_expenses SET status = 'paid', amount_paid = amount, paid_at = NOW() WHERE id = ${req.id}`;
    const a = await row(t.a);
    assert.equal(a.loadingCost, 90000, "the figure stays on the truck");
    assert.equal(a.totalExpenses, 90000, "paid, it still cost the truck that");
    assert.equal(a.paidInExpenses, 90000);
    assert.equal(a.stillToPay, 0);
  });

  test("deleting a truck off a pending request takes its loading off it", async () => {
    const extra = (await client`
      INSERT INTO delivery_inventory (truck_number, pfi_id, pfi_number, allocation_code, quantity_allocated)
      VALUES (${`LDX${TAG}`}, ${paidPfi.id}, ${paidPfi.pfi_number}, ${paidPfi.allocation_code}, 40000) RETURNING id`)[0].id;
    made.trips.push(Number(extra));
    await cost([t.d, Number(extra)], { loadingCost: 50000 });
    assert.equal(Number((await live(paidPfi.id))[0].amount), 100000);
    const res = await as().del(`/api/delivery-inventory/${extra}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(Number((await live(paidPfi.id))[0].amount), 50000);
  });

  // ── Paid already ────────────────────────────────────────────────────────

  test("recording loading as paid needs a super admin and the payment's facts", async () => {
    const weak = await staffTokenWithRoles(["admin"], `loading-weak-${TAG}@soroman.test`);
    await grantPage(weak.staff.id, "/delivery-costing");
    const no = await as(weak.accessToken).post("/api/delivery-inventory/loading-paid", { ids: [t.d], paid: PAID });
    assert.equal(no.status, 403, JSON.stringify(no.body));
    assert.match(no.body.message, /Only a super admin/);

    const blank = await as().post("/api/delivery-inventory/loading-paid", { ids: [t.d], paid: { ...PAID, paymentReference: "" } });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));

    const none = await as().post("/api/delivery-inventory/loading-paid", { ids: [t.e], paid: PAID });
    assert.equal(none.status, 409, JSON.stringify(none.body));
    assert.match(none.body.message, /no loading entered/);
  });

  test("loading paid already is written in as a paid expense, and its pending request goes", async () => {
    await cost([t.e], { loadingCost: 50000 });
    const before = await live(paidPfi.id);
    assert.equal(before.length, 1, "the pending request for d and e");
    assert.equal(Number(before[0].amount), 100000);

    const res = await as().post("/api/delivery-inventory/loading-paid", { ids: [t.d, t.e], paid: PAID });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.message, /recorded as paid: ₦100,000 loading on 2 trucks/);
    assert.match(res.body.message, /deleted — no truck's loading left on it/);

    const after = await live(paidPfi.id);
    assert.equal(after.length, 1);
    const [e] = after;
    assert.equal(e.status, "paid");
    assert.equal(Number(e.paid), 100000);
    assert.equal(e.bank_paid_from, PAID.bankPaidFrom);
    assert.equal(e.payment_reference, PAID.paymentReference);
    assert.equal(e.category_id, loadingCat);
    const [audit] = await client`SELECT action FROM pfi_expense_audits WHERE expense_id = ${e.id}`;
    assert.equal(audit.action, "recorded_as_paid");

    const d = await row(t.d);
    assert.equal(d.loadingRequest.reference, e.reference_number);
    assert.equal(d.paidInExpenses, Number(d.loadingCost), "paid: carried by the PFI");
    assert.equal(d.stillToPay, 0);
    const changed = await cost([t.d], { loadingCost: 1 });
    assert.equal(changed.status, 409, "recorded as paid: fixed");
  });

  test("an owner's advance paid already is recorded as paid, and comes off what the trucks are owed", async () => {
    await cost([t.h1, t.h2], { haulageRate: 20 });
    const res = await as().post("/api/delivery-inventory/owner-payments", {
      ids: [t.h1, t.h2], kind: "advance", amount: 600000, paid: PAID,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.message, /recorded as paid: haulage advance of ₦600,000 to GOLOLO/);
    const [e] = await live(hiredPfi.id);
    assert.equal(e.status, "paid");
    assert.equal(e.payment_reference, PAID.paymentReference);
    const h1 = await row(t.h1);
    assert.equal(h1.ownerPaid, 300000);
    assert.equal(h1.haulageAdded, 1000000 - 300000, "what is paid comes off the trip's haulage");

    const linked = await as().post("/api/delivery-inventory/owner-payments", {
      ids: [t.h1], kind: "advance", expenseId: e.id, paid: PAID,
    });
    assert.equal(linked.status, 400, "an expense already raised is not recorded as paid again");
  });
});
