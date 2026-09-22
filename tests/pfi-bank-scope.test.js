require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const scope = require("../lib/pfiBankScope");
const orderPaymentService = require("../services/orderPayment.service");
const { client } = require("../config/db");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");
const request = require("supertest");
const app = require("../app");

/**
 * A PFI collects into its own accounts, and a person confined to a PFI sees
 * that PFI's world and nothing else. Both enforced on the server — the screens
 * narrowing their dropdowns is a convenience; this is the rule.
 */
describe("assigning a PFI's collection accounts, from the PFI's side", () => {
  const RUN = Date.now();
  let pfi, other, a1, a2, inactive, token, scopedToken, scopedStaffId;
  let ready = false;

  const accountsOf = async (id) =>
    (await client`
      SELECT id FROM bank_accounts
       WHERE jsonb_typeof(pfi_ids) = 'array' AND pfi_ids @> ${JSON.stringify([id])}::jsonb
       ORDER BY id`).map((r) => Number(r.id));

  before(async () => {
    try {
      const mk = async (n) => {
        const [p] = await client`
          INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
          VALUES (${`ASSIGN/${n}/${RUN}`}, 'coastal', 'active', 1000, '300') RETURNING id`;
        return Number(p.id);
      };
      pfi = await mk("P");
      other = await mk("O");
      const acct = async (status, pfiIds) => {
        const [a] = await client`
          INSERT INTO bank_accounts (bank_name, account_name, account_number, status, pfi_ids)
          VALUES ('Assign Bank', ${"Assign " + RUN}, ${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")},
                  ${status}, ${JSON.stringify(pfiIds)}::jsonb)
          RETURNING id`;
        return Number(a.id);
      };
      // a1 already serves another PFI — that must survive every change here.
      a1 = await acct("Active", [other]);
      a2 = await acct("Active", []);
      inactive = await acct("Inactive", []);

      token = await staffToken(request, app);

      // A real, genuinely confined person: no "see all locations", one PFI.
      const scoped = await staffTokenWithRoles(["finance"], `scope-${RUN}@soroman.test`);
      scopedStaffId = Number(scoped.staff.id);
      scopedToken = scoped.accessToken;
      await client`UPDATE staff SET can_view_all_locations = false WHERE id = ${scopedStaffId}`;
      await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${other}, ${scopedStaffId})`;
      ready = true;
    } catch (e) {
      console.error("assignment fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (!ready) return;
    await client`DELETE FROM pfi_staff WHERE staff_id = ${scopedStaffId}`;
    await client`DELETE FROM audit_logs WHERE entity_type = 'pfi' AND entity_id = ANY(${[pfi, other]})`;
    await client`DELETE FROM bank_accounts WHERE id = ANY(${[a1, a2, inactive]})`;
    await client`DELETE FROM pfis WHERE id = ANY(${[pfi, other]})`;
  });

  const put = (ids, t = token) =>
    request(app).put(`/api/bank-accounts/for-pfi/${pfi}`)
      .set("Authorization", `Bearer ${t}`).send({ bankAccountIds: ids });

  test("the list sent is the whole answer", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await put([a1, a2]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(await accountsOf(pfi), [a1, a2].sort((x, y) => x - y));

    const one = await put([a2]);
    assert.equal(one.status, 200);
    assert.deepEqual(await accountsOf(pfi), [a2], "a1 no longer collects for it");
  });

  test("taking a PFI off an account never disturbs that account's other PFIs", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    assert.deepEqual(await accountsOf(other), [a1], "a1 still collects for the other PFI");
  });

  test("an empty list takes the PFI off every account", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await put([]);
    assert.equal(res.status, 200);
    assert.deepEqual(await accountsOf(pfi), []);
  });

  test("an inactive account cannot be assigned, and nothing is half-written", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    await put([a2]);
    const res = await put([a1, inactive]);
    assert.equal(res.status, 400);
    assert.deepEqual(await accountsOf(pfi), [a2], "refused as a whole — a1 was not added");
  });

  test("a person confined to a PFI cannot reassign where money lands", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await put([a1], scopedToken);
    assert.equal(res.status, 403);
  });

  test("and over HTTP they see their PFI's account and no other", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const res = await request(app).get("/api/bank-accounts")
      .set("Authorization", `Bearer ${scopedToken}`);
    assert.equal(res.status, 200);
    const ids = res.body.data.bankAccounts.map((b) => Number(b.id));
    assert.ok(ids.includes(a1), "their PFI's account");
    assert.ok(!ids.includes(a2), "not an account on another PFI");
    assert.ok(!ids.includes(inactive), "not an unassigned one");

    const hidden = await request(app).get(`/api/bank-accounts/${a2}`)
      .set("Authorization", `Bearer ${scopedToken}`);
    assert.equal(hidden.status, 404, "outside their PFI, it does not exist");
  });
});

describe("PFI bank scope", () => {
  const RUN = Date.now();
  let pfiA, pfiB, pfiBare, accountA, accountA2, accountB, orderA, orderBare, lineB;
  let ready = false;

  /** Somebody confined to PFI A, as verifyStaff hands them to a controller. */
  const confinedToA = () => ({
    id: 1, canViewAllLocations: false,
    scope: { depotIds: [], lpgStationIds: [], pfiIds: [pfiA] },
  });
  const everybody = { id: 1, canViewAllLocations: true, scope: { depotIds: [], lpgStationIds: [], pfiIds: [] } };

  const account = async (pfiIds) => {
    const [a] = await client`
      INSERT INTO bank_accounts (bank_name, account_name, account_number, status, pfi_ids)
      VALUES ('Scope Bank', ${"Scope " + RUN}, ${String(RUN).slice(-10)}, 'Active', ${JSON.stringify(pfiIds)}::jsonb)
      RETURNING id`;
    return Number(a.id);
  };

  before(async () => {
    try {
      const pfi = async (n) => {
        const [p] = await client`
          INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price)
          VALUES (${`SCOPE/${n}/${RUN}`}, 'coastal', 'active', 1000000, '300') RETURNING id`;
        return Number(p.id);
      };
      pfiA = await pfi("A");
      pfiB = await pfi("B");
      pfiBare = await pfi("BARE");

      accountA = await account([pfiA]);
      // Stored as a string: pfi_ids has held both, and must match either way.
      accountA2 = await account([String(pfiA)]);
      accountB = await account([pfiB]);

      const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
      const order = async (pfiId) => {
        const [o] = await client`
          INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                              price, total_amount, delivery_type, company_name, pfi_id)
          SELECT ${"SC" + Math.floor(Math.random() * 1e9)}, ${Number(c.id)}, 'Lagos', d.id, p.id, 1000,
                 1000, 1000000, 'pickup', 'Scope Test Co', ${pfiId}
            FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
          RETURNING id`;
        return Number(o.id);
      };
      orderA = await order(pfiA);
      orderBare = await order(pfiBare);

      // An unmatched credit on PFI B's account.
      const [st] = await client`
        INSERT INTO bank_statements (bank_account_id, filename) VALUES (${accountB}, 'scope.xlsx') RETURNING id`;
      const [l] = await client`
        INSERT INTO bank_statement_lines (statement_id, bank_account_id, txn_date, amount, depositor, narration, bank_ref, status, dedup_key)
        VALUES (${st.id}, ${accountB}, '2026-09-21', 1000000, 'Test', 'scope test', ${"SCOPE" + RUN}, 'UNMATCHED', ${"scope-" + RUN})
        RETURNING id`;
      lineB = Number(l.id);
      ready = true;
    } catch (e) {
      console.error("PFI bank scope fixtures unavailable:", e.message);
    }
  });

  after(async () => {
    if (ready) {
      await client`DELETE FROM bank_statement_lines WHERE id = ${lineB}`;
      await client`DELETE FROM bank_statements WHERE bank_account_id = ${accountB}`;
      await client`DELETE FROM order_payments WHERE order_id = ANY(${[orderA, orderBare]})`;
      await client`DELETE FROM orders WHERE id = ANY(${[orderA, orderBare]})`;
      await client`DELETE FROM bank_accounts WHERE id = ANY(${[accountA, accountA2, accountB]})`;
      await client`DELETE FROM pfis WHERE id = ANY(${[pfiA, pfiB, pfiBare]})`;
    }
    await closeDb();
  });

  test("somebody confined to a PFI sees that PFI's accounts and no others", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    const ids = await scope.allowedBankAccountIds(confinedToA());
    assert.ok(ids.includes(accountA));
    assert.ok(ids.includes(accountA2), "a pfi id stored as text still matches");
    assert.ok(!ids.includes(accountB), "PFI B's account is not theirs");
  });

  test("somebody not confined is not narrowed at all", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    assert.equal(await scope.allowedBankAccountIds(everybody), null);
    // Unassigned staff are untouched too — the same rule scopeFilter.js keeps.
    assert.equal(
      await scope.allowedBankAccountIds({ canViewAllLocations: false, scope: { pfiIds: [] } }),
      null,
    );
  });

  test("an account outside their PFI is refused", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    await assert.rejects(() => scope.assertAccountAllowed(confinedToA(), accountB), (e) => e.status === 403);
    await scope.assertAccountAllowed(confinedToA(), accountA);
  });

  test("an order outside their PFI is refused", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    assert.throws(() => scope.assertOrderInScope(confinedToA(), { pfiId: pfiB }), (e) => e.status === 403);
    assert.throws(() => scope.assertOrderInScope(confinedToA(), { pfiId: null }), (e) => e.status === 403);
    scope.assertOrderInScope(confinedToA(), { pfiId: pfiA });
    scope.assertOrderInScope(everybody, { pfiId: pfiB });
  });

  test("a PFI's order may only be paid through that PFI's own accounts — for anybody", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    await assert.rejects(
      () => scope.assertAccountServesOrder({ pfiId: pfiA }, accountB),
      (e) => e.status === 409 && /collects into/.test(e.message),
    );
    await scope.assertAccountServesOrder({ pfiId: pfiA }, accountA);
    await scope.assertAccountServesOrder({ pfiId: pfiA }, accountA2);
  });

  /**
   * The two cases look alike and are not: an order with no PFI has no cargo to
   * be held to, while a PFI with no account is a cargo somebody has not
   * finished setting up. The second used to accept any account in the company,
   * which is failing open on exactly the PFIs least ready to take money.
   */
  test("a PFI with no account refuses outright, and says what to fix", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    await assert.rejects(
      () => scope.assertAccountServesOrder({ pfiId: pfiBare }, accountB),
      (e) => e.status === 409 && /No bank account is assigned/.test(e.message),
    );
  });

  test("an order with no PFI is not held to one", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    await scope.assertAccountServesOrder({ pfiId: null }, accountB);
  });

  test("the payment path refuses another PFI's statement line, and claims nothing", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    /*
     * End to end through the one place every statement line becomes a
     * payment. Even an unrestricted person cannot record PFI B's money
     * against PFI A's order, and the line must still be free afterwards —
     * a refused claim that left the line MATCHED would lose the credit.
     */
    await assert.rejects(
      () => orderPaymentService.recordFromStatementLines(
        { orderId: orderA, bankAccountId: accountB, lineIds: [lineB], scopeUser: everybody },
      ),
      (e) => e.status === 409,
    );
    const [line] = await client`SELECT status FROM bank_statement_lines WHERE id = ${lineB}`;
    assert.equal(line.status, "UNMATCHED", "the credit is still there to be matched properly");
    const [{ n }] = await client`SELECT count(*)::int AS n FROM order_payments WHERE order_id = ${orderA}`;
    assert.equal(n, 0);
  });

  test("a confined person cannot claim a line off an account that is not theirs", async (t) => {
    if (!ready) return t.skip("fixtures unavailable");
    await assert.rejects(
      () => orderPaymentService.recordFromStatementLines(
        { orderId: orderBare, bankAccountId: accountB, lineIds: [lineB], scopeUser: confinedToA() },
      ),
      (e) => e.status === 403,
    );
  });
});
