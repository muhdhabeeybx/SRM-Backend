// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client, db } = require("../config/db");
const { depots } = require("../db/schema");
const { bankAccountRepo } = require("../repositories");
const { staffToken, closeDb } = require("./helpers");

/**
 * A bank account reaches a location two ways: through a PFI (its depot) or
 * directly (migration 0062). depot_ids — what orders, subaccounts and scope
 * read — is always the union, and neither half may wipe out the other.
 */
describe("assigning a bank account to a location directly", () => {
  const RUN = Date.now();
  let depotA, depotB, pfi, station, customer, account, token;
  let ready = false;

  const stored = async (id) => {
    const [r] = await client`
      SELECT pfi_ids, depot_ids, assigned_depot_ids FROM bank_accounts WHERE id = ${id}`;
    const ids = (v) => (v || []).map(Number).sort((x, y) => x - y);
    return { pfiIds: ids(r.pfi_ids), depotIds: ids(r.depot_ids), assigned: ids(r.assigned_depot_ids) };
  };
  const patch = (body) =>
    request(app).patch(`/api/bank-accounts/${account}`)
      .set("Authorization", `Bearer ${token}`).send(body);

  before(async () => {
    try {
      const mkDepot = async (tag) => {
        const [d] = await db.insert(depots).values({
          name: `Loc ${tag} ${RUN}`, code: `L${tag}${String(RUN).slice(-5)}`,
          address: "1 Rd", city: "Warri", state: "Delta", country: "NG", postcode: "300001",
          maxCapacity: 1000000, establishedYear: "2020",
        }).returning();
        return Number(d.id);
      };
      depotA = await mkDepot("A");
      depotB = await mkDepot("B");
      const [p] = await client`
        INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, location_id)
        VALUES (${`LOC/${RUN}`}, 'coastal', 'active', 1000, '300', ${depotA}) RETURNING id`;
      pfi = Number(p.id);
      const mkCustomer = async (type, name) => {
        const [c] = await client`
          INSERT INTO delivery_customers (customer_type, customer_code, name, phone_number, status)
          VALUES (${type}, ${`LOC${type[0]}${String(RUN).slice(-6)}`}, ${name}, ${`+23480${String(RUN).slice(-8)}`}, 'active')
          RETURNING id`;
        return Number(c.id);
      };
      station = await mkCustomer("filling_station", `Ningi ${RUN}`);
      customer = await mkCustomer("customer", `Not A Station ${RUN}`);
      token = await staffToken(request, app);
      ready = true;
    } catch (e) {
      console.error("location fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (!ready) return;
    if (account) await client`DELETE FROM bank_accounts WHERE id = ${account}`;
    await client`DELETE FROM audit_logs WHERE entity_type = 'pfi' AND entity_id = ${pfi}`;
    await client`DELETE FROM pfis WHERE id = ${pfi}`;
    await client`DELETE FROM delivery_customers WHERE id = ANY(${[station, customer]})`;
    await client`DELETE FROM depots WHERE id = ANY(${[depotA, depotB]})`;
    await closeDb();
  });

  test("created with a location and no PFI, it collects at that location", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await request(app).post("/api/bank-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        bankName: "Loc Bank", accountName: `Loc ${RUN}`,
        accountNumber: String(RUN).slice(-10), status: "Active",
        assignedDepotIds: [depotB],
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    account = Number(res.body.data?.bankAccount?.id ?? res.body.data?.id);
    assert.deepEqual(await stored(account), { pfiIds: [], depotIds: [depotB], assigned: [depotB] });

    const found = await bankAccountRepo.findAll({ depotId: depotB, status: "Active" });
    assert.ok(found.some((a) => Number(a.id) === account), "an order at that depot finds it");
  });

  test("adding a PFI keeps the location, and depot_ids is the union", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await patch({ pfiIds: [pfi] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await stored(account), {
      pfiIds: [pfi], depotIds: [depotA, depotB].sort((x, y) => x - y), assigned: [depotB],
    });
    assert.deepEqual(res.body.data.bankAccount.assignedDepotIds, [depotB]);
  });

  test("a depot both ways stays after the PFI is taken off", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    assert.equal((await patch({ assignedDepotIds: [depotA, depotB] })).status, 200);
    assert.equal((await patch({ pfiIds: [] })).status, 200);
    assert.deepEqual(await stored(account), {
      pfiIds: [], depotIds: [depotA, depotB].sort((x, y) => x - y), assigned: [depotA, depotB].sort((x, y) => x - y),
    });
  });

  test("assigning from the PFI's side never takes a hand-set location away", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    assert.equal((await patch({ assignedDepotIds: [depotB] })).status, 200);
    const on = await request(app).put(`/api/bank-accounts/for-pfi/${pfi}`)
      .set("Authorization", `Bearer ${token}`).send({ bankAccountIds: [account] });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual((await stored(account)).depotIds, [depotA, depotB].sort((x, y) => x - y));

    const off = await request(app).put(`/api/bank-accounts/for-pfi/${pfi}`)
      .set("Authorization", `Bearer ${token}`).send({ bankAccountIds: [] });
    assert.equal(off.status, 200);
    assert.deepEqual(await stored(account), { pfiIds: [], depotIds: [depotB], assigned: [depotB] });
  });

  test("a patch that touches neither leaves both alone, and depotIds cannot be forced", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    assert.equal((await patch({ notes: "renamed", depotIds: [depotA] })).status, 200);
    assert.deepEqual(await stored(account), { pfiIds: [], depotIds: [depotB], assigned: [depotB] });
  });

  test("a filling station is a location too, and only a filling station", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await patch({ fillingStationIds: [station, customer] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const a = res.body.data.bankAccount;
    assert.deepEqual(a.fillingStationIds, [station], "an ordinary customer is not a station");
    assert.equal(a.fillingStations[0].name, `Ningi ${RUN}`);
    assert.deepEqual((await stored(account)).depotIds, [depotB], "no depot comes of it");

    const kept = await patch({ notes: "again" });
    assert.deepEqual(kept.body.data.bankAccount.fillingStationIds, [station], "untouched by a patch without it");

    const cleared = await patch({ fillingStationIds: [] });
    assert.deepEqual(cleared.body.data.bankAccount.fillingStationIds, []);
  });
});
