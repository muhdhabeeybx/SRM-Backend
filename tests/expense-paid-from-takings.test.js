require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * An expense a station or plant paid out of its own sales cash — migration
 * 0092. It is raised in Expenses and walks the usual approvals; the station
 * pages take it off what the station has to bank. Here: the flag is stored,
 * it needs exactly one station or plant, and it is raised by the people named
 * for the station's sales and expenses (lib/stationEntry) or an admin.
 */
const RUN = `TK${Date.now()}`.slice(-10);
const EXPENSES = "/api/expenses";

describe("an expense paid from a station's takings", () => {
  let admin;
  const people = {};
  let station;
  let station2;
  let plantCustomer;
  let lpgStation;
  let categoryId;
  const created = [];

  const mkPerson = async (key, roles, first) => {
    const p = await staffTokenWithRoles(roles, `takings-${key}-${RUN}@soroman.test`);
    await client`UPDATE staff SET first_name = ${first}, surname = ${RUN} WHERE id = ${p.staff.id}`;
    people[key] = { id: Number(p.staff.id), token: p.accessToken };
  };

  before(async () => {
    admin = await staffToken(request, app);
    await mkPerson("sales", ["truck_sales"], "Sally");
    await mkPerson("deposits", ["finance"], "Dayo");

    const [s, s2] = await client`
      INSERT INTO delivery_customers (customer_type, name, phone_number)
      VALUES ('filling_station', ${`${RUN} Station`}, '0800000011'),
             ('filling_station', ${`${RUN} Station B`}, '0800000012')
      RETURNING id`;
    station = Number(s.id);
    station2 = Number(s2.id);

    const [lpg] = await client`SELECT id FROM lpg_stations ORDER BY id LIMIT 1`;
    lpgStation = lpg ? Number(lpg.id) : null;
    if (lpgStation) {
      const taken = await client`SELECT id FROM delivery_customers WHERE customer_type = 'lpg_plant' AND lpg_station_id = ${lpgStation}`;
      if (taken.length) plantCustomer = Number(taken[0].id);
      else {
        const [pc] = await client`
          INSERT INTO delivery_customers (customer_type, name, phone_number, lpg_station_id)
          VALUES ('lpg_plant', ${`${RUN} Plant`}, '0800000013', ${lpgStation})
          RETURNING id`;
        plantCustomer = Number(pc.id);
        created.push({ customer: plantCustomer });
      }
    }

    const [cat] = await client`
      SELECT id FROM expense_categories
       WHERE gl_group = 'general' AND is_active IS NOT FALSE ORDER BY id LIMIT 1`;
    categoryId = cat ? Number(cat.id) : null;

    // Sally enters the station's sales and expenses; Dayo its deposits.
    await client`
      INSERT INTO station_entry_staff (delivery_customer_id, pfi_id, entry_kind, staff_id)
      VALUES (${station}, NULL, 'sales', ${people.sales.id}),
             (${station}, NULL, 'deposits', ${people.deposits.id})`;
  });

  after(async () => {
    const ids = created.filter((c) => c.expense).map((c) => c.expense);
    if (ids.length) {
      await client`DELETE FROM pfi_expense_audits WHERE expense_id = ANY(${ids}::int[])`;
      await client`DELETE FROM pfi_expenses WHERE id = ANY(${ids}::int[])`;
    }
    await client`DELETE FROM station_entry_staff WHERE delivery_customer_id = ANY(${[station, station2]}::int[])`;
    const customers = [station, station2, ...created.filter((c) => c.customer).map((c) => c.customer)];
    await client`DELETE FROM delivery_customers WHERE id = ANY(${customers}::int[])`;
    await closeDb();
  });

  const raise = async (token, body) => {
    const res = await request(app)
      .post(EXPENSES)
      .set("Authorization", `Bearer ${token}`)
      .send({ category_id: categoryId, amount: 20000, description: `Diesel ${RUN}`, ...body });
    for (const e of res.body?.data?.expenses || []) created.push({ expense: Number(e.id) });
    return res;
  };
  const flagOf = async (id) => (await client`SELECT paid_from_takings, status FROM pfi_expenses WHERE id = ${id}`)[0];

  test("the station's sales person raises it, flagged, at the start of the chain", async (t) => {
    if (!categoryId) return t.skip("no general expense category here");
    const res = await raise(people.sales.token, { station_id: station, paid_from_takings: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await flagOf(res.body.data.expense.id);
    assert.equal(row.paid_from_takings, true);
    assert.equal(row.status, "pending");
  });

  test("the deposits person may not — spending the takings is the sales desk's", async (t) => {
    if (!categoryId) return t.skip("no general expense category here");
    const res = await raise(people.deposits.token, { station_id: station, paid_from_takings: true });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /raised by Sally/);
  });

  test("an admin may, to correct", async (t) => {
    if (!categoryId) return t.skip("no general expense category here");
    const res = await raise(admin, { station_id: station, paid_from_takings: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test("anyone may raise an ordinary expense for the station — only takings are the sales desk's", async (t) => {
    if (!categoryId) return t.skip("no general expense category here");
    const res = await raise(people.deposits.token, { station_id: station });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await flagOf(res.body.data.expense.id)).paid_from_takings, false);
  });

  test("it needs exactly one station or plant", async (t) => {
    if (!categoryId) return t.skip("no general expense category here");
    const none = await raise(admin, { paid_from_takings: true });
    assert.equal(none.status, 400);
    const two = await raise(admin, { station_ids: [station, station2], paid_from_takings: true });
    assert.equal(two.status, 400);
  });

  test("a plant's takings expense is raised against the plant", async (t) => {
    if (!categoryId || !lpgStation) return t.skip("no plant here");
    const res = await raise(admin, { plant_id: lpgStation, paid_from_takings: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await flagOf(res.body.data.expense.id)).paid_from_takings, true);
  });

  test("an edit cannot unhook the station from a takings expense", async (t) => {
    if (!categoryId) return t.skip("no general expense category here");
    const res = await raise(admin, { station_id: station, paid_from_takings: true });
    const id = res.body.data.expense.id;
    const edit = await request(app)
      .patch(`${EXPENSES}/${id}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ station_id: "" });
    assert.equal(edit.status, 400, JSON.stringify(edit.body));
    const off = await request(app)
      .patch(`${EXPENSES}/${id}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ paid_from_takings: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await flagOf(id)).paid_from_takings, false);
  });
});
