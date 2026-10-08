require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * The LPG plants' expenses tracker brought onto the books as paid —
 * services/expenseTracker.service.js. Real staff, the running API.
 */
describe("LPG plants expenses tracker upload", () => {
  const RUN = Date.now();
  const tag = String(RUN).slice(-6);
  const town = `zq${tag}`;
  const other = `zr${tag}`;
  let plant, otherPlant, boss, finance;
  let ready = false;

  const as = (token) => ({
    post: (body) => request(app).post("/api/expenses/tracker-upload").set("Authorization", `Bearer ${token}`).send(body),
  });
  const skip = (t) => { if (ready) return false; t.skip("fixtures unavailable"); return true; };
  const mine = () => client`
    SELECT e.*, c.gl_code FROM pfi_expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.payment_notes LIKE ${`%tracker%`} AND (e.description LIKE ${`%${tag}%`} OR e.vendor LIKE ${`%${tag}%`})
     ORDER BY e.id`;

  before(async () => {
    try {
      const station = async (place) => {
        const [s] = await client`
          INSERT INTO lpg_stations (name, code, address, city, state, country, postcode, lpg_capacity_kg, established_year)
          VALUES (${`Soroman ${place} LPG Plant`}, ${`T${place}`.slice(0, 20)}, 'Test', ${place}, 'Test', 'Nigeria', '000000', 1000, '2026')
          RETURNING id`;
        return s;
      };
      plant = await station(town);
      otherPlant = await station(other);
      boss = await staffToken(request, app); // a super admin
      ;({ accessToken: finance } = await staffTokenWithRoles(["finance"], `trk-fin-${RUN}@soroman.test`));
      ready = true;
    } catch (e) {
      console.error("tracker fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      const ids = (await mine()).map((e) => e.id);
      if (ids.length) {
        await client`DELETE FROM pfi_expense_audits WHERE expense_id = ANY(${ids})`;
        await client`DELETE FROM pfi_expenses WHERE id = ANY(${ids})`;
      }
      await client`DELETE FROM audit_logs WHERE action = 'expenses.tracker_uploaded' AND metadata::text LIKE ${`%${tag}%`}`;
      await client`DELETE FROM lpg_stations WHERE id = ANY(${[plant.id, otherPlant.id]})`;
    }
    await closeDb();
  });

  const sheet = () => [
    { line: 6, tab: "June Expenses", sn: "1", date: "2026-07-02", amount: 10000, receipt: "6334", vendor: `Abuhuraira ${tag}`, vendorBank: "Moniepoint", reason: `2 pieces of Kadio of Calculator ${tag}`, location: `Action Energy ${town}`, source: "Action Energy Damaturu", sourceBank: "Moniepoint" },
    { line: 7, tab: "June Expenses", sn: "16", date: "2026-07-15", amount: 17500, vendor: `A.A. Rano ${tag}`, vendorBank: "Moniepoint", reason: `Purchase of 10 liters of diesel ${tag}`, location: `Action Energy ${town}`, source: "Dahiru Salihu", sourceBank: "Opay" },
    { line: 8, tab: "June Expenses", sn: "17", date: "2026-07-18", amount: 175000, vendor: `JPS suites ${tag}`, vendorBank: "Cash", reason: `7 days hotel bill ${tag}`, location: "Abuja", source: "Dahiru Salihu", sourceBank: "Opay" },
    { line: 9, tab: "June Expenses", sn: "18", date: "2026-07-19", amount: 192500, vendor: "Dahiru Salihu", vendorBank: "Opay", reason: "Refund for Expenses Serial number 16 to 17", location: "Refer to SN 16 to 17", source: "Action Energy Jalingo", sourceBank: "Moniepoint" },
    { line: 10, tab: "June Expenses", sn: "19", date: "2026-07-14", amount: 4743000, vendor: `Okoge ${tag}`, vendorBank: "Access Bank", reason: `Purchase of 3,100 liters of diesel ${tag}`, location: "Refinery Lagos", source: "Shuaibu Aisha Manu", sourceBank: "Providus" },
    // The location is where the compressor came from; the reason names the plant.
    { line: 11, tab: "June Expenses", sn: "20", date: "2026-08-08", amount: 100000, vendor: `Haruna ${tag}`, vendorBank: "Moniepoint", reason: `Transportation of Compressor from Tirwun to ${other} LPG plant ${tag}`, location: `${town}-Tirwun`, source: "Action Energy Maiduguri", sourceBank: "Moniepoint" },
    // A copy on a second tab is not another payment.
    { line: 2, tab: "Sheet2", sn: "1", date: "2026-07-02", amount: 10000, receipt: "6334", vendor: `Abuhuraira ${tag}`, vendorBank: "Moniepoint", reason: `2 pieces of Kadio of Calculator ${tag}`, location: `Action Energy ${town}`, source: "Action Energy Damaturu", sourceBank: "Moniepoint" },
  ];

  test("only a super admin may bring paid expenses onto the books", async (t) => {
    if (skip(t)) return;
    const res = await as(finance).post({ rows: sheet(), dryRun: true });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  test("a preview places every row and writes nothing", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post({ rows: sheet(), dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body.data.results;
    assert.deepEqual(r.map((x) => [x.status, x.kind]), [
      ["new", "plant"], ["new", "plant"], ["new", "general"], ["skipped", "refund"],
      ["new", "truck"], ["new", "plant"], ["repeated in file", "plant"],
    ]);
    assert.equal(r[0].plant.id, Number(plant.id));
    assert.equal(r[5].plant.id, Number(otherPlant.id), "the plant the reason names, not the town it came from");
    assert.deepEqual(r.map((x) => x.account?.code ?? null), ["6110", "6080", "6020", null, "6440", "6050", "6110"]);
    assert.equal(r[1].refundedOn, "18");
    assert.equal(res.body.data.summary.amount, 10000 + 17500 + 175000 + 4743000 + 100000);
    assert.equal((await mine()).length, 0);
  });

  test("recording books each as paid, on its plant or on none, with its trail", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post({ rows: sheet() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.recorded, 5);
    const rows = await mine();
    assert.equal(rows.length, 5);
    const calc = rows.find((e) => e.gl_code === "6110");
    assert.equal(Number(calc.lpg_station_id), Number(plant.id));
    assert.equal(calc.status, "paid");
    assert.equal(Number(calc.amount_paid), 10000);
    assert.equal(calc.receipt_reference, "6334");
    assert.equal(calc.bank_paid_from, "Action Energy Damaturu · Moniepoint");
    assert.equal(calc.payee_bank_name, "Moniepoint");
    assert.equal(calc.pfi_id, null);
    const diesel = rows.find((e) => e.gl_code === "6080");
    assert.match(diesel.payment_notes, /refunded to them on S\/N 18/);
    const hotel = rows.find((e) => e.gl_code === "6020");
    assert.equal(hotel.lpg_station_id, null);
    assert.equal(hotel.payment_method, "cash");
    const truck = rows.find((e) => e.gl_code === "6440");
    assert.equal(truck.lpg_station_id, null);
    const audits = await client`SELECT action FROM pfi_expense_audits WHERE expense_id = ANY(${rows.map((e) => e.id)})`;
    assert.equal(audits.length, 5);
    assert.ok(audits.every((a) => a.action === "recorded_as_paid"));
  });

  test("the same file again records nothing, and says so", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post({ rows: sheet() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.recorded, 0);
    assert.equal(res.body.data.summary.alreadyRecorded, 5);
    assert.equal((await mine()).length, 5);
  });

  test("one row that cannot be placed stops the upload", async (t) => {
    if (skip(t)) return;
    const res = await as(boss).post({
      rows: [
        { line: 30, tab: "June Expenses", date: "2026-09-01", amount: 5000, vendor: `New ${tag}`, reason: `Thermal paper ${tag}`, location: `Action Energy ${town}` },
        { line: 31, tab: "June Expenses", date: "2026-09-01", amount: 5000, vendor: `Lost ${tag}`, reason: `Something ${tag}`, location: "Nowhere" },
        { line: 32, tab: "June Expenses", date: "not a day", amount: 0, vendor: `Bad ${tag}`, reason: "", location: `Action Energy ${town}` },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.recorded, 0);
    const [, lost, bad] = res.body.data.results;
    assert.match(lost.problems.join(" "), /not a plant/);
    assert.ok(bad.problems.some((p) => /Date/.test(p)));
    assert.ok(bad.problems.some((p) => /Amount/.test(p)));
    assert.equal((await mine()).length, 5);
  });
});
