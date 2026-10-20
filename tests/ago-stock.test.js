// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken } = require("./helpers");

/**
 * The AGO stock ledger (0093): one book, one balance.
 *
 * What has to hold: the opening comes first and only once; the stock never
 * goes below nothing; a trip is given its AGO once, with top-ups and
 * retrievals on that entry; no more comes back off a truck than it was given;
 * and Delivery Costing reads a trip's AGO from the ledger, leaving the typed
 * figure untouched for when the ledger lets go of it.
 */
const API = "/api/ago-stock";
const RUN = Date.now();

let token;
let pfi;
let tripA;
let tripB;
let tripC;
let station;
let fleet;

const as = () => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${token}`).send(body),
  delete: (url) => request(app).delete(url).set("Authorization", `Bearer ${token}`),
});
const ledger = async () => (await as().get(API)).body.data;
const entryOf = async (pred) => (await ledger()).entries.find(pred);
const tripRow = async (id) => {
  const res = await as().get("/api/delivery-inventory?limit=1000");
  return res.body.data.inventory.find((r) => r.id === id);
};

/** The ledger is one book for the whole company, so each run starts it empty. */
const wipe = async () => {
  await client`DELETE FROM audit_logs WHERE entity_type = 'ago_stock_entry'`;
  // Top-ups and retrievals first: their AGO given is RESTRICT.
  await client`DELETE FROM ago_stock_entries WHERE issue_id IS NOT NULL`;
  await client`DELETE FROM ago_stock_entries`;
};

describe("AGO stock ledger", () => {
  before(async () => {
    token = await staffToken(request, app);
    await wipe();

    [pfi] = await client`
      INSERT INTO pfis (pfi_number, status, starting_qty_litres)
      VALUES (${`PFI/AGO/${RUN}`}, 'active', 150000) RETURNING id, pfi_number`;
    [fleet] = await client`
      INSERT INTO fleet_trucks (plate_number, max_capacity) VALUES (${`AGO${RUN % 100000}XX`}, 45000) RETURNING id, plate_number`;
    const trip = (plate, qty, ago) => client`
      INSERT INTO delivery_inventory (truck_number, pfi_id, pfi_number, quantity_allocated, ago_litres, ago_price, rate, product_price)
      VALUES (${plate}, ${pfi.id}, ${pfi.pfi_number}, ${qty}, ${ago}, 1850, 1400, 1300) RETURNING id`.then((r) => Number(r[0].id));
    tripA = await trip(`AGOA${RUN % 100000}`, 50000, 1150);
    tripB = await trip(`AGOB${RUN % 100000}`, 45000, 1100);
    tripC = await trip(`AGOC${RUN % 100000}`, 33000, 900);
    station = await trip("DANGOTE DELIVERY", 50000, null);
  });

  after(async () => {
    await wipe();
    await client`DELETE FROM delivery_inventory WHERE id = ANY(${[tripA, tripB, tripC, station]}::int[])`;
    await client`DELETE FROM fleet_trucks WHERE id = ${fleet.id}`;
    await client`DELETE FROM pfis WHERE id = ${pfi.id}`;
    await closeDb();
  });

  test("nothing can be given or received before the opening balance", async () => {
    const give = await as().post(`${API}/given`, { entryDate: "2026-03-02", trucks: [{ tripId: tripA, litres: 1200 }] });
    assert.equal(give.status, 409);
    assert.match(give.body.message, /opening balance first/);
    const recv = await as().post(`${API}/stock`, { kind: "received", entryDate: "2026-03-02", litres: 500 });
    assert.equal(recv.status, 409);
  });

  test("the opening balance is entered once", async () => {
    const res = await as().post(`${API}/stock`, { kind: "opening", entryDate: "2026-03-01", litres: 10000, description: "Tank dip" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const again = await as().post(`${API}/stock`, { kind: "opening", entryDate: "2026-03-01", litres: 5 });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already has its opening balance/);
  });

  test("nothing is dated before the opening, or after today", async () => {
    const early = await as().post(`${API}/stock`, { kind: "received", entryDate: "2026-02-28", litres: 100 });
    assert.equal(early.status, 409);
    assert.match(early.body.message, /dated before it/);
    const late = await as().post(`${API}/stock`, { kind: "received", entryDate: "2099-01-01", litres: 100 });
    assert.equal(late.status, 409);
    assert.match(late.body.message, /after today/);
  });

  test("AGO given to a batch at once, each truck its own entry, off the balance", async () => {
    const res = await as().post(`${API}/given`, {
      entryDate: "2026-03-02",
      description: "Calabar run",
      trucks: [{ tripId: tripA, litres: 1200 }, { tripId: tripB, litres: 1300, description: "Kano, farther" }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.trucks, 2);
    const { entries, balance } = await ledger();
    assert.equal(balance, 7500);
    const a = entries.find((e) => e.tripId === tripA);
    assert.equal(a.kind, "given");
    assert.equal(a.truckQty, 50000, "the truck's quantity is its load");
    assert.equal(a.pfiId, pfi.id);
    assert.equal(a.description, "Calabar run");
    assert.equal(entries.find((e) => e.tripId === tripB).description, "Kano, farther");
  });

  test("a trip is given its AGO once — more is a top-up", async () => {
    const res = await as().post(`${API}/given`, { entryDate: "2026-03-03", trucks: [{ tripId: tripA, litres: 50 }] });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /already given AGO.*top-up/);
    const twice = await as().post(`${API}/given`, { entryDate: "2026-03-03", trucks: [{ tripId: tripC, litres: 5 }, { tripId: tripC, litres: 5 }] });
    assert.equal(twice.status, 400);
  });

  test("no more can go out than is in stock", async () => {
    const res = await as().post(`${API}/given`, { entryDate: "2026-03-02", trucks: [{ tripId: tripC, litres: 8000 }] });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /only 7,500 L is in stock/);
    const count = await as().post(`${API}/stock`, { kind: "adjust_out", entryDate: "2026-03-02", litres: 7501 });
    assert.equal(count.status, 409);
    assert.equal((await ledger()).balance, 7500, "nothing recorded");
  });

  test("stock received the same day comes before what went out that day", async () => {
    const res = await as().post(`${API}/stock`, { kind: "received", entryDate: "2026-03-02", litres: 5000, description: "From NIPCO" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { entries } = await ledger();
    assert.deepEqual(entries.map((e) => [e.sn, e.kind, e.balanceAfter]), [
      [1, "opening", 10000],
      [2, "received", 15000],
      [3, "given", 13800],
      [4, "given", 12500],
    ]);
  });

  test("a top-up and a retrieval change their trip", async () => {
    const a = await entryOf((e) => e.tripId === tripA && e.kind === "given");
    const b = await entryOf((e) => e.tripId === tripB && e.kind === "given");
    const up = await as().post(`${API}/${a.id}/changes`, { kind: "top_up", entryDate: "2026-03-03", litres: 200, description: "Went on to Yola" });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const back = await as().post(`${API}/${b.id}/changes`, { kind: "retrieved", entryDate: "2026-03-04", litres: 300, description: "Diverted to Abuja" });
    assert.equal(back.status, 201, JSON.stringify(back.body));

    const { entries, balance } = await ledger();
    assert.equal(balance, 12600);
    const ga = entries.find((e) => e.id === a.id);
    assert.equal(ga.topUps, 200);
    assert.equal(ga.tripAgo, 1400);
    const gb = entries.find((e) => e.id === b.id);
    assert.equal(gb.retrieved, 300);
    assert.equal(gb.tripAgo, 1000);
    const top = entries.find((e) => e.kind === "top_up");
    assert.equal(top.tripId, tripA, "a top-up carries its trip");
    assert.equal(top.issueSn, ga.sn);
    assert.equal(top.change, -200);
    assert.equal(entries.find((e) => e.kind === "retrieved").change, 300);
  });

  test("no more comes back off a truck than it was given, nor before it was given", async () => {
    const b = await entryOf((e) => e.tripId === tripB && e.kind === "given");
    const res = await as().post(`${API}/${b.id}/changes`, { kind: "retrieved", entryDate: "2026-03-05", litres: 1001 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /more taken back than it was given/);
    const early = await as().post(`${API}/${b.id}/changes`, { kind: "top_up", entryDate: "2026-03-01", litres: 10 });
    assert.equal(early.status, 409);
    assert.match(early.body.message, /before the AGO it changes was given/);
  });

  test("Delivery Costing reads the trip's AGO from the ledger", async () => {
    const a = await tripRow(tripA);
    assert.equal(a.agoFromLedger, true);
    assert.equal(Number(a.agoLitres), 1400, "given 1,200 + top-up 200");
    assert.equal(a.agoValue, 1400 * 1850, "the costs are worked from the ledger's litres");
    const c = await tripRow(tripC);
    assert.equal(c.agoFromLedger, false);
    assert.equal(Number(c.agoLitres), 900, "a trip not on the ledger keeps what was typed");
  });

  test("a bulk cost pass leaves ledger litres alone and applies the rest", async () => {
    const res = await as().post("/api/delivery-inventory/costs", { ids: [tripA, tripC], agoLitres: 999, agoPrice: 1900 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.agoKept, 1);
    assert.match(res.body.message, /AGO Stock Ledger/);
    const a = await tripRow(tripA);
    assert.equal(Number(a.agoLitres), 1400);
    assert.equal(Number(a.agoPrice), 1900, "the price still applies");
    assert.equal(Number((await tripRow(tripC)).agoLitres), 999);
    const [typed] = await client`SELECT ago_litres FROM delivery_inventory WHERE id = ${tripA}`;
    assert.equal(Number(typed.ago_litres), 1150, "the typed figure is never overwritten");

    const only = await as().post("/api/delivery-inventory/costs", { ids: [tripA], agoLitres: 5 });
    assert.equal(only.status, 409);
    assert.match(only.body.message, /AGO Stock Ledger/);
  });

  test("editing a trip sends its ledger litres back unharmed, and refuses others", async () => {
    const same = await as().patch(`/api/delivery-inventory/${tripA}`, { agoLitres: "1400.00", notes: "checked" });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    const [typed] = await client`SELECT ago_litres, notes FROM delivery_inventory WHERE id = ${tripA}`;
    assert.equal(Number(typed.ago_litres), 1150);
    assert.equal(typed.notes, "checked");
    const other = await as().patch(`/api/delivery-inventory/${tripA}`, { agoLitres: "10" });
    assert.equal(other.status, 409);
  });

  test("a correction is checked against the whole book", async () => {
    const a = await entryOf((e) => e.tripId === tripA && e.kind === "given");
    const big = await as().patch(`${API}/${a.id}`, { litres: 20000 });
    assert.equal(big.status, 409);
    assert.match(big.body.message, /cannot go out/);
    const ok = await as().patch(`${API}/${a.id}`, { litres: 1250 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = await entryOf((e) => e.id === a.id);
    assert.equal(after.litres, 1250);
    assert.equal(after.description, "Calabar run", "a field left out stays as it was");
    assert.equal(after.tripAgo, 1450);
    const opening = await entryOf((e) => e.kind === "opening");
    const late = await as().patch(`${API}/${opening.id}`, { entryDate: "2026-03-03" });
    assert.equal(late.status, 409, "the opening cannot move after entries it holds up");
  });

  test("deletes keep the book whole", async () => {
    const opening = await entryOf((e) => e.kind === "opening");
    const o = await as().delete(`${API}/${opening.id}`);
    assert.equal(o.status, 409);
    const a = await entryOf((e) => e.tripId === tripA && e.kind === "given");
    const withChanges = await as().delete(`${API}/${a.id}`);
    assert.equal(withChanges.status, 409);
    assert.match(withChanges.body.message, /Delete those first/);

    const top = await entryOf((e) => e.kind === "top_up");
    assert.equal((await as().delete(`${API}/${top.id}`)).status, 200);
    assert.equal(Number((await tripRow(tripA)).agoLitres), 1250);

    // Trip B off the ledger entirely: its typed figure is back.
    const back = await entryOf((e) => e.kind === "retrieved");
    assert.equal((await as().delete(`${API}/${back.id}`)).status, 200);
    const b = await entryOf((e) => e.tripId === tripB && e.kind === "given");
    assert.equal((await as().delete(`${API}/${b.id}`)).status, 200);
    const row = await tripRow(tripB);
    assert.equal(row.agoFromLedger, false);
    assert.equal(Number(row.agoLitres), 1100);

    const [kept] = await client`SELECT deleted_at, deleted_by_name FROM ago_stock_entries WHERE id = ${b.id}`;
    assert.ok(kept.deleted_at, "a deleted entry is kept, marked");
  });

  test("a receipt that later AGO depends on cannot be deleted", async () => {
    // 10,000 + 5,000 − 1,250; giving 12,000 more leaves 1,750 only while the 5,000 stands.
    const give = await as().post(`${API}/given`, { entryDate: "2026-03-06", trucks: [{ tripId: tripB, litres: 12000 }] });
    assert.equal(give.status, 201, JSON.stringify(give.body));
    const recv = await entryOf((e) => e.kind === "received");
    const res = await as().delete(`${API}/${recv.id}`);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Record the stock received first/);
  });

  test("a truck on no PFI, linked to its trip later", async () => {
    const res = await as().post(`${API}/given`, {
      entryDate: "2026-03-06",
      trucks: [{ truckId: fleet.id, litres: 400, truckQty: 45000, description: "To the yard for repairs" }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const e = await entryOf((x) => x.truckId === fleet.id);
    assert.equal(e.truckNumber, fleet.plate_number);
    assert.equal(e.truckQty, 45000);
    assert.equal(e.tripId, null);

    const link = await as().patch(`${API}/${e.id}`, { tripId: tripC });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const linked = await entryOf((x) => x.id === e.id);
    assert.equal(linked.tripId, tripC);
    assert.equal(linked.truckQty, 33000, "the trip's load once it has a trip");
    assert.equal(Number((await tripRow(tripC)).agoLitres), 400);

    const taken = await as().patch(`${API}/${e.id}`, { tripId: tripB });
    assert.equal(taken.status, 409, "a trip already given its AGO cannot take a second");
  });

  test("the trucks to give to leave station loads out and show what each has had", async () => {
    const { trips } = (await as().get(`${API}/trips`)).body.data;
    assert.ok(!trips.some((t) => t.tripId === station), "a station load has no truck");
    const b = trips.find((t) => t.tripId === tripB);
    assert.equal(b.pfiId, pfi.id);
    assert.equal(b.truckQty, 45000);
    assert.ok(b.givenEntryId);
    assert.equal(b.givenLitres, 12000);
  });

  test("every write is on the activity log", async () => {
    const rows = await client`SELECT action FROM audit_logs WHERE entity_type = 'ago_stock_entry'`;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["ago_stock.opening", "ago_stock.received", "ago_stock.given", "ago_stock.top_up", "ago_stock.retrieved", "ago_stock.corrected", "ago_stock.deleted"]) {
      assert.ok(actions.has(a), `${a} logged`);
    }
  });
});
