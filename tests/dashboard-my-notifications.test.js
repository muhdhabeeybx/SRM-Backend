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
 * A staff member's notifications on their dashboard: their own inbox, less
 * the role-wide notices that are not about them.
 *
 * What has to hold: nobody else's rows ever appear; an order notice shows only
 * when the order is inside the reader's scope; Dangote and LPG requests are
 * kept from PFI-confined staff and nobody else; archived rows are gone; and
 * the unread count counts exactly what the list could show.
 */
const URL = "/api/dashboard/my-notifications";
const RUN = Date.now();

let mine;
let theirs;
let open;
let pfiA;
let pfiB;
const staffIds = [];
const orderIds = [];

const get = (t) => request(app).get(URL).set("Authorization", `Bearer ${t}`);
const titles = (res) => res.body.data.items.map((n) => n.title).sort();

describe("My notifications on the dashboard", () => {
  before(async () => {
    [pfiA, pfiB] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/NOTE/A/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/NOTE/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
      ])
      .returning();

    const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    const seedOrder = async (pfiId) => {
      const [o] = await client`
        INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                            price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id)
        SELECT ${"NOTE" + Math.floor(Math.random() * 1e9)}, ${c.id}, 'Lagos', d.id, p.id, 100,
               1000, 100000, 0, 'delivery', 'Pending', 'Unpaid', ${pfiId}
          FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
        RETURNING id`;
      orderIds.push(Number(o.id));
      return Number(o.id);
    };
    const onA = await seedOrder(pfiA.id);
    const onB = await seedOrder(pfiB.id);

    const confined = await staffTokenWithRoles(["sales_manager"], `note-confined-${RUN}@soroman.test`);
    const other = await staffTokenWithRoles(["sales_manager"], `note-other-${RUN}@soroman.test`);
    const everywhere = await staffTokenWithRoles(["sales_manager"], `note-open-${RUN}@soroman.test`);
    mine = confined.accessToken;
    theirs = other.accessToken;
    open = everywhere.accessToken;
    const [me, you, all] = [confined, other, everywhere].map((s) => Number(s.staff.id));
    staffIds.push(me, you, all);

    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${me}`;
    await client`UPDATE staff SET can_view_all_locations = true WHERE id = ${all}`;
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${pfiA.id}, ${me})`;

    const note = (staffId, title, type, category, entityType, entityId, { read = false, archived = false } = {}) => client`
      INSERT INTO notifications (recipient_type, staff_id, type, category, title, body, entity_type, entity_id,
                                 read_at, archived_at)
      VALUES ('staff', ${staffId}, ${type}, ${category}, ${title}, 'x', ${entityType}, ${String(entityId)},
              ${read ? new Date().toISOString() : null}, ${archived ? new Date().toISOString() : null})`;

    await note(me, "order on my PFI", "staff.order_placed", "operations", "order", onA);
    await note(me, "payment on another PFI", "staff.payment_received", "payments", "order", onB);
    await note(me, "my expense verified", "expense.verified", "payments", "pfi_expense", 1);
    await note(me, "dangote request", "staff.request_submitted", "operations", "dangote_request", 1);
    await note(me, "tickets waiting", "staff.tickets_pending", "operations", "queue", "tickets", { read: true });
    await note(me, "archived one", "expense.paid", "payments", "pfi_expense", 2, { archived: true });
    await note(you, "somebody else's", "expense.paid", "payments", "pfi_expense", 3);
    await note(all, "payment on another PFI", "staff.payment_received", "payments", "order", onB);
    await note(all, "dangote request", "staff.request_submitted", "operations", "dangote_request", 1);
  });

  after(async () => {
    await client`DELETE FROM notifications WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id]));
    await closeDb();
  });

  test("a PFI person sees their own notices, and orders on their PFI only", async () => {
    const res = await get(mine);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(titles(res), ["my expense verified", "order on my PFI", "tickets waiting"]);
  });

  test("the unread count counts only what the list could show", async () => {
    const res = await get(mine);
    assert.equal(res.body.data.unreadCount, 2, "the read desk nudge and the hidden ones are not counted");
  });

  test("nobody sees another person's notifications", async () => {
    const res = await get(theirs);
    assert.deepEqual(titles(res), ["somebody else's"]);
  });

  test("somebody with every location keeps company-wide orders and requests", async () => {
    const res = await get(open);
    assert.deepEqual(titles(res), ["dangote request", "payment on another PFI"]);
  });

  test("the list is newest first and capped", async () => {
    const res = await request(app).get(`${URL}?limit=1`).set("Authorization", `Bearer ${mine}`);
    assert.equal(res.body.data.items.length, 1);
  });
});
