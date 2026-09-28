// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { inArray } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { dispatch } = require("../notifications/engine");
const { rolesFor, KEYS } = require("../notifications/staffChoices");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Which notifications each member of staff gets, ticked per person on Manage
 * Users.
 *
 * What has to hold: a super admin can set a person's choices and read them
 * back, and nobody else can; a role notice skips somebody switched off and
 * reaches somebody switched on who lacks the role; a personal notice can be
 * switched off but never switched on; and an untick hides that person's old
 * rows of the type from their bell and dashboard at once.
 */
const RUN = Date.now();
// Payment notices carry an order id in their data; these are not real orders,
// only a key to find and remove this run's rows by.
const ORDER_KEY = String(900000000 + (RUN % 1000000));

let superToken;
let salesId;
let salesToken;
let ticketingId;
let ticketingToken;
let clerkId;
let clerkToken;
let confinedId;
let pfiA;
let pfiB;
const orderIds = [];

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${t}`).send(body),
});

const rowsFor = (staffId, type) => client`
  SELECT id FROM notifications
   WHERE staff_id = ${staffId} AND type = ${type} AND data->>'orderId' = ${ORDER_KEY}`;

describe("Staff notification choices", () => {
  before(async () => {
    superToken = await staffToken(request, app);
    const sales = await staffTokenWithRoles(["sales_manager"], `choice-sales-${RUN}@soroman.test`);
    const ticketing = await staffTokenWithRoles(["ticketing"], `choice-ticket-${RUN}@soroman.test`);
    const clerk = await staffTokenWithRoles(["finance"], `choice-clerk-${RUN}@soroman.test`);
    [salesId, ticketingId, clerkId] = [sales, ticketing, clerk].map((s) => Number(s.staff.id));
    [salesToken, ticketingToken, clerkToken] = [sales, ticketing, clerk].map((s) => s.accessToken);

    // A manager confined to one PFI, and a real order on it and on another.
    [pfiA, pfiB] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/CHOICE/A/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/CHOICE/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
      ])
      .returning();
    const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    for (const pfi of [pfiA, pfiB]) {
      const [o] = await client`
        INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                            price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id)
        SELECT ${"CHOICE" + Math.floor(Math.random() * 1e9)}, ${c.id}, 'Lagos', d.id, p.id, 100,
               1000, 100000, 100000, 'delivery', 'Paid', 'Paid', ${pfi.id}
          FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
        RETURNING id`;
      orderIds.push(Number(o.id));
    }
    const confined = await staffTokenWithRoles(["sales_manager"], `choice-confined-${RUN}@soroman.test`);
    confinedId = Number(confined.staff.id);
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${pfiA.id}, ${confinedId})`;
  });

  after(async () => {
    const ids = [salesId, ticketingId, clerkId, confinedId];
    await client`DELETE FROM notifications WHERE data->>'orderId' = ${ORDER_KEY}`;
    await client`DELETE FROM notifications WHERE data->>'orderId' = ANY(${orderIds.map(String)})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id]));
    await client`DELETE FROM notifications WHERE staff_id = ANY(${ids})`;
    await client`DELETE FROM staff_notification_overrides WHERE staff_id = ANY(${ids})`;
    await closeDb();
  });

  test("the form's list names every choice, and who gets the role ones", async () => {
    const res = await as(superToken).get("/api/admin/notification-choices");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const choices = res.body.data.choices;
    assert.deepEqual(choices.map((c) => c.key), KEYS);
    const orders = choices.find((c) => c.key === "orders_placed");
    assert.deepEqual(orders.roles, rolesFor("orders_placed"));
    assert.equal(orders.personal, false);
    assert.equal(choices.find((c) => c.key === "expenses").personal, true);
    assert.ok(!JSON.stringify(choices).includes("staff.order_placed"), "no internal type names");
  });

  test("a super admin sets a person's choices and reads them back; unknown ones are dropped", async () => {
    const res = await as(superToken).patch(`/api/admin/${salesId}`, {
      notification_overrides: [
        { choice: "payments_received", enabled: false },
        { choice: "no_such_choice", enabled: true },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const read = await as(superToken).get(`/api/admin/${salesId}`);
    assert.deepEqual(read.body.data.admin.notificationOverrides, [{ choice: "payments_received", enabled: false }]);

    const list = await as(superToken).get("/api/admin");
    const row = list.body.data.staff.find((s) => s.id === salesId);
    assert.deepEqual(row.notificationOverrides, [{ choice: "payments_received", enabled: false }]);
  });

  test("nobody but a super admin can change them — not even their own", async () => {
    const res = await as(clerkToken).patch(`/api/admin/${clerkId}`, {
      notification_overrides: [{ choice: "orders_placed", enabled: true }],
    });
    assert.equal(res.status, 403);
  });

  test("a role notice skips somebody switched off and reaches somebody switched on", async () => {
    await as(superToken).patch(`/api/admin/${ticketingId}`, {
      notification_overrides: [{ choice: "payments_received", enabled: true }],
    });
    await dispatch("staff.payment_received", {
      to: { roles: rolesFor("payments_received") },
      data: { orderId: ORDER_KEY, reference: `ORD-${ORDER_KEY}`, customerName: "Test", amountPaid: 1 },
      channels: ["in_app"],
    });
    assert.equal((await rowsFor(salesId, "staff.payment_received")).length, 0, "sales manager switched off");
    assert.equal((await rowsFor(ticketingId, "staff.payment_received")).length, 1, "ticketing switched on");
    assert.equal((await rowsFor(clerkId, "staff.payment_received")).length, 0, "finance clerk: no role, no tick");
  });

  test("the company-wide order feeds go to admins by default, not to sales managers", async () => {
    assert.ok(!rolesFor("orders_placed").includes("sales_manager"));
    assert.ok(!rolesFor("payments_received").includes("sales_manager"));
    assert.ok(rolesFor("payments_received").includes("admin"));
  });

  test("a manager ticked on for payments gets their own PFI's, not the company's", async () => {
    await as(superToken).patch(`/api/admin/${confinedId}`, {
      notification_overrides: [{ choice: "payments_received", enabled: true }],
    });
    const [onA, onB] = orderIds;
    for (const orderId of [onA, onB]) {
      await dispatch("staff.payment_received", {
        to: { roles: rolesFor("payments_received") },
        data: { orderId, reference: `ORD-${orderId}`, customerName: "Test", amountPaid: 1 },
        channels: ["in_app"],
      });
    }
    const got = await client`
      SELECT data->>'orderId' AS "orderId" FROM notifications
       WHERE staff_id = ${confinedId} AND type = 'staff.payment_received'`;
    assert.deepEqual(got.map((r) => Number(r.orderId)), [onA]);

    // Somebody who sees every location still gets both.
    const all = await client`
      SELECT count(*)::int AS n FROM notifications
       WHERE staff_id = ${ticketingId} AND type = 'staff.payment_received'
         AND data->>'orderId' = ANY(${orderIds.map(String)})`;
    assert.equal(all[0].n, 2);
  });

  test("a personal notice can be switched off, never switched on", async () => {
    await as(superToken).patch(`/api/admin/${clerkId}`, {
      notification_overrides: [{ choice: "expenses", enabled: false }],
    });
    await as(superToken).patch(`/api/admin/${ticketingId}`, {
      notification_overrides: [{ choice: "expenses", enabled: true }],
    });
    await dispatch("expense.paid", {
      to: [{ staffId: clerkId }],
      data: { orderId: ORDER_KEY, expenseId: 1, amount: 1 },
      channels: ["in_app"],
    });
    assert.equal((await rowsFor(clerkId, "expense.paid")).length, 0, "switched off");
    assert.equal((await rowsFor(ticketingId, "expense.paid")).length, 0, "switched on adds nobody to a personal notice");
  });

  test("an untick hides the person's old rows of that type from the bell and the dashboard", async () => {
    await client`UPDATE staff SET can_view_all_locations = true WHERE id = ${clerkId}`;
    await client`
      INSERT INTO notifications (recipient_type, staff_id, type, category, title, body, entity_type, entity_id)
      VALUES ('staff', ${clerkId}, 'expense.verified', 'payments', 'old expense notice', 'x', 'pfi_expense', '1'),
             ('staff', ${clerkId}, 'staff.tickets_pending', 'operations', 'desk reminder', 'x', 'queue', 'tickets')`;

    const bell = await as(clerkToken).get("/api/notifications");
    assert.deepEqual(bell.body.data.data.map((n) => n.title), ["desk reminder"]);
    assert.equal(bell.body.data.unreadCount, 1);

    const badge = await as(clerkToken).get("/api/notifications/unread-count");
    assert.equal(badge.body.data.unreadCount, 1);

    const dash = await as(clerkToken).get("/api/dashboard/my-notifications");
    assert.deepEqual(dash.body.data.items.map((n) => n.title), ["desk reminder"]);

    // Ticked back on, the rows return — nothing was deleted.
    await as(superToken).patch(`/api/admin/${clerkId}`, { notification_overrides: [] });
    const again = await as(clerkToken).get("/api/notifications");
    assert.equal(again.body.data.data.length, 2);
  });
});
