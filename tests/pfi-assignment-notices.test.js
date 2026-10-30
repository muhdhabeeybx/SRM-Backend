// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { inArray } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { CATALOG } = require("../notifications/catalog");
const notices = require("../services/pfiAssignmentNotices.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * The text an officer gets when a PFI is put in their hands.
 *
 * What has to hold: Start selling tells every officer the PFI names, once
 * each, with every slot they hold and the PFI's account; an edit on a PFI
 * already selling tells only the person newly named, for the new slot; a PFI
 * not started tells nobody; and a suspended officer is never told.
 */
const RUN = Date.now();
const staffIds = [];
const pfiIds = [];
let accountId;

const person = async (tag) => {
  const s = await staffTokenWithRoles(["finance"], `assign-${tag}-${RUN}@soroman.test`);
  const id = Number(s.staff.id);
  staffIds.push(id);
  return id;
};

/** The bell rows the notice wrote for this PFI, polled because it is fire-and-forget. */
const toldOn = async (pfiId, { expect = 1, ms = 3000 } = {}) => {
  const until = Date.now() + ms;
  let rows = [];
  while (Date.now() < until) {
    rows = await client`
      SELECT staff_id, body FROM notifications
       WHERE type = 'staff.pfi_assigned' AND data->>'pfiId' = ${String(pfiId)}
       ORDER BY staff_id`;
    if (rows.length >= expect) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows.map((r) => ({ staffId: Number(r.staff_id), body: r.body }));
};

const sms = (d) => CATALOG["staff.pfi_assigned"].sms(d);

describe("PFI assignment texts", () => {
  let finance;
  let sales;
  let product;
  let away;

  before(async () => {
    finance = await person("finance");
    sales = await person("sales");
    product = await person("product");
    away = await person("away");
    await client`UPDATE staff SET suspended = true WHERE id = ${away}`;
  });

  after(async () => {
    await client`DELETE FROM notifications WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    if (accountId) await client`DELETE FROM bank_accounts WHERE id = ${accountId}`;
    if (pfiIds.length) await db.delete(pfis).where(inArray(pfis.id, pfiIds));
    await client`UPDATE staff SET is_active = false WHERE id = ANY(${staffIds})`;
    await closeDb();
  });

  test("the text names the PFI, every slot and the account", () => {
    const one = { bankName: "Access Bank", accountNumber: "1982276001", accountName: "SOROMAN REFINERY" };
    assert.equal(
      sms({ firstName: "Miracle", pfiNumber: "PFI 55/26", roles: ["Finance / Audit Officer"], accounts: [one] }),
      "Hello Miracle, PFI 55/26 has been assigned to you as Finance / Audit Officer. " +
        "Its account is Access Bank 1982276001, SOROMAN REFINERY.",
    );
    assert.equal(
      sms({ firstName: "Umar", pfiNumber: "PFI 55/26", roles: ["Sales Manager", "Product Manager"], accounts: [] }),
      "Hello Umar, PFI 55/26 has been assigned to you as Sales Manager and Product Manager.",
    );
    assert.match(
      sms({ pfiNumber: "PFI 55/26", roles: ["Sales Manager"], accounts: [one, { ...one, bankName: "FCMB", accountNumber: "1" }] }),
      /^PFI 55\/26 has been assigned to you as Sales Manager\. Its accounts are Access Bank 1982276001, SOROMAN REFINERY and FCMB 1, SOROMAN REFINERY\.$/,
    );
  });

  test("an edit counts only the slots somebody was newly put in", () => {
    const before = { auditOfficerId: finance, salesManagerId: sales };
    const after = { auditOfficerId: finance, salesManagerId: product, productOfficerId: sales };
    assert.deepEqual([...notices.slotsGained(before, after)], [
      [product, ["Sales Manager"]],
      [sales, ["Product Manager"]],
    ]);
  });

  test("Start selling tells each officer once, with every slot and the account; never the suspended", async () => {
    const [pfi] = await db
      .insert(pfis)
      .values({
        pfiNumber: `PFI/ASSIGN/${RUN}`,
        status: "active",
        startingQtyLitres: 1000,
        auditOfficerId: finance,
        salesManagerId: sales,
        productOfficerId: sales,
        commissionOfficerId: away,
      })
      .returning();
    pfiIds.push(pfi.id);
    const [account] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status, pfi_ids)
      VALUES ('Test Bank', 'SOROMAN TEST', ${String(RUN).slice(-10)}, 'Active', ${JSON.stringify([pfi.id])}::jsonb)
      RETURNING id`;
    accountId = Number(account.id);

    notices.pfiStarted(pfi);
    const told = await toldOn(pfi.id, { expect: 2 });
    assert.deepEqual(told.map((r) => r.staffId), [finance, sales].sort((a, b) => a - b));
    const salesText = told.find((r) => r.staffId === sales).body;
    assert.match(salesText, /as Sales Manager and Product Manager\./);
    assert.match(salesText, new RegExp(`Its account is Test Bank ${String(RUN).slice(-10)}, SOROMAN TEST\\.`));
  });

  test("an edit on a selling PFI tells only the newly named; a PFI not started tells nobody", async () => {
    const [live, waiting] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/ASSIGN/LIVE/${RUN}`, status: "active", startingQtyLitres: 1000, auditOfficerId: finance },
        { pfiNumber: `PFI/ASSIGN/WAIT/${RUN}`, status: "not_started", startingQtyLitres: 1000, auditOfficerId: finance },
      ])
      .returning();
    pfiIds.push(live.id, waiting.id);

    notices.officersChanged(live, { ...live, salesManagerId: product });
    notices.officersChanged(waiting, { ...waiting, salesManagerId: product });

    assert.deepEqual((await toldOn(live.id)).map((r) => r.staffId), [product]);
    assert.deepEqual(await toldOn(waiting.id, { expect: 1, ms: 800 }), []);
  });
});
