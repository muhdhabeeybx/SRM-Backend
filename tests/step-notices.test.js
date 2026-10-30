// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { inArray } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { officersFor, DESKS } = require("../notifications/deskOfficers");
const { CATALOG } = require("../notifications/catalog");
const { choiceForType, publicChoices } = require("../notifications/staffChoices");
const stepNotices = require("../services/stepNotices.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * The texts that follow an order from desk to desk.
 *
 * What has to hold: a step reaches the officer the PFI names for the next desk
 * and nobody else — not others on the PFI who hold the role. Where the slot is
 * empty it reaches whoever holds the role and is assigned to that PFI. Never the
 * rest of the company, never the admins. A desk with nobody on it texts nobody,
 * a suspended officer is never told, and a PFI with no desks (gantry, delivery)
 * is never told about tickets.
 */
const RUN = Date.now();

let pfiA;
let pfiB;
let pfiTicked;
let gantry;
let financeOnA;
let financeOnB;
let alsoFinanceOnA;
let tickedFinance;
let elsewhereFinance;
let salesOnA;
let sellerOnA;
const orderIds = [];
const staffIds = [];

const ids = (specs) => specs.map((s) => Number(s.staffId)).sort((x, y) => x - y);

/** The rows a step wrote for this run's orders — polled, because steps are fire-and-forget. */
const rowsFor = async (type, orderId, { expect = 1, ms = 3000 } = {}) => {
  const until = Date.now() + ms;
  let rows = [];
  while (Date.now() < until) {
    rows = await client`
      SELECT staff_id FROM notifications WHERE type = ${type} AND data->>'orderId' = ${String(orderId)}`;
    if (rows.length >= expect) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows.map((r) => Number(r.staff_id));
};

const person = async (roles, tag) => {
  const s = await staffTokenWithRoles(roles, `step-${tag}-${RUN}@soroman.test`);
  const id = Number(s.staff.id);
  staffIds.push(id);
  return id;
};

const orderOn = async (pfi) => {
  const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
  const [o] = await client`
    INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                        price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id)
    SELECT ${"STEP" + Math.floor(Math.random() * 1e9)}, ${c.id}, 'Lagos', d.id, p.id, 100,
           1000, 100000, 0, 'delivery', 'Pending', 'Unpaid', ${pfi.id}
      FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
    RETURNING id`;
  orderIds.push(Number(o.id));
  return Number(o.id);
};

describe("Step notices", () => {
  before(async () => {
    [pfiA, pfiB, pfiTicked, gantry] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/STEP/A/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/STEP/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/STEP/T/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/STEP/G/${RUN}`, status: "active", startingQtyLitres: 1000, pfiType: "gantry" },
      ])
      .returning();

    financeOnA = await person(["finance"], "fin-a");
    financeOnB = await person(["finance"], "fin-b");
    alsoFinanceOnA = await person(["finance", "sales_manager"], "also-fin-a");
    tickedFinance = await person(["finance"], "ticked");
    // Holds the role, assigned to nothing: the company-wide kind who used to get every empty desk's texts.
    elsewhereFinance = await person(["finance"], "elsewhere");
    salesOnA = await person(["truck_sales"], "sales-a");
    sellerOnA = await person(["truck_sales"], "seller-a");

    await client`
      UPDATE pfis SET audit_officer_id = ${financeOnA}, sales_manager_id = ${salesOnA}, truck_sales_officer_id = ${sellerOnA}
       WHERE id = ${pfiA.id}`;
    await client`UPDATE pfis SET audit_officer_id = ${financeOnB} WHERE id = ${pfiB.id}`;
    // On the PFI, with the role, but named for a different job.
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${pfiA.id}, ${alsoFinanceOnA})`;
    // No slot filled: this PFI's finance is the one ticked on it in Manage Users.
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${pfiTicked.id}, ${tickedFinance}), (${pfiTicked.id}, ${salesOnA})`;
  });

  after(async () => {
    await client`DELETE FROM notifications WHERE data->>'orderId' = ANY(${orderIds.map(String)})`;
    await client`DELETE FROM notifications WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id, pfiTicked.id, gantry.id]));
    await client`UPDATE staff SET is_active = false WHERE id = ANY(${staffIds})`;
    await closeDb();
  });

  test("a desk is the officer its PFI names, not others with the role", async () => {
    assert.deepEqual(ids(await officersFor({ pfiId: pfiA.id, desk: DESKS.finance })), [financeOnA]);
    assert.deepEqual(ids(await officersFor({ pfiId: pfiB.id, desk: DESKS.finance })), [financeOnB]);
  });

  test("the truck sales desk is the Sales Manager and the Truck Sales Officer", async () => {
    assert.deepEqual(
      ids(await officersFor({ pfiId: pfiA.id, desk: DESKS.truckSales })),
      [salesOnA, sellerOnA].sort((x, y) => x - y),
    );
  });

  test("an empty slot goes to whoever holds the role and is assigned to that PFI", async () => {
    const told = ids(await officersFor({ pfiId: pfiTicked.id, desk: DESKS.finance }));
    assert.deepEqual(told, [tickedFinance]);
    assert.ok(!told.includes(salesOnA), "on the PFI, without the role, is not the desk");
    assert.ok(!told.includes(elsewhereFinance), "the role, off the PFI, is not the desk");
  });

  test("a desk with nobody on it texts nobody, not the company or the admins", async () => {
    assert.deepEqual(await officersFor({ pfiId: gantry.id, desk: DESKS.finance }), []);
    assert.deepEqual(await officersFor({ pfiId: null, desk: DESKS.finance }), []);
  });

  test("a suspended officer is not told", async () => {
    await client`UPDATE staff SET suspended = true WHERE id = ${financeOnB}`;
    try {
      assert.deepEqual(await officersFor({ pfiId: pfiB.id, desk: DESKS.finance }), []);
    } finally {
      await client`UPDATE staff SET suspended = false WHERE id = ${financeOnB}`;
    }
  });

  test("a new order asks the PFI's named finance officer to confirm the payment", async () => {
    const orderId = await orderOn(pfiA);
    stepNotices.orderPlaced(orderId);
    const told = await rowsFor("desk.order_to_confirm", orderId);
    assert.deepEqual(told, [financeOnA]);
  });

  test("a gantry order is never sent to ticketing — it has no ticketing desk", async () => {
    const orderId = await orderOn(gantry);
    stepNotices.orderArrived(orderId, "Released");
    const told = await rowsFor("desk.order_to_ticket", orderId, { expect: 1, ms: 800 });
    assert.deepEqual(told, []);
  });

  test("every desk step is an SMS, and can be switched off per person", () => {
    const deskTypes = Object.keys(CATALOG).filter((t) => t.startsWith("desk."));
    assert.ok(deskTypes.length >= 6);
    for (const t of deskTypes) {
      assert.ok(CATALOG[t].channels.includes("sms"), `${t} texts`);
      assert.equal(choiceForType(t)?.key, "desk_steps", `${t} is on the desk_steps choice`);
    }
    assert.ok(publicChoices().some((c) => c.key === "desk_steps"));
  });

  test("a text renders without the fields it may be missing", () => {
    for (const t of [...Object.keys(CATALOG).filter((k) => k.startsWith("desk.")), "delivery.payment_confirmed"]) {
      const sms = CATALOG[t].sms({});
      assert.equal(typeof sms, "string", t);
      assert.ok(!/undefined|null|NaN/.test(sms), `${t}: ${sms}`);
    }
  });

  test("on a depot order the customer's one text is the payment", () => {
    assert.ok(CATALOG["order.paid"].channels.includes("sms"));
    for (const t of ["order.released", "order.trucks_ticketed", "order.truck_departed", "order.completed"]) {
      assert.ok(!CATALOG[t].channels.includes("sms"), `${t} does not text`);
      assert.ok(CATALOG[t].channels.includes("in_app"), `${t} stays in the app`);
    }
    // Their order being cancelled is news they must get.
    assert.ok(CATALOG["order.cancelled"].channels.includes("sms"));
  });
});
