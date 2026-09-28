// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { inArray } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * The PFIs a staff member is assigned to, as their dashboard shows them.
 *
 * What has to hold: every litre of stock is accounted for as sold, awaiting
 * payment or available; each loading gap is counted off its own rows; a PFI
 * with no desk or gate carries no loading figures, and a trucking PFI no
 * order figures; and no money figure is anywhere in the payload.
 */
const URL = "/api/dashboard/my-pfis";
const RUN = Date.now();

let confinedToken;
let confinedId;
let loneToken;
let coastal;
let gantry;
let trucking;
let unassigned;
let accountId;
const orderIds = [];

const get = (t) => request(app).get(URL).set("Authorization", `Bearer ${t}`);

/** Every key anywhere in a JSON value. */
const keysOf = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
};

describe("My PFIs on the dashboard", () => {
  before(async () => {
    [coastal, gantry, trucking, unassigned] = await db
      .insert(pfis)
      .values([
        {
          pfiNumber: `PFI/MINE/COASTAL/${RUN}`, status: "active", pfiType: "coastal",
          startingQtyLitres: 100000, blQtyLitres: 100000, unitPrice: "900", productName: "PMS",
        },
        {
          pfiNumber: `PFI/MINE/GANTRY/${RUN}`, status: "active", pfiType: "gantry",
          startingQtyLitres: 10000, unitPrice: "800",
        },
        {
          pfiNumber: `PFI/MINE/TRUCKING/${RUN}`, status: "active", pfiType: "trucking",
          startingQtyLitres: 90000, allocationCode: ` pfi-mine-${RUN} `,
        },
        { pfiNumber: `PFI/MINE/OTHER/${RUN}`, status: "active", startingQtyLitres: 5000 },
      ])
      .returning();

    const [account] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, pfi_ids, status)
      VALUES ('Mine Bank', 'Soroman Mine Account', ${`MINE${RUN}`.slice(0, 20)},
              ${JSON.stringify([String(coastal.id)])}::jsonb, 'Active')
      RETURNING id`;
    accountId = Number(account.id);

    const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    const seedOrder = async (pfiId, qty, status, paymentStatus) => {
      const [o] = await client`
        INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                            price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id)
        SELECT ${"MINE" + Math.floor(Math.random() * 1e9)}, ${c.id}, 'Lagos', d.id, p.id, ${qty},
               1000, ${qty * 1000}, ${paymentStatus === "Paid" ? qty * 1000 : 0}, 'delivery',
               ${status}, ${paymentStatus}, ${pfiId}
          FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
        RETURNING id`;
      orderIds.push(Number(o.id));
      return Number(o.id);
    };

    // Coastal: one paid order part-way through the gate, one paid and long
    // completed with no ticket ledger (how orders before it look), one
    // awaiting payment, and one cancelled that must count for nothing.
    const loading = await seedOrder(coastal.id, 40000, "Loading", "Paid");
    await seedOrder(coastal.id, 20000, "Completed", "Paid");
    await seedOrder(coastal.id, 15000, "Pending", "Unpaid");
    await seedOrder(coastal.id, 5000, "Cancelled", "Unpaid");

    await client`
      INSERT INTO pfi_movements (pfi_id, order_id, action, qty_litres)
      VALUES (${coastal.id}, ${loading}, 'RELEASE', 30000)`;
    await client`
      INSERT INTO order_trucks (order_id, truck_index, truck_number, quantity, status, security_exited_at)
      VALUES (${loading}, 1, 'MIN 001 XY', 20000, 'gated_out', now())`;
    await client`
      INSERT INTO order_trucks (order_id, truck_index, truck_number, quantity, status)
      VALUES (${loading}, 2, 'MIN 002 XY', 10000, 'loaded')`;

    // Gantry: more sold than it holds.
    await seedOrder(gantry.id, 12000, "Completed", "Paid");

    const confined = await staffTokenWithRoles(["ticketing"], `mine-confined-${RUN}@soroman.test`);
    confinedId = Number(confined.staff.id);
    confinedToken = confined.accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
    await client`
      INSERT INTO pfi_staff (pfi_id, staff_id)
      VALUES (${coastal.id}, ${confinedId}), (${gantry.id}, ${confinedId}), (${trucking.id}, ${confinedId})`;

    const lone = await staffTokenWithRoles(["finance"], `mine-lone-${RUN}@soroman.test`);
    loneToken = lone.accessToken;
  });

  after(async () => {
    await client`DELETE FROM order_trucks WHERE order_id = ANY(${orderIds})`;
    await client`DELETE FROM pfi_movements WHERE order_id = ANY(${orderIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
    await db.delete(pfis).where(inArray(pfis.id, [coastal.id, gantry.id, trucking.id, unassigned.id]));
    await closeDb();
  });

  test("lists the caller's own PFIs and nobody else's", async () => {
    const res = await get(confinedToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.data.pfis.map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [coastal.id, gantry.id, trucking.id].sort((a, b) => a - b));
  });

  test("somebody assigned nothing gets an empty list, not an error", async () => {
    const res = await get(loneToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.pfis, []);
  });

  test("stock splits into sold, awaiting payment and available", async () => {
    const p = (await get(confinedToken)).body.data.pfis.find((x) => x.id === coastal.id);
    assert.equal(p.kind, "depot");
    assert.equal(p.stock.total, 100000);
    assert.equal(p.sales.sold, 60000, "both paid orders");
    assert.equal(p.sales.soldOrders, 2);
    assert.equal(p.sales.customers, 1);
    assert.equal(p.sales.awaitingPayment, 15000, "the cancelled order is not waiting on anything");
    assert.equal(p.sales.awaitingOrders, 1);
    assert.equal(p.sales.available, 25000);
    assert.equal(p.sales.oversold, 0);
  });

  test("loading is sold → loaded → exited, each gap counted off its own rows", async () => {
    const { loading } = (await get(confinedToken)).body.data.pfis.find((x) => x.id === coastal.id);
    assert.equal(loading.loaded, 30000, "the ticket ledger");
    assert.equal(loading.soldNotLoaded, 10000, "only the open order — a completed one has nothing left to load");
    assert.equal(loading.soldNotLoadedOrders, 1);
    assert.equal(loading.loadedNotExited, 10000);
    assert.equal(loading.loadedNotExitedTrucks, 1);
    assert.equal(loading.exited, 20000);
    assert.equal(loading.exitedTrucks, 1);
  });

  test("a gantry PFI has no loading figures, and says when it is oversold", async () => {
    const p = (await get(confinedToken)).body.data.pfis.find((x) => x.id === gantry.id);
    assert.equal(p.kind, "deskless");
    assert.equal(p.loading, null);
    assert.equal(p.sales.available, 0, "never a negative stock");
    assert.equal(p.sales.oversold, 2000);
  });

  test("a trucking PFI carries no order figures, and its batch code", async () => {
    const p = (await get(confinedToken)).body.data.pfis.find((x) => x.id === trucking.id);
    assert.equal(p.kind, "trucks");
    assert.equal(p.sales, null);
    assert.equal(p.loading, null);
    assert.equal(p.allocationCode, `PFI-MINE-${RUN}`);
  });

  test("the accounts each PFI collects into come with it", async () => {
    const p = (await get(confinedToken)).body.data.pfis.find((x) => x.id === coastal.id);
    assert.equal(p.banks.length, 1);
    assert.equal(p.banks[0].bankName, "Mine Bank");
    assert.equal(p.banks[0].accountName, "Soroman Mine Account");
  });

  test("no money figure reaches the browser", async () => {
    const keys = keysOf((await get(confinedToken)).body.data);
    for (const k of [
      "unitPrice", "pricePerLitre", "pfiValue", "totalCost", "grandTotalCost", "totalExpenses",
      "revenue", "profitLoss", "margin", "landingCostPerLitre", "creditBalance", "amount",
    ]) {
      assert.ok(!keys.has(k), `${k} is not on the payload`);
    }
  });
});
