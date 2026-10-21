// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");

/**
 * Feeding entered in Delivery Costing raises the batch's payment request
 * (0095, the user, 2026-10-21) — one Feeding request per batch, on the
 * truck's PFI — so nobody types the same naira twice. The truck's feeding
 * counts on it until the request is paid, then the PFI's paid expenses carry
 * it. Once finance takes the request forward the feeding is fixed.
 */
const RUN = Date.now();
let token;
let category;
let made = false;
let pfi;
let other;
const trips = {};

const as = () => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
});
const cost = (ids, body) => as().post("/api/delivery-inventory/costs", { ids, ...body });
const row = async (id) => {
  const res = await as().get("/api/delivery-inventory?limit=1000");
  return res.body.data.inventory.find((r) => r.id === id);
};
const requestsOn = (pfiId) => client`
  SELECT id, reference_number, amount::numeric AS amount, status::text AS status, deleted_at, description, category_id
    FROM pfi_expenses WHERE pfi_id = ${pfiId} ORDER BY id`;

describe("feeding raised as a payment request from Delivery Costing", () => {
  before(async () => {
    token = await staffToken(request, app);
    [category] = await client`SELECT id FROM expense_categories WHERE pfi_id IS NULL AND lower(name) = 'feeding' LIMIT 1`;
    if (!category) {
      [category] = await client`
        INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup)
        VALUES ('Feeding', '5430', 'pfi_direct', 'PFI Operational Expenses') RETURNING id`;
      made = true;
    }
    const mk = (n) => client`
      INSERT INTO pfis (pfi_number, status, pfi_type, starting_qty_litres, allocation_code)
      VALUES (${`PFI/FEED${n}/${RUN}`}, 'active', 'trucking', 200000, ${`PFI-FD${n}${RUN % 10000}`}) RETURNING id, pfi_number, allocation_code`;
    [pfi] = await mk("A");
    [other] = await mk("B");
    const trip = (p, plate) => client`
      INSERT INTO delivery_inventory (truck_number, pfi_id, pfi_number, allocation_code, quantity_allocated, rate, product_price)
      VALUES (${plate}, ${p.id}, ${p.pfi_number}, ${p.allocation_code}, 50000, 1400, 1300) RETURNING id`.then((r) => Number(r[0].id));
    for (const k of ["a", "b", "c", "d"]) trips[k] = await trip(pfi, `FD${k.toUpperCase()}${RUN % 100000}`);
    for (const k of ["e", "f"]) trips[k] = await trip(other, `FD${k.toUpperCase()}${RUN % 100000}`);
  });

  after(async () => {
    const pfiIds = [pfi?.id, other?.id].filter(Boolean);
    await client`DELETE FROM delivery_inventory WHERE id = ANY(${Object.values(trips)}::int[])`;
    const exp = await client`SELECT id FROM pfi_expenses WHERE pfi_id = ANY(${pfiIds}::int[])`;
    const expIds = exp.map((e) => e.id);
    if (expIds.length) {
      await client`DELETE FROM pfi_expense_audits WHERE expense_id = ANY(${expIds}::int[])`;
      await client`DELETE FROM pfi_expenses WHERE id = ANY(${expIds}::int[])`;
    }
    await client`DELETE FROM pfis WHERE id = ANY(${pfiIds}::int[])`;
    if (made) await client`DELETE FROM expense_categories WHERE id = ${category.id}`;
    await closeDb();
  });

  test("feeding not ticked as paid raises one Feeding request for the batch, on its PFI", async () => {
    const res = await cost([trips.a, trips.b, trips.c], { feedingAllowance: 50000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /Feeding request EXP-\S+ raised on PFI-FDA\S* for ₦150,000, 3 trucks/);

    const reqs = await requestsOn(pfi.id);
    assert.equal(reqs.length, 1, "one request for the batch, not one per truck");
    assert.equal(reqs[0].status, "pending");
    assert.equal(Number(reqs[0].amount), 150000);
    assert.equal(Number(reqs[0].category_id), Number(category.id));
    assert.match(reqs[0].description, /3 trucks on PFI-FDA\S*, ₦50,000 each\. Raised from Delivery Costing\./);

    const a = await row(trips.a);
    assert.equal(a.feedingRequest.reference, reqs[0].reference_number);
    assert.equal(a.feedingRequest.status, "pending");
    assert.equal(a.totalExpenses, 50000, "until it is paid, the feeding still counts on the truck");
  });

  test("feeding saved on another truck of the batch joins the same request", async () => {
    const res = await cost([trips.d], { feedingAllowance: 50000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /now ₦200,000 for 4 trucks/);
    const reqs = await requestsOn(pfi.id);
    assert.equal(reqs.length, 1);
    assert.equal(Number(reqs[0].amount), 200000);
  });

  test("a truck ticked as already paid comes off the request", async () => {
    const res = await cost([trips.b], { feedingInExpenses: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [req] = await requestsOn(pfi.id);
    assert.equal(Number(req.amount), 150000);
    const b = await row(trips.b);
    assert.equal(b.feedingRequest, null);
    assert.equal(b.totalExpenses, 0, "paid elsewhere: not added");
  });

  test("a truck's feeding changed moves the pending request with it", async () => {
    await cost([trips.a], { feedingAllowance: 60000 });
    const [req] = await requestsOn(pfi.id);
    assert.equal(Number(req.amount), 160000);
    assert.match(req.description, /3 trucks on PFI-FDA\S*, ₦160,000 in all/);
  });

  test("once paid, the PFI carries the feeding and the truck adds nothing; the figure is fixed", async () => {
    const [req] = await requestsOn(pfi.id);
    await client`UPDATE pfi_expenses SET status = 'paid' WHERE id = ${req.id}`;
    const a = await row(trips.a);
    assert.equal(a.feedingRequest.status, "paid");
    assert.equal(a.totalExpenses, 0, "counted once — on the PFI now");

    const bulk = await cost([trips.a, trips.c], { feedingAllowance: 70000 });
    assert.equal(bulk.status, 409);
    assert.match(bulk.body.message, /already taken forward/);

    const one = await as().patch(`/api/delivery-inventory/${trips.a}`, { feedingAllowance: 70000 });
    assert.equal(one.status, 409);
    const same = await as().patch(`/api/delivery-inventory/${trips.a}`, { feedingAllowance: 60000, notes: "checked" });
    assert.equal(same.status, 200, "the same figure sent back is fine");
  });

  test("a request left with no trucks is deleted", async () => {
    await cost([trips.e], { feedingAllowance: 40000 });
    let reqs = await requestsOn(other.id);
    assert.equal(reqs.length, 1);
    const res = await cost([trips.e], { feedingAllowance: null, clearBlank: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /deleted — no truck's feeding left on it/);
    reqs = await requestsOn(other.id);
    assert.ok(reqs[0].deleted_at, "soft-deleted, so it drops out of every total");
    assert.equal((await row(trips.e)).feedingRequest, null);
  });

  test("a rejected request leaves the feeding on the truck; saving it again raises a new one", async () => {
    await cost([trips.f], { feedingAllowance: 45000 });
    const live = (await requestsOn(other.id)).filter((r) => !r.deleted_at);
    assert.equal(live.length, 1);
    await client`UPDATE pfi_expenses SET status = 'rejected' WHERE id = ${live[0].id}`;
    const f = await row(trips.f);
    assert.equal(f.feedingRequest.status, "rejected");
    assert.equal(f.totalExpenses, 45000, "still a cost of the trip");

    const again = await cost([trips.f], { feedingAllowance: 45000 });
    assert.equal(again.status, 200);
    assert.match(again.body.message, /raised/);
    const after2 = (await requestsOn(other.id)).filter((r) => !r.deleted_at && r.status === "pending");
    assert.equal(after2.length, 1);
    assert.notEqual(after2[0].id, live[0].id);
  });

  test("feeding ticked as already paid from the start raises nothing", async () => {
    const before = (await requestsOn(other.id)).length;
    const p2 = await client`
      INSERT INTO delivery_inventory (truck_number, pfi_id, pfi_number, quantity_allocated)
      VALUES (${`FDG${RUN % 100000}`}, ${other.id}, ${other.pfi_number}, 30000) RETURNING id`;
    trips.g = Number(p2[0].id);
    const res = await cost([trips.g], { feedingAllowance: 50000, feedingInExpenses: true });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body.message, /request/);
    const pending = (await requestsOn(other.id)).filter((r) => !r.deleted_at && r.status === "pending");
    assert.equal((await requestsOn(other.id)).length, before);
    assert.equal(Number(pending[0].amount), 45000, "the batch's open request is untouched");
  });
});
