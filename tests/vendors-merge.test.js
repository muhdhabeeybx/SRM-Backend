require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const vendorRepo = require("../repositories/vendor.repository");
const vendorMerge = require("../services/vendorMerge.service");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * Vendors saved under several names, merged into one (services/vendorMerge, 0086).
 *
 *   found      names that read the same once the words every company carries
 *              are set aside, or one the start of the other, or a slip of the
 *              keyboard apart, are one group; different vendors are not
 *   suggested  kept: the one used most; named: the fullest form of its name,
 *              never a sentence
 *   merged     every expense, cargo and bank line moves to the vendor kept;
 *              its blanks are filled from the others; the others are names
 *              that find it — off every list, still found by name
 *   Finance's  only finance, audit or an admin may merge
 */
const RUN = String(Date.now()).slice(-6);
const N = (s) => `${s} ${RUN}`;

describe("merging vendors", () => {
  const v = {};
  const expenses = [];
  let pfiId;
  let token;

  const vendor = async (name, extra = {}) => Number((await client`
    INSERT INTO vendors (name, phone, bank_name, account_number) VALUES (${name}, ${extra.phone ?? ""}, ${extra.bank ?? ""}, ${extra.account ?? ""})
    RETURNING id`)[0].id);
  const expense = async (vendorId, amount) => {
    const [cat] = await client`SELECT id FROM expense_categories WHERE gl_group = 'general' AND NOT COALESCE(is_refund, false) ORDER BY gl_code LIMIT 1`;
    const [r] = await client`
      INSERT INTO pfi_expenses (category_id, vendor_id, amount, exchange_rate, description, status, expense_date, admin_approved_at, amount_paid, payment_date, paid_at)
      VALUES (${cat.id}, ${vendorId}, ${amount}, 1, ${`${RUN} merge`}, 'paid', '2026-10-02', '2026-10-02T10:00:00+01:00', ${amount},
              '2026-10-03T10:00:00+01:00', '2026-10-03T10:00:00+01:00')
      RETURNING id`;
    expenses.push(Number(r.id));
  };

  before(async () => {
    token = await staffToken(request, app);
    v.short = await vendor(`Zqkeonamex${RUN}`);
    v.full = await vendor(`ZQKEONAMEX${RUN} PETROLEUM NIG LTD`, { bank: "Zenith Bank", account: "1012345678" });
    v.slip = await vendor(`zqkeonamax${RUN}`, { phone: "08030000000" });
    v.sentence = await vendor(`Zqkeonamex${RUN} Pet Warri, IT Compliance, Ticketing and Dispatch Officer`);
    v.stranger = await vendor(N("Zqtetris Foods"));
    for (const [id, times] of [[v.short, 3], [v.full, 1], [v.slip, 1]]) for (let i = 0; i < times; i++) await expense(id, 1_000);
    [{ id: pfiId }] = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, supplier_vendor_id)
      VALUES (${`MERGE/${RUN}`}, 'coastal', 'active', 1000, 300, ${v.slip}) RETURNING id`;
  });

  after(async () => {
    const all = Object.values(v);
    await client`DELETE FROM audit_logs WHERE entity_type = 'vendor' AND entity_id = ANY(${all}::int[])`;
    await client`DELETE FROM pfi_expense_audits WHERE expense_id = ANY(${expenses}::int[])`;
    await client`DELETE FROM pfi_expenses WHERE id = ANY(${expenses}::int[])`;
    await client`DELETE FROM pfis WHERE id = ${pfiId}`;
    await client`UPDATE vendors SET merged_into_id = NULL WHERE id = ANY(${all}::int[])`;
    await client`DELETE FROM vendors WHERE id = ANY(${all}::int[])`;
    await closeDb();
  });

  test("names that are one vendor are found together; a stranger is not", async () => {
    assert.ok(vendorMerge.sameVendor("Tetris Energy", "Tetris Energy Ltd"));
    assert.ok(vendorMerge.sameVendor("REMITA CHECKOUT", "REMITA CHECOUT"));
    assert.ok(vendorMerge.sameVendor("Social Connect Ent.", "Social Connect Enterprise"));
    assert.ok(!vendorMerge.sameVendor("Tetris Energy", "Tetris Foods"));
    const groups = await vendorMerge.duplicates();
    const mine = groups.find((g) => g.members.some((m) => m.id === v.short));
    assert.deepEqual(mine.members.map((m) => m.id).sort(), [v.short, v.full, v.slip, v.sentence].sort());
    assert.ok(!groups.some((g) => g.members.some((m) => m.id === v.stranger)));
  });

  test("kept: the one used most; named: the fullest form of its name, never a sentence", async () => {
    const mine = (await vendorMerge.duplicates()).find((g) => g.members.some((m) => m.id === v.short));
    assert.equal(mine.keepId, v.short);
    assert.equal(mine.name, `ZQKEONAMEX${RUN} PETROLEUM NIG LTD`);
  });

  test("only finance, audit or an admin may merge", async () => {
    const weak = (await staffTokenWithRoles(["expenditure_officer"], "test-vendor-merge-weak@soroman.test")).accessToken;
    const res = await request(app).post("/api/vendors/merge").set("Authorization", `Bearer ${weak}`)
      .send({ keepId: v.short, mergeIds: [v.full] });
    assert.equal(res.status, 403);
  });

  test("merged: everything moves to the vendor kept, its blanks filled, the others names that find it", async () => {
    const finance = (await staffTokenWithRoles(["finance"], "test-vendor-merge-finance@soroman.test")).accessToken;
    const res = await request(app).post("/api/vendors/merge").set("Authorization", `Bearer ${finance}`)
      .send({ keepId: v.short, mergeIds: [v.full, v.slip, v.sentence], name: `ZQKEONAMEX${RUN}  PETROLEUM NIG LTD` });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [kept] = await client`SELECT * FROM vendors WHERE id = ${v.short}`;
    assert.equal(kept.name, `ZQKEONAMEX${RUN} PETROLEUM NIG LTD`, "the name kept, tidied");
    assert.equal(kept.bank_name, "Zenith Bank");
    assert.equal(kept.account_number, "1012345678");
    assert.equal(kept.phone, "08030000000");

    const [{ n }] = await client`SELECT COUNT(*)::int AS n FROM pfi_expenses WHERE id = ANY(${expenses}::int[]) AND vendor_id = ${v.short}`;
    assert.equal(n, 5, "every expense");
    const [pfi] = await client`SELECT supplier_vendor_id FROM pfis WHERE id = ${pfiId}`;
    assert.equal(Number(pfi.supplier_vendor_id), v.short, "the cargo's supplier");
    const [{ audits }] = await client`SELECT COUNT(*)::int AS audits FROM pfi_expense_audits WHERE expense_id = ANY(${expenses}::int[]) AND action = 'vendor_merged'`;
    assert.equal(audits, 2, "each expense that moved says so");

    const listed = await vendorRepo.findAll({ search: `keonam` });
    assert.deepEqual(listed.map((x) => Number(x.id)).filter((id) => Object.values(v).includes(id)), [v.short], "the others are off the list");
    assert.equal(Number((await vendorRepo.findByName(`zqkeonamax${RUN}`)).id), v.short, "an old name still finds it");

    const old = await request(app).get(`/api/vendors/${v.slip}`).set("Authorization", `Bearer ${token}`);
    assert.equal(Number(old.body.data.vendor.id), v.short, "an old link opens the vendor kept");
    assert.equal(Number(old.body.data.mergedFrom.id), v.slip);
  });

  test("a vendor already merged cannot be merged again", async () => {
    await assert.rejects(() => vendorMerge.merge({ keepId: v.stranger, mergeIds: [v.slip] }), (e) => e.status === 409);
  });
});
