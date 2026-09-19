// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { eq, sql } = require("drizzle-orm");

const app = require("../app");
const { db } = require("../config/db");
const { pfis, pfiStaff, bankAccounts, deliveryInventory } = require("../db/schema");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * Raising a PFI and letting it trade are two acts by two people.
 *
 * The gate is the only thing standing between "somebody typed a cargo in" and
 * "that cargo can take money", so every claim it makes is asserted here rather
 * than assumed: that raising cannot activate, that activating refuses without
 * the two officers and an account, that approving is also what grants sight of
 * the batch, and that a trucking batch's trucks do not reach the inventory —
 * where they would start owing money — until somebody has signed it off.
 */
const API = "/api/pfis";
const RUN = Date.now();

let token;
let audit;
let finance;
let account;

const raise = (body) =>
  request(app).post(API).set("Authorization", `Bearer ${token}`).send(body);

describe("PFI review gate — raised, then reviewed, then trading", () => {
  before(async () => {
    token = await staffToken(request, app);
    audit = (await staffTokenWithRoles(["audit"], `gate-audit-${RUN}@soroman.test`)).staff;
    finance = (await staffTokenWithRoles(["finance"], `gate-finance-${RUN}@soroman.test`)).staff;
    [account] = await db
      .insert(bankAccounts)
      .values({
        bankName: "Zenith Bank",
        accountName: `GATE TEST ${RUN}`,
        accountNumber: `${RUN}`.slice(-10),
        pfiIds: [],
      })
      .returning();
  });

  after(async () => {
    await db.delete(bankAccounts).where(eq(bankAccounts.id, account.id));
    await closeDb();
  });

  test("a PFI cannot be raised straight into trading", async () => {
    const res = await raise({
      pfiNumber: `PFI/GATE/A/${RUN}`,
      pfiType: "coastal",
      startingQtyLitres: 1000,
      // Asking for active must not get it. The choice does not exist any more.
      status: "active",
    });
    assert.equal(res.status, 201);
    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/GATE/A/${RUN}`));
    assert.equal(row.status, "not_started", "a raised PFI must not be trading");
    assert.ok(row.raisedAt, "who and when it was raised is kept");
  });

  test("activation refuses without a bank account", async () => {
    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/GATE/A/${RUN}`));
    const res = await request(app)
      .post(`${API}/${row.id}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ officers: { auditOfficerId: audit.id, salesManagerId: finance.id } });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /bank account/i);
  });

  test("activation refuses without an audit officer and a finance officer", async () => {
    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/GATE/A/${RUN}`));
    const noAudit = await request(app)
      .post(`${API}/${row.id}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountIds: [account.id], officers: { salesManagerId: finance.id } });
    assert.equal(noAudit.status, 400);
    assert.match(noAudit.body.message, /audit/i);

    const noFinance = await request(app)
      .post(`${API}/${row.id}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountIds: [account.id], officers: { auditOfficerId: audit.id } });
    assert.equal(noFinance.status, 400);
    assert.match(noFinance.body.message, /finance/i);

    // Still not trading after two refusals.
    const [after] = await db.select().from(pfis).where(eq(pfis.id, row.id));
    assert.equal(after.status, "not_started");
  });

  test("approving assigns the bank, grants the officers sight of it, and records who", async () => {
    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/GATE/A/${RUN}`));
    const res = await request(app)
      .post(`${API}/${row.id}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        bankAccountIds: [account.id],
        officers: { auditOfficerId: audit.id, salesManagerId: finance.id },
        note: "papers checked",
      });
    assert.equal(res.status, 200);

    const [after] = await db.select().from(pfis).where(eq(pfis.id, row.id));
    assert.equal(after.status, "active");
    assert.ok(after.activatedBy, "an approval nobody is named on is not an approval");
    assert.ok(after.activatedAt);
    assert.equal(after.reviewNote, "papers checked");

    // Assignment IS access — pfi_staff is what the scope filter reads.
    const granted = await db.select().from(pfiStaff).where(eq(pfiStaff.pfiId, row.id));
    const ids = granted.map((g) => g.staffId);
    assert.ok(ids.includes(audit.id), "the audit officer can see the batch they answer for");
    assert.ok(ids.includes(finance.id), "so can the finance officer");

    const [acct] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, account.id));
    assert.ok(acct.pfiIds.map(Number).includes(Number(row.id)), "the account collects for it");
  });

  test("a trucking batch's trucks reach the inventory only when it is approved", async () => {
    const code = `TRK-${RUN}`;
    const res = await raise({
      pfiNumber: `PFI/GATE/T/${RUN}`,
      pfiType: "trucking",
      startingQtyLitres: 92300,
      batch: {
        code,
        depotName: "Calabar",
        productName: "PMS",
        dateAllocated: "2026-09-19",
        trucks: [
          { plateNumber: "BWR809XB", loadedQty: 45000 },
          { plateNumber: "KJA112XY", loadedQty: 47300 },
        ],
      },
    });
    assert.equal(res.status, 201);

    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/GATE/T/${RUN}`));
    assert.equal(row.pfiType, "trucking");
    assert.ok(row.pendingBatch, "the trucks are parked on the PFI");

    const before = await db
      .select()
      .from(deliveryInventory)
      .where(eq(deliveryInventory.allocationCode, code));
    assert.equal(before.length, 0, "nothing is owed against a batch nobody has approved");

    await request(app)
      .post(`${API}/${row.id}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        bankAccountIds: [account.id],
        officers: { auditOfficerId: audit.id, salesManagerId: finance.id },
      });

    const written = await db
      .select()
      .from(deliveryInventory)
      .where(eq(deliveryInventory.allocationCode, code));
    assert.equal(written.length, 2, "both trucks land on the inventory");
    assert.equal(
      written.reduce((sum, t) => sum + Number(t.quantityAllocated), 0),
      92300,
      "carrying what they actually loaded, not their capacity",
    );

    const [after] = await db.select().from(pfis).where(eq(pfis.id, row.id));
    assert.equal(after.pendingBatch, null, "the draft is spent, not left looking pending");

    await db.delete(deliveryInventory).where(eq(deliveryInventory.allocationCode, code));
  });

  test("an already-active PFI cannot be activated twice", async () => {
    const [row] = await db.select().from(pfis).where(eq(pfis.pfiNumber, `PFI/GATE/A/${RUN}`));
    const res = await request(app)
      .post(`${API}/${row.id}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        bankAccountIds: [account.id],
        officers: { auditOfficerId: audit.id, salesManagerId: finance.id },
      });
    assert.equal(res.status, 409);
  });
});
