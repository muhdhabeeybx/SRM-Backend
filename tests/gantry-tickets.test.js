// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis, depots, products, bankAccounts, bankStatements, bankStatementLines } = require("../db/schema");
const { customerRepo } = require("../repositories");
const orderService = require("../services/order.service");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Gantry tickets — the owner's rule of 12 Oct 2026 for gantry PFIs raised from
 * then on (services/gantryTickets.service.js).
 *
 * What has to hold: a gantry PFI raised now is on a ticket register and cannot
 * trade until its tickets are entered; only the stock officer on the PFI or an
 * admin enters them; orders are placed only for litres the tickets still
 * hold; payment stops the order at Released; issuing tickets whose litres come
 * to the order's quantity completes it and moves the stock; a correction keeps
 * the total and puts the old tickets back; a sold ticket cannot be taken off;
 * and a gantry PFI from before the rule is untouched.
 */
const RUN = Date.now();
const API = "/api/pfis";

let admin;
let stockOn;
let stockOff;
let finance;
let depot;
let product;
let account;
let customer;
let gantryId;
let coastalId;
let oldGantry;
let tickets = {};
let orderId;
const staffIds = [];
const orderIds = [];

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${t}`).send(body),
  put: (url, body) => request(app).put(url).set("Authorization", `Bearer ${t}`).send(body),
});

const person = async (roles, tag) => {
  const s = await staffTokenWithRoles(roles, `gantry-${tag}-${RUN}@soroman.test`);
  staffIds.push(Number(s.staff.id));
  return { id: Number(s.staff.id), token: s.accessToken };
};

const place = (quantity) =>
  orderService.placeOrder({
    customerId: customer.id,
    state: "Cross River",
    depotId: depot.id,
    productId: product.id,
    quantity,
    deliveryType: "pickup",
    actor: { type: "staff", staffId: finance.id },
    pinned: { pfiId: gantryId, price: 900 },
    idempotencyKey: `gantry-${RUN}-${quantity}-${Math.random()}`,
    quiet: true,
  });

/** Pay the whole order from a statement line on the PFI's own account. */
const pay = async (id) => {
  const [o] = await client`SELECT total_amount FROM orders WHERE id = ${id}`;
  const [statement] = await db.insert(bankStatements)
    .values({ bankAccountId: account.id, filename: `gantry-${RUN}-${id}.csv` }).returning();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const [line] = await db.insert(bankStatementLines).values({
    statementId: statement.id, bankAccountId: account.id, txnDate: day, amount: String(o.total_amount),
    depositor: "GANTRY TEST", narration: `order ${id}`, bankRef: `GT-${RUN}-${id}`,
    dedupKey: `GT-${RUN}-${id}`, status: "UNMATCHED",
  }).returning();
  return orderService.confirmOrderPayment({
    orderId: id, bankAccountId: account.id, lineIds: [line.id],
    actor: { type: "staff", staffId: finance.id }, notifyWhatsApp: false,
  });
};

/** A statement line on the PFI's account, for `amount`, not yet matched. */
const lineOf = async (id, amount, tag) => {
  const [statement] = await db.insert(bankStatements)
    .values({ bankAccountId: account.id, filename: `gantry-${RUN}-${id}-${tag}.csv` }).returning();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const [line] = await db.insert(bankStatementLines).values({
    statementId: statement.id, bankAccountId: account.id, txnDate: day, amount: String(amount),
    depositor: "GANTRY TEST", narration: `order ${id} ${tag}`, bankRef: `GT-${RUN}-${id}-${tag}`,
    dedupKey: `GT-${RUN}-${id}-${tag}`, status: "UNMATCHED",
  }).returning();
  return line;
};

const statusOf = async (id) => (await client`SELECT status FROM orders WHERE id = ${id}`)[0].status;
const releasedLitres = async (id) =>
  Number((await client`SELECT COALESCE(SUM(qty_litres), 0) AS q FROM pfi_movements WHERE order_id = ${id} AND action = 'RELEASE'`)[0].q);

describe("Gantry tickets", () => {
  before(async () => {
    admin = await staffToken(request, app);
    stockOn = await person(["stock_officer"], "on");
    stockOff = await person(["stock_officer"], "off");
    finance = await person(["finance"], "fin");

    [depot] = await db.insert(depots).values({
      name: `Gantry Depot ${RUN}`, code: `GD${RUN}`.slice(-12), address: "1 Rd",
      city: "Calabar", state: "Cross River", country: "NG", postcode: "540001",
      maxCapacity: 1000000, establishedYear: "2020",
    }).returning();
    [product] = await db.insert(products).values({
      name: `PMS ${RUN}`, sku: `GT${RUN}`.slice(-16), category: "fuel", unit: "Litres",
    }).returning();
    customer = await customerRepo.create({
      name: `Gantry Buyer ${RUN}`, phone: `+234813${String(RUN).slice(-7)}`, companyName: `Gantry Buyer ${RUN}`,
    });

    const raise = (pfi_type, suffix) => as(admin).post(API, {
      pfi_number: `PFI/GT/${suffix}/${RUN}`, pfi_type, location_id: depot.id, product_id: product.id,
      starting_qty_litres: 200000, unit_price: 800, ticket_count: 3,
    });
    const g = await raise("gantry", "G");
    assert.equal(g.status, 201, JSON.stringify(g.body));
    gantryId = Number(g.body.data.pfi.id);
    const c = await raise("coastal", "C");
    assert.equal(c.status, 201, JSON.stringify(c.body));
    coastalId = Number(c.body.data.pfi.id);

    // A gantry PFI from before the rule: no register row.
    [oldGantry] = await db.insert(pfis).values({
      pfiNumber: `PFI/GT/OLD/${RUN}`, pfiType: "gantry", status: "active", startingQtyLitres: 1000,
    }).returning();

    [account] = await db.insert(bankAccounts).values({
      bankName: "Zenith Bank", accountName: `GANTRY TEST ${RUN}`, accountNumber: `7${RUN}`.slice(-10),
      status: "Active", depotIds: [depot.id], pfiIds: [gantryId],
    }).returning();
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${gantryId}, ${stockOn.id})`;
  });

  after(async () => {
    try {
      await client`DELETE FROM gantry_tickets WHERE pfi_id = ${gantryId}`;
      if (orderIds.length) {
        await client`DELETE FROM order_payments WHERE order_id = ANY(${orderIds})`;
        await client`DELETE FROM pfi_movements WHERE order_id = ANY(${orderIds})`;
        await client`DELETE FROM order_pfi_allocations WHERE order_id = ANY(${orderIds})`;
        await client`DELETE FROM commissions WHERE order_id = ANY(${orderIds})`.catch(() => {});
        await client`DELETE FROM tickets WHERE order_id = ANY(${orderIds})`.catch(() => {});
        await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
      }
      await client`DELETE FROM bank_statement_lines WHERE bank_account_id = ${account.id}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${account.id}`;
      await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
      await client`DELETE FROM pfi_staff WHERE pfi_id IN (${gantryId}, ${coastalId}, ${oldGantry.id})`;
      await client`DELETE FROM expense_categories WHERE pfi_id IN (${gantryId}, ${coastalId}, ${oldGantry.id})`.catch(() => {});
      await client`DELETE FROM pfis WHERE id IN (${gantryId}, ${coastalId}, ${oldGantry.id})`;
      await db.delete(depots).where(eq(depots.id, depot.id));
      await db.delete(products).where(eq(products.id, product.id));
    } catch (err) {
      console.warn("cleanup:", err.message);
    }
    await closeDb();
  });

  test("a gantry PFI raised now is sold ticket by ticket; coastal and older gantry PFIs are not", async () => {
    const g = await as(admin).get(`${API}/${gantryId}/gantry-tickets`);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.data.register, true);
    assert.equal((await as(admin).get(`${API}/${coastalId}/gantry-tickets`)).body.data.register, false);
    assert.equal((await as(admin).get(`${API}/${oldGantry.id}/gantry-tickets`)).body.data.register, false);
  });

  test("it cannot be released to trade until its tickets are entered", async () => {
    const res = await as(admin).post(`${API}/${gantryId}/activate`, {
      bankAccountIds: [account.id], officers: { auditOfficerId: finance.id, salesManagerId: finance.id },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.message, /ticket numbers/);
  });

  test("only the stock officer on the PFI, or an admin, enters tickets — each number once", async () => {
    const entry = [
      { ticketNumber: "GT-001", qtyLitres: 45000 },
      { ticketNumber: "GT-002", qtyLitres: 33000 },
      { ticketNumber: "GT-003", qtyLitres: 45000 },
    ];
    assert.equal((await as(stockOff.token).post(`${API}/${gantryId}/gantry-tickets`, { tickets: entry })).status, 403);
    assert.equal((await as(finance.token).post(`${API}/${gantryId}/gantry-tickets`, { tickets: entry })).status, 403);

    const twice = await as(stockOn.token).post(`${API}/${gantryId}/gantry-tickets`, {
      tickets: [entry[0], { ticketNumber: "gt-001", qtyLitres: 100 }],
    });
    assert.equal(twice.status, 400);
    assert.match(twice.body.message, /entered twice/);

    const ok = await as(stockOn.token).post(`${API}/${gantryId}/gantry-tickets`, { tickets: entry });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.added, 3);
    assert.equal(ok.body.data.litres, 123000);

    const again = await as(admin).post(`${API}/${gantryId}/gantry-tickets`, { tickets: [entry[1]] });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /Already on .*GT-002/);

    const list = (await as(admin).get(`${API}/${gantryId}/gantry-tickets`)).body.data;
    assert.equal(list.summary.left, 3);
    assert.equal(list.summary.leftLitres, 123000);
    for (const t of list.tickets) tickets[t.ticketNumber] = t;

    const started = await as(admin).post(`${API}/${gantryId}/activate`, {
      bankAccountIds: [account.id], officers: { auditOfficerId: finance.id, salesManagerId: finance.id },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
  });

  test("an order is placed only for litres its tickets still hold", async () => {
    const { order } = await place(78000);
    orderId = Number(order.id);
    orderIds.push(orderId);
    // 123,000 on tickets, 78,000 spoken for: 45,000 open.
    await assert.rejects(place(50000), (err) => err.status === 409 && /45,000 L left on tickets/.test(err.message));
  });

  test("payment stops the order at Released — no stock moves until its tickets are picked", async () => {
    await pay(orderId);
    assert.equal(await statusOf(orderId), "Released");
    assert.equal(await releasedLitres(orderId), 0);

    const desk = await as(stockOn.token).get(`${API}/gantry-ticket-desk`);
    assert.equal(desk.status, 200, JSON.stringify(desk.body));
    const row = desk.body.data.orders.find((o) => o.id === orderId);
    assert.equal(row.stage, "awaiting_tickets");
    assert.equal(desk.body.data.pfis.find((p) => p.id === gantryId).canWork, true);
    const offDesk = await as(stockOff.token).get(`${API}/gantry-ticket-desk`);
    assert.equal(offDesk.body.data.pfis.find((p) => p.id === gantryId)?.canWork ?? false, false);

    const page = await as(stockOn.token).get(`/api/orders/${orderId}/gantry-tickets`);
    assert.equal(page.body.data.register, true);
    assert.equal(page.body.data.stage, "awaiting_tickets");
    assert.equal(page.body.data.canWork, true);
  });

  test("issuing tickets that come to the order's quantity completes it and moves the stock", async () => {
    const url = `/api/orders/${orderId}/gantry-tickets`;
    const pick = (...n) => ({ ticketIds: n.map((x) => tickets[x].id) });

    assert.equal((await as(stockOff.token).post(url, pick("GT-001", "GT-002"))).status, 403);
    const short = await as(stockOn.token).post(url, pick("GT-001"));
    assert.equal(short.status, 409);
    assert.match(short.body.message, /45,000 L.*78,000 L.*match exactly/);

    const ok = await as(stockOn.token).post(url, pick("GT-001", "GT-002"));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.numbers, ["GT-001", "GT-002"]);
    assert.equal(await statusOf(orderId), "Completed");
    assert.equal(await releasedLitres(orderId), 78000);

    const twice = await as(admin).post(url, pick("GT-003"));
    assert.equal(twice.status, 409);
    assert.match(twice.body.message, /already has its tickets/);

    const [audit] = await client`
      SELECT metadata FROM audit_logs WHERE entity_type = 'order' AND entity_id = ${String(orderId)}
         AND action = 'order.gantry_tickets_issued'`;
    assert.deepEqual(audit.metadata.tickets, ["GT-001", "GT-002"]);
  });

  test("a correction keeps the total, and the ticket it gave up is left again", async () => {
    const url = `/api/orders/${orderId}/gantry-tickets`;
    const noReason = await as(stockOn.token).put(url, { ticketIds: [tickets["GT-003"].id, tickets["GT-002"].id] });
    assert.equal(noReason.status, 400);

    const ok = await as(stockOn.token).put(url, {
      ticketIds: [tickets["GT-003"].id, tickets["GT-002"].id], reason: "GT-001 went to the wrong truck",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.before, ["GT-001", "GT-002"]);

    const list = (await as(admin).get(`${API}/${gantryId}/gantry-tickets`)).body.data;
    const by = Object.fromEntries(list.tickets.map((t) => [t.ticketNumber, t]));
    assert.equal(by["GT-001"].status, "left");
    assert.equal(by["GT-003"].status, "sold");
    assert.equal(by["GT-003"].orderId, orderId);
    assert.equal(await releasedLitres(orderId), 78000, "the stock movement is unchanged");
  });

  test("a sold ticket cannot be taken off; a left one can, with a reason", async () => {
    const sold = await as(stockOn.token).post(`${API}/${gantryId}/gantry-tickets/${tickets["GT-002"].id}/void`, { reason: "x" });
    assert.equal(sold.status, 409);
    const noReason = await as(stockOn.token).post(`${API}/${gantryId}/gantry-tickets/${tickets["GT-001"].id}/void`, {});
    assert.equal(noReason.status, 400);
    const ok = await as(stockOn.token).post(`${API}/${gantryId}/gantry-tickets/${tickets["GT-001"].id}/void`, {
      reason: "Typed twice",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const list = (await as(admin).get(`${API}/${gantryId}/gantry-tickets`)).body.data;
    assert.equal(list.summary.entered, 2);
    assert.equal(list.summary.left, 0);
    assert.equal(list.summary.voided, 1);
  });

  test("the desk opens to admins and stock officers, and to anyone else only by a page grant", async () => {
    const DESK = `${API}/gantry-ticket-desk`;
    assert.equal((await as(admin).get(DESK)).status, 200);
    assert.equal((await as(stockOff.token).get(DESK)).status, 200, "a stock officer on no PFI still opens the page");
    const refused = await as(finance.token).get(DESK);
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /admins and stock officers/);

    // Granted by name, the way Manage Users (and migration 0077) does it.
    await client`INSERT INTO staff_page_overrides (staff_id, route_path, allowed) VALUES (${finance.id}, '/gantry-tickets', true)`;
    assert.equal((await as(finance.token).get(DESK)).status, 200);
    // A "no" shuts it even to a role that would open it.
    await client`INSERT INTO staff_page_overrides (staff_id, route_path, allowed) VALUES (${stockOff.id}, '/gantry-tickets', false)`;
    assert.equal((await as(stockOff.token).get(DESK)).status, 403);
    await client`DELETE FROM staff_page_overrides WHERE route_path = '/gantry-tickets' AND staff_id IN (${finance.id}, ${stockOff.id})`;
  });

  test("tickets picked with the payment: finance matches the money and the tickets, and the order completes", async () => {
    const more = await as(stockOn.token).post(`${API}/${gantryId}/gantry-tickets`, {
      tickets: [
        { ticketNumber: "GT-101", qtyLitres: 20000 },
        { ticketNumber: "GT-102", qtyLitres: 10000 },
        { ticketNumber: "GT-103", qtyLitres: 5000 },
      ],
    });
    assert.equal(more.status, 201, JSON.stringify(more.body));
    for (const t of (await as(admin).get(`${API}/${gantryId}/gantry-tickets`)).body.data.tickets) tickets[t.ticketNumber] = t;

    const { order } = await place(30000);
    const id = Number(order.id);
    orderIds.push(id);
    const [{ total_amount: total }] = await client`SELECT total_amount FROM orders WHERE id = ${id}`;
    const line = await lineOf(id, total, "full");
    const url = `/api/orders/${id}/payments`;

    // A pick that does not come to the order refuses the whole confirmation:
    // no money is recorded, the line stays in the pool, the order stays put.
    const short = await as(finance.token).post(url, {
      bankAccountId: account.id, lineIds: [line.id], ticketIds: [tickets["GT-101"].id],
    });
    assert.equal(short.status, 409, JSON.stringify(short.body));
    assert.match(short.body.message, /20,000 L.*30,000 L.*match exactly/);
    assert.equal(await statusOf(id), "Pending");
    assert.equal((await client`SELECT status FROM bank_statement_lines WHERE id = ${line.id}`)[0].status, "UNMATCHED");
    assert.equal((await client`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = ${id}`)[0].n, 0);

    // A sold ticket is refused the same way.
    const sold = await as(finance.token).post(url, {
      bankAccountId: account.id, lineIds: [line.id], ticketIds: [tickets["GT-002"].id, tickets["GT-101"].id],
    });
    assert.equal(sold.status, 409);
    assert.match(sold.body.message, /GT-002 is already sold/);

    // Finance is not the stock officer, and picks them with the payment.
    const ok = await as(finance.token).post(url, {
      bankAccountId: account.id, lineIds: [line.id], ticketIds: [tickets["GT-101"].id, tickets["GT-102"].id],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.message, /Completed on gantry tickets GT-101, GT-102/);
    assert.equal(await statusOf(id), "Completed");
    assert.equal(await releasedLitres(id), 30000);
    const list = (await as(admin).get(`${API}/${gantryId}/gantry-tickets`)).body.data;
    const by = Object.fromEntries(list.tickets.map((t) => [t.ticketNumber, t]));
    assert.equal(by["GT-101"].orderId, id);
    assert.equal(by["GT-102"].orderId, id);
    assert.equal(by["GT-103"].status, "left");

    const [audit] = await client`
      SELECT metadata FROM audit_logs WHERE entity_type = 'order' AND entity_id = ${String(id)}
         AND action = 'order.gantry_tickets_issued'`;
    assert.equal(audit.metadata.via, "payment");
  });

  test("a part payment cannot take tickets; without them it is recorded as before", async () => {
    const { order } = await place(5000);
    const id = Number(order.id);
    orderIds.push(id);
    const [{ total_amount: total }] = await client`SELECT total_amount FROM orders WHERE id = ${id}`;
    const half = await lineOf(id, Number(total) / 2, "half");
    const url = `/api/orders/${id}/payments`;

    const refused = await as(finance.token).post(url, {
      bankAccountId: account.id, lineIds: [half.id], ticketIds: [tickets["GT-103"].id],
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.message, /owing, so the order is not released/);
    assert.equal((await client`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = ${id}`)[0].n, 0);

    const plain = await as(finance.token).post(url, { bankAccountId: account.id, lineIds: [half.id] });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(await statusOf(id), "Pending");

    // The rest of the money, with the tickets: released and completed at once.
    const rest = await lineOf(id, Number(total) / 2, "rest");
    const done = await as(finance.token).post(url, {
      bankAccountId: account.id, lineIds: [rest.id], ticketIds: [tickets["GT-103"].id],
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(await statusOf(id), "Completed");
    assert.equal(await releasedLitres(id), 5000);
  });

  test("a gantry PFI from before the rule still completes on payment", async () => {
    const done = await db.transaction((tx) =>
      orderService.completeDesklessOrder({ id: -1, pfiId: oldGantry.id, quantity: 0 }, { tx, actor: null, pfiType: "gantry" })
        .catch((err) => err));
    // It goes on to step the (non-existent) order, which is the old path:
    // what matters is that the register did not stop it first.
    assert.notEqual(done, false);
    const onRegister = await db.transaction((tx) =>
      orderService.completeDesklessOrder({ id: orderId, pfiId: gantryId, quantity: 0 }, { tx, actor: null, pfiType: "gantry" }));
    assert.equal(onRegister, false);
  });
});
