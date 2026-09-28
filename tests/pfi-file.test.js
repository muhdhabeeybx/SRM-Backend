// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { inArray } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * The PFI file: its notes, and the facts the file and its reports read beside
 * the PFI row — who raised and released it, the accounts it collects into,
 * where its money actually landed, and every truck on every order.
 *
 * What has to hold is that notes belong to whoever wrote them, that a
 * withdrawn note leaves the file but not the table, and that the file's
 * counts are read off the rows that exist rather than guessed.
 */
const API = "/api/pfis";
const RUN = Date.now();

let token;
let otherToken;
let otherId;
let confinedToken;
let confinedId;
let pfi;
let hidden;
let raiserId;
let accountId;
let customerId;
let orderIds = [];

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${t}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${t}`).send(body),
  delete: (url) => request(app).delete(url).set("Authorization", `Bearer ${t}`),
});

describe("PFI file", () => {
  before(async () => {
    token = await staffToken(request, app);

    const other = await staffTokenWithRoles(["admin"], `file-other-${RUN}@soroman.test`);
    otherId = Number(other.staff.id);
    otherToken = other.accessToken;
    await client`UPDATE staff SET first_name = 'Ngozi', surname = 'Other' WHERE id = ${otherId}`;

    const [raiser] = await client`SELECT id FROM staff WHERE email = 'test-staff@soroman.test'`;
    raiserId = Number(raiser.id);

    [pfi, hidden] = await db
      .insert(pfis)
      .values([
        {
          pfiNumber: `PFI/FILE/A/${RUN}`, status: "active", pfiType: "coastal",
          startingQtyLitres: 100000, blQtyLitres: 100000, unitPrice: "900",
          raisedBy: raiserId, raisedAt: new Date("2026-08-01T09:00:00Z"),
          activatedBy: otherId, activatedAt: new Date("2026-08-03T10:00:00Z"), reviewNote: "Checked the BL",
        },
        { pfiNumber: `PFI/FILE/B/${RUN}`, status: "active", startingQtyLitres: 5000 },
      ])
      .returning();

    // An account assigned to the PFI, with the stamp migration 0054 keeps.
    const [account] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, pfi_ids, pfi_assigned_at, status)
      VALUES ('File Bank', 'Soroman File Account', ${`FILE${RUN}`.slice(0, 20)},
              ${JSON.stringify([String(pfi.id)])}::jsonb,
              ${JSON.stringify({ [String(pfi.id)]: "2026-08-03T10:00:00.000Z" })}::jsonb, 'Active')
      RETURNING id`;
    accountId = Number(account.id);

    const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
    customerId = Number(c.id);

    // Two orders: one paid with two trucks and a ticket on the first, one
    // part paid with an order-level ticket and no trucks.
    const seedOrder = async (qty, total, paid, status) => {
      const [o] = await client`
        INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                            price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id,
                            payment_confirmed_at)
        SELECT ${"FILE" + Math.floor(Math.random() * 1e9)}, ${customerId}, 'Lagos', d.id, p.id, ${qty},
               ${total / qty}, ${total}, ${paid}, 'delivery', 'Paid', ${status}, ${pfi.id}, now()
          FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
        RETURNING id`;
      await client`
        INSERT INTO order_payments (order_id, amount, source, txn_date, depositor, narration, bank_ref,
                                    bank_name, account_name, account_number)
        VALUES (${o.id}, ${paid}, 'statement', '2026-08-05T00:00:00Z', 'Buyer', 'seed', ${"REF" + o.id},
                'File Bank', 'Soroman File Account', ${`FILE${RUN}`.slice(0, 20)})`;
      orderIds.push(Number(o.id));
      return Number(o.id);
    };
    const paid = await seedOrder(90000, 81000000, 81000000, "Paid");
    const partPaid = await seedOrder(10000, 9000000, 4000000, "Part Paid");

    const [t1] = await client`
      INSERT INTO order_trucks (order_id, truck_index, truck_number, quantity, status, driver_name, security_exited_at)
      VALUES (${paid}, 1, 'ABC 123 XY', 45000, 'gated_out', 'Musa', now()) RETURNING id`;
    await client`
      INSERT INTO order_trucks (order_id, truck_index, truck_number, quantity, status, driver_name)
      VALUES (${paid}, 2, 'KJA 456 ZZ', 45000, 'loaded', 'Tunde')`;
    await client`
      INSERT INTO tickets (ticket_number, order_id, order_truck_id, qr_code_data_url)
      VALUES (${`TKT-FILE-${RUN}-1`}, ${paid}, ${t1.id}, 'data:')`;
    await client`
      INSERT INTO tickets (ticket_number, order_id, qr_code_data_url)
      VALUES (${`TKT-FILE-${RUN}-2`}, ${partPaid}, 'data:')`;

    const confined = await staffTokenWithRoles(["admin"], `file-confined-${RUN}@soroman.test`);
    confinedId = Number(confined.staff.id);
    confinedToken = confined.accessToken;
    await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${confinedId}`;
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${hidden.id}, ${confinedId})`;
  });

  after(async () => {
    await client`DELETE FROM tickets WHERE order_id = ANY(${orderIds})`;
    await client`DELETE FROM order_trucks WHERE order_id = ANY(${orderIds})`;
    await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ${confinedId}`;
    await client`DELETE FROM pfi_notes WHERE pfi_id IN (${pfi.id}, ${hidden.id})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfi.id, hidden.id]));
    await closeDb();
  });

  // ── Notes ──────────────────────────────────────────────────────────────

  let noteId;

  test("a note is added with its kind, its day and its author", async () => {
    const res = await as(token).post(`${API}/${pfi.id}/notes`, {
      kind: "issue", body: "  Vessel berthed four days late.  ", occurredOn: "2026-08-02",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { note } = res.body.data;
    noteId = note.id;
    assert.equal(note.kind, "issue");
    assert.equal(note.body, "Vessel berthed four days late.", "trimmed");
    assert.equal(note.occurredOn, "2026-08-02", "a calendar day, not a timestamp");
    assert.equal(note.authorName, "Test Staff");
    assert.equal(note.edited, false);
  });

  test("without a day or a kind it is a plain note dated today", async () => {
    const res = await as(otherToken).post(`${API}/${pfi.id}/notes`, { body: "Discharge completed." });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.note.kind, "note");
    assert.match(res.body.data.note.occurredOn, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("the words are required and the kind is one of three", async () => {
    assert.equal((await as(token).post(`${API}/${pfi.id}/notes`, { body: "   " })).status, 400);
    assert.equal((await as(token).post(`${API}/${pfi.id}/notes`, { body: "x", kind: "rumour" })).status, 400);
  });

  test("the file lists them in the order things happened, newest first", async () => {
    const res = await as(token).get(`${API}/${pfi.id}/notes`);
    assert.equal(res.status, 200);
    const days = res.body.data.notes.map((n) => n.occurredOn);
    assert.deepEqual(days, [...days].sort().reverse());
    assert.equal(res.body.data.notes.length, 2);
  });

  test("somebody else's note cannot be changed or withdrawn by you", async () => {
    const edit = await as(otherToken).patch(`${API}/${pfi.id}/notes/${noteId}`, { body: "Rewritten" });
    assert.equal(edit.status, 403);
    const del = await as(otherToken).delete(`${API}/${pfi.id}/notes/${noteId}`);
    assert.equal(del.status, 403);
  });

  test("its author can correct it, and it then reads as edited", async () => {
    // Past the second's grace the "edited" flag allows for.
    await client`UPDATE pfi_notes SET created_at = created_at - interval '1 minute', updated_at = updated_at - interval '1 minute' WHERE id = ${noteId}`;
    const res = await as(token).patch(`${API}/${pfi.id}/notes/${noteId}`, {
      body: "Vessel berthed five days late.", kind: "decision",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.note.body, "Vessel berthed five days late.");
    assert.equal(res.body.data.note.kind, "decision");
    assert.equal(res.body.data.note.occurredOn, "2026-08-02", "the day is kept when not sent");
    assert.equal(res.body.data.note.edited, true);
  });

  test("a withdrawn note leaves the file but stays in the table", async () => {
    const res = await as(token).delete(`${API}/${pfi.id}/notes/${noteId}`);
    assert.equal(res.status, 200);
    const list = (await as(token).get(`${API}/${pfi.id}/notes`)).body.data.notes;
    assert.ok(!list.some((n) => n.id === noteId));
    const [row] = await client`SELECT deleted_at, deleted_by_name FROM pfi_notes WHERE id = ${noteId}`;
    assert.ok(row.deleted_at, "marked, not removed");
    assert.equal(row.deleted_by_name, "Test Staff");
    assert.equal((await as(token).delete(`${API}/${pfi.id}/notes/${noteId}`)).status, 404, "only once");
  });

  test("a note is found only under its own PFI", async () => {
    const [n] = await client`SELECT id FROM pfi_notes WHERE pfi_id = ${pfi.id} AND deleted_at IS NULL LIMIT 1`;
    const res = await as(token).patch(`${API}/${hidden.id}/notes/${n.id}`, { body: "Moved" });
    assert.equal(res.status, 404);
  });

  test("a PFI person reaches their own PFI's file and no other", async () => {
    assert.equal((await as(confinedToken).get(`${API}/${pfi.id}/notes`)).status, 404);
    assert.equal((await as(confinedToken).post(`${API}/${pfi.id}/notes`, { body: "x" })).status, 403);
    assert.equal((await as(confinedToken).get(`${API}/${pfi.id}/file`)).status, 404);
    const own = await as(confinedToken).post(`${API}/${hidden.id}/notes`, { body: "Mine to write" });
    assert.equal(own.status, 201, JSON.stringify(own.body));
  });

  // ── The file ───────────────────────────────────────────────────────────

  test("the file names who raised and who released the PFI", async () => {
    const res = await as(token).get(`${API}/${pfi.id}/file`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { people } = res.body.data;
    assert.equal(people.raisedByName, "Test Staff");
    assert.equal(people.activatedByName, "Ngozi Other");
    assert.equal(people.reviewNote, "Checked the BL");
  });

  test("the file carries the assigned account and where money actually landed", async () => {
    const { banks, collections } = (await as(token).get(`${API}/${pfi.id}/file`)).body.data;
    assert.equal(banks.length, 1);
    assert.equal(banks[0].bankName, "File Bank");
    assert.equal(banks[0].assignedAt, "2026-08-03T10:00:00.000Z");
    assert.equal(collections.length, 1);
    assert.equal(collections[0].amount, 85000000, "81m + 4m, statement rows only");
    assert.equal(collections[0].payments, 2);
  });

  test("every truck on every order, one to a row, with its ticket", async () => {
    const { trucks, orderTickets } = (await as(token).get(`${API}/${pfi.id}/file`)).body.data;
    const [paid, partPaid] = orderIds;
    const onPaid = trucks.filter((t) => t.orderId === paid);
    assert.deepEqual(onPaid.map((t) => t.truckNumber), ["ABC 123 XY", "KJA 456 ZZ"]);
    assert.equal(onPaid[0].ticketNumber, `TKT-FILE-${RUN}-1`);
    assert.equal(onPaid[0].driverName, "Musa");
    assert.ok(onPaid[0].exitedAt);
    assert.equal(onPaid[1].ticketNumber, null);
    assert.deepEqual(orderTickets[partPaid], [`TKT-FILE-${RUN}-2`], "a whole-order ticket");
  });

  test("activity is counted off the orders that exist", async () => {
    const { activity } = (await as(token).get(`${API}/${pfi.id}/file`)).body.data;
    assert.equal(activity.paidOrders, 1);
    assert.equal(activity.partPaidOrders, 1);
    assert.equal(activity.customers, 1);
    assert.equal(activity.salesValue, 90000000);
    assert.equal(activity.received, 85000000);
    assert.equal(activity.outstanding, 5000000);
    assert.equal(activity.trucks, 2);
    assert.equal(activity.trucksOut, 1);
    assert.equal(activity.statementPayments, 2);
  });

  test("the register answers for every PFI in scope, keyed by id", async () => {
    const res = await as(token).get(`${API}/register`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entry = res.body.data.register[pfi.id];
    assert.ok(entry, "the PFI is in the register");
    assert.equal(entry.people.activatedByName, "Ngozi Other");
    assert.equal(entry.banks[0].accountName, "Soroman File Account");
    assert.equal(entry.activity.paidOrders, 1);
    assert.equal(entry.notes.count, 1, "the withdrawn note is not counted");
    assert.equal(entry.notes.latest.body, "Discharge completed.");

    const confined = await as(confinedToken).get(`${API}/register`);
    assert.equal(confined.status, 200);
    assert.ok(!confined.body.data.register[pfi.id], "not a PFI this person can see");
    assert.equal(confined.body.data.register[hidden.id].notes.count, 1);
  });
});
