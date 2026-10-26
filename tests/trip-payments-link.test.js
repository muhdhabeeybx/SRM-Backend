// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");

/**
 * Feeding and haulage paid through Expenses, matched to the trucks they pay
 * for (the user, 2026-10-26) — so the same naira is never raised twice, and
 * the landing cost counts it once whichever side holds it.
 *
 *   feeding   a request raised by hand is linked to the batch's trucks and
 *             split equally; costing raises no second one while it waits.
 *   haulage   a hired truck's owner is paid an advance spread equally, then
 *             the balance, each a Transportation/Haulage request; what is
 *             paid comes off the trip's haulage.
 *   hired     a hired truck takes no feeding: its owner feeds the driver.
 */
const RUN = Date.now();
const TAG = String(RUN % 1000000);
let token;
let feedingCat;
let haulageCat;
const made = { categories: [], pfis: [], trucks: [], trips: [] };
let pfi;      // ours, for feeding
let other;    // ours, with a request raised from costing first
let hiredPfi; // hired trucks, for haulage
const t = {};

const as = () => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
  del: (url) => request(app).delete(url).set("Authorization", `Bearer ${token}`),
});
const cost = (ids, body) => as().post("/api/delivery-inventory/costs", { ids, ...body });
const row = async (id) => {
  const res = await as().get("/api/delivery-inventory?limit=1000");
  return res.body.data.inventory.find((r) => r.id === id);
};
const expensesOn = (pfiId) => client`
  SELECT id, reference_number, amount::numeric AS amount, status::text AS status, deleted_at, description, category_id, vendor
    FROM pfi_expenses WHERE pfi_id = ${pfiId} ORDER BY id`;
const handRaise = async (pfiId, categoryId, amount, description) => {
  const [e] = await client`
    INSERT INTO pfi_expenses (pfi_id, category_id, amount, description, status, currency, exchange_rate)
    VALUES (${pfiId}, ${categoryId}, ${amount}, ${description}, 'audit_approved', 'NGN', 1)
    RETURNING id, reference_number`;
  return e;
};
const pay = (id, amount) => client`
  UPDATE pfi_expenses SET status = 'paid', amount_paid = ${amount}, paid_at = NOW() WHERE id = ${id}`;

describe("feeding and haulage matched to the trucks they pay for", () => {
  before(async () => {
    token = await staffToken(request, app);
    const category = async (name, gl) => {
      let [c] = await client`SELECT id FROM expense_categories WHERE pfi_id IS NULL AND gl_code = ${gl} LIMIT 1`;
      if (!c) {
        [c] = await client`
          INSERT INTO expense_categories (name, gl_code, gl_group, gl_subgroup)
          VALUES (${name}, ${gl}, 'pfi_direct', 'PFI Operational Expenses') RETURNING id`;
        made.categories.push(c.id);
      }
      return Number(c.id);
    };
    feedingCat = await category("Feeding", "5430");
    haulageCat = await category("Transportation/Haulage", "5120");

    const mk = async (n) => {
      const [p] = await client`
        INSERT INTO pfis (pfi_number, status, pfi_type, starting_qty_litres, allocation_code)
        VALUES (${`PFI/TPL${n}/${RUN}`}, 'active', 'trucking', 500000, ${`PFI-TP${n}${TAG}`})
        RETURNING id, pfi_number, allocation_code`;
      made.pfis.push(p.id);
      return p;
    };
    pfi = await mk("A");
    other = await mk("B");
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
    for (const k of ["a", "b", "c"]) {
      const plate = `TPA${k.toUpperCase()}${TAG}`;
      t[k] = await trip(pfi, plate, await truck(plate, null));
    }
    for (const k of ["d", "e"]) {
      const plate = `TPB${k.toUpperCase()}${TAG}`;
      t[k] = await trip(other, plate, await truck(plate, null));
    }
    for (const k of ["h1", "h2", "h3"]) {
      const plate = `TPH${k.toUpperCase()}${TAG}`;
      t[k] = await trip(hiredPfi, plate, await truck(plate, `GOLOLO ${TAG}`));
    }
    const plate = `TPK${TAG}`;
    t.k = await trip(hiredPfi, plate, await truck(plate, `KUMO ${TAG}`));
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

  // ── Feeding ─────────────────────────────────────────────────────────────

  let handFeeding;

  test("a feeding expense raised by hand is offered for linking", async () => {
    handFeeding = await handRaise(pfi.id, feedingCat, 150000, "FEEDING ALLOWANCE FOR 3 SOROMAN TRUCKS @ #50,000 EACH");
    const res = await as().get(`/api/delivery-inventory/linkable?pfiIds=${pfi.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const offered = res.body.data.feeding.find((e) => e.id === Number(handFeeding.id));
    assert.ok(offered);
    assert.equal(offered.amount, 150000);
  });

  test("while it waits, costing the trucks' feeding raises no second request", async () => {
    const res = await cost([t.a, t.b, t.c], { feedingAllowance: 40000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /No new feeding request raised .*already raised there and linked to no truck/);
    const reqs = (await expensesOn(pfi.id)).filter((e) => !e.deleted_at);
    assert.equal(reqs.length, 1, "only the one raised by hand");
  });

  test("linking splits it equally across the trucks, and it is their request", async () => {
    const res = await as().post("/api/delivery-inventory/feeding-link", { expenseId: Number(handFeeding.id), ids: [t.a, t.b, t.c] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /linked to 3 trucks, ₦50,000 each/);
    const a = await row(t.a);
    assert.equal(Number(a.feedingAllowance), 50000);
    assert.equal(a.feedingRequest.id, Number(handFeeding.id));
    assert.equal(a.totalExpenses, 50000, "counted on the truck until it is paid");
    const [e] = await expensesOn(pfi.id);
    assert.equal(e.description, "FEEDING ALLOWANCE FOR 3 SOROMAN TRUCKS @ #50,000 EACH", "the words it was raised with");
    assert.equal(Number(e.amount), 150000);

    const offered = (await as().get(`/api/delivery-inventory/linkable?pfiIds=${pfi.id}`)).body.data.feeding;
    assert.equal(offered.length, 0, "linked, it is no longer offered");

    await pay(handFeeding.id, 150000);
    assert.equal((await row(t.a)).totalExpenses, 0, "paid: the PFI's expenses carry it");
  });

  test("linking replaces a request costing raised for the same trucks", async () => {
    await cost([t.d, t.e], { feedingAllowance: 50000 });
    const [raised] = await expensesOn(other.id);
    assert.equal(Number(raised.amount), 100000);
    const hand = await handRaise(other.id, feedingCat, 90000, "Drivers feeding");
    const res = await as().post("/api/delivery-inventory/feeding-link", { expenseId: Number(hand.id), ids: [t.d, t.e] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await expensesOn(other.id);
    assert.ok(after.find((e) => e.id === raised.id).deleted_at, "the one raised from costing is gone");
    assert.equal(Number((await row(t.d)).feedingAllowance), 45000);
  });

  test("a haulage rate goes on hired trucks only", async () => {
    const res = await cost([t.a], { haulageRate: "40" });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /third-party trucks only/);
  });

  test("a hired truck takes no feeding", async () => {
    const res = await cost([t.h1], { feedingAllowance: 50000 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /hired truck — the owner feeds the driver/);
    const patch = await as().patch(`/api/delivery-inventory/${t.h1}`, { feedingAllowance: 50000 });
    assert.equal(patch.status, 409);
  });

  // ── Haulage ─────────────────────────────────────────────────────────────

  let advance;

  test("an advance to an owner is one request, spread equally across their trucks", async () => {
    // ₦40 a litre on 50,000 L = ₦2m a trip; the owner took 500 L of AGO at ₦1,000, so gets ₦1.5m.
    const set = await cost([t.h1, t.h2, t.h3], { haulageRate: "40", agoLitres: 500, agoPrice: 1000 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const priced = await row(t.h1);
    assert.equal(priced.haulageRate, 40);
    assert.equal(priced.haulageAmount, 2000000, "rate × litres loaded");
    assert.equal(priced.haulageBalance, 1500000);

    const res = await as().post("/api/delivery-inventory/owner-payments", { ids: [t.h1, t.h2, t.h3], kind: "advance", amount: 3000000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.message, new RegExp(`Haulage advance request EXP-\\S+ raised to GOLOLO ${TAG} for ₦3,000,000, 3 trucks at ₦1,000,000 each`));
    advance = res.body.data.payment.expense;
    const [e] = await expensesOn(hiredPfi.id);
    assert.equal(Number(e.category_id), haulageCat);
    assert.equal(e.vendor, `GOLOLO ${TAG}`);
    assert.equal(e.status, "pending");

    const h = await row(t.h1);
    assert.equal(h.ownerRequested, 1000000);
    assert.equal(h.ownerPaid, 0);
    assert.equal(h.ownerOwed, 1500000);
    assert.equal(h.ownerToRaise, 500000);
    assert.equal(h.totalExpenses, 2000000, "unpaid, the whole haulage counts on the trip");
  });

  test("paid, the advance comes off the trip — the PFI's expenses carry it", async () => {
    await pay(advance.id, 3000000);
    const h = await row(t.h1);
    assert.equal(h.ownerPaid, 1000000);
    assert.equal(h.ownerRequested, 0);
    assert.equal(h.ownerOwed, 500000);
    assert.equal(h.totalExpenses, 1000000, "₦2m haulage − ₦1m already paid");
  });

  test("an advance cannot pay a truck more than it is owed", async () => {
    const res = await as().post("/api/delivery-inventory/owner-payments", { ids: [t.h1], kind: "advance", amount: 600000 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /has ₦500,000 left to pay its owner/);
  });

  test("the balance asks for what each truck still has to come, and once paid the owner is paid off", async () => {
    const res = await as().post("/api/delivery-inventory/owner-payments", { ids: [t.h1, t.h2, t.h3], kind: "balance" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const bal = res.body.data.payment.expense;
    assert.equal(bal.amount, 1500000);
    await pay(bal.id, 1500000);
    const h = await row(t.h1);
    assert.equal(h.ownerOwed, 0);
    assert.ok(h.ownerPaidOffOn, "the day the balance was paid");
    assert.equal(h.totalExpenses, 500000, "what is left on the trip is the AGO the owner took");
    const again = await as().post("/api/delivery-inventory/owner-payments", { ids: [t.h1], kind: "balance" });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /Nothing is left to pay/);
  });

  test("one owner at a time, and a hand-raised advance can be spread instead of raised again", async () => {
    const mixed = await as().post("/api/delivery-inventory/owner-payments", { ids: [t.h1, t.k], kind: "advance", amount: 100 });
    assert.equal(mixed.status, 409);
    assert.match(mixed.body.message, /one owner at a time/);

    const hand = await handRaise(hiredPfi.id, haulageCat, 800000, "Advance to Kumo");
    const offered = (await as().get(`/api/delivery-inventory/linkable?pfiIds=${hiredPfi.id}`)).body.data.haulage;
    assert.ok(offered.find((e) => e.id === Number(hand.id)));
    const res = await as().post("/api/delivery-inventory/owner-payments", { ids: [t.k], kind: "advance", expenseId: Number(hand.id) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /spread across 1 of KUMO/);
    assert.equal((await row(t.k)).ownerRequested, 800000);
  });

  test("a truck on an owner payment cannot be deleted from under it", async () => {
    const res = await as().del(`/api/delivery-inventory/${t.h2}`);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /owner payment/);
  });
});
