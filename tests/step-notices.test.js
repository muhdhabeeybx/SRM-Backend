// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { inArray } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { officersFor } = require("../notifications/deskOfficers");
const { CATALOG } = require("../notifications/catalog");
const { choiceForType } = require("../notifications/staffChoices");
const stepNotices = require("../services/stepNotices.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * The texts that follow an order from desk to desk.
 *
 * What has to hold: a step reaches the officers of the next desk on the
 * order's PFI and nobody on other PFIs; when the PFI has nobody on that desk it
 * falls back to the role's company-wide holders, then to the admins, so a step
 * is never silent; a suspended officer is never told; and a PFI with no desks
 * (gantry, delivery) is never told about tickets.
 */
const RUN = Date.now();
// A role nobody else in the test database holds, so the fallback tiers can be
// tested without every other suite's staff joining in.
const ROLE = `desk-test-${RUN}`;

let pfiA;
let pfiB;
let gantry;
let onA;
let onB;
let companyWide;
let financeOnA;
let financeOnB;
const orderIds = [];
const staffIds = [];

const ids = (specs) => specs.map((s) => Number(s.staffId)).sort();

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
    [pfiA, pfiB, gantry] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/STEP/A/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/STEP/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/STEP/G/${RUN}`, status: "active", startingQtyLitres: 1000, pfiType: "gantry" },
      ])
      .returning();

    onA = await person([ROLE], "on-a");
    onB = await person([ROLE], "on-b");
    companyWide = await person([ROLE], "company");
    financeOnA = await person(["finance"], "fin-a");
    financeOnB = await person(["finance"], "fin-b");

    await client`
      INSERT INTO pfi_staff (pfi_id, staff_id)
      VALUES (${pfiA.id}, ${onA}), (${pfiB.id}, ${onB}),
             (${pfiA.id}, ${financeOnA}), (${pfiB.id}, ${financeOnB})`;
  });

  after(async () => {
    await client`DELETE FROM notifications WHERE data->>'orderId' = ANY(${orderIds.map(String)})`;
    await client`DELETE FROM notifications WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id, gantry.id]));
    await client`UPDATE staff SET is_active = false WHERE id = ANY(${staffIds})`;
    await closeDb();
  });

  test("a desk on a PFI is its own officers, not the other PFI's nor the company-wide ones", async () => {
    assert.deepEqual(ids(await officersFor({ pfiId: pfiA.id, roles: [ROLE] })), [onA]);
    assert.deepEqual(ids(await officersFor({ pfiId: pfiB.id, roles: [ROLE] })), [onB]);
  });

  test("a PFI with nobody on the desk falls to the role's company-wide holders", async () => {
    assert.deepEqual(ids(await officersFor({ pfiId: gantry.id, roles: [ROLE] })), [companyWide]);
    // Somebody confined to other depots is not company-wide for this one.
    await client`INSERT INTO depot_staff (depot_id, staff_id) SELECT id, ${companyWide} FROM depots ORDER BY id DESC LIMIT 1`;
    const [{ id: otherDepot }] = await client`SELECT id FROM depots ORDER BY id LIMIT 1`;
    const [{ id: theirDepot }] = await client`SELECT id FROM depots ORDER BY id DESC LIMIT 1`;
    if (Number(otherDepot) !== Number(theirDepot)) {
      assert.deepEqual(await officersFor({ pfiId: gantry.id, depotId: otherDepot, roles: [ROLE] }), [
        { roles: ["admin", "super_admin"] },
      ]);
    }
    assert.deepEqual(ids(await officersFor({ pfiId: gantry.id, depotId: theirDepot, roles: [ROLE] })), [companyWide]);
    await client`DELETE FROM depot_staff WHERE staff_id = ${companyWide}`;
  });

  test("a desk nobody holds goes to the admins", async () => {
    assert.deepEqual(await officersFor({ pfiId: pfiA.id, roles: [`nobody-${RUN}`] }), [
      { roles: ["admin", "super_admin"] },
    ]);
  });

  test("a suspended officer is not the desk", async () => {
    await client`UPDATE staff SET suspended = true WHERE id = ${onA}`;
    try {
      // With A's officer suspended, A has nobody: the company-wide holder takes it.
      assert.deepEqual(ids(await officersFor({ pfiId: pfiA.id, roles: [ROLE] })), [companyWide]);
    } finally {
      await client`UPDATE staff SET suspended = false WHERE id = ${onA}`;
    }
  });

  test("a new order asks finance on its own PFI to confirm the payment", async () => {
    const orderId = await orderOn(pfiA);
    stepNotices.orderPlaced(orderId);
    const told = await rowsFor("desk.order_to_confirm", orderId);
    assert.ok(told.includes(financeOnA), "finance on the order's PFI is told");
    assert.ok(!told.includes(financeOnB), "finance on another PFI is not");
  });

  test("a gantry order is never sent to ticketing — it has no ticketing desk", async () => {
    const orderId = await orderOn(gantry);
    stepNotices.orderArrived(orderId, "Released");
    const told = await rowsFor("desk.order_to_ticket", orderId, { expect: 1, ms: 800 });
    assert.deepEqual(told, []);
  });

  test("every desk step is an SMS, and can be switched off per person", () => {
    const deskTypes = Object.keys(CATALOG).filter((t) => t.startsWith("desk."));
    assert.ok(deskTypes.length >= 8);
    for (const t of deskTypes) {
      assert.ok(CATALOG[t].channels.includes("sms"), `${t} texts`);
      assert.equal(choiceForType(t)?.key, "desk_steps", `${t} is on the desk_steps choice`);
    }
  });

  test("a text renders without the fields it may be missing", () => {
    for (const t of [...Object.keys(CATALOG).filter((k) => k.startsWith("desk.")),
      "order.truck_ticketed_driver", "order.trucks_ticketed", "order.truck_departed", "delivery.payment_confirmed"]) {
      const sms = CATALOG[t].sms({});
      assert.equal(typeof sms, "string", t);
      assert.ok(!/undefined|null|NaN/.test(sms), `${t}: ${sms}`);
    }
  });
});
