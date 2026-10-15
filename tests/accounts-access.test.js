require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { maySeeAccounts } = require("../middleware/accountsAccess");
const { staffToken, staffTokenWithRoles, grantPage, closeDb } = require("./helpers");

/**
 * The books are the admins' for now (the owner's instruction of 15 Oct 2026):
 * finance and audit see them only once somebody grants them, and the server
 * refuses the same people the menu hides them from.
 */
describe("who may see the books", () => {
  after(closeDb);

  const grant = (routePath, allowed) => ({ routePath, allowed });

  test("admins may; finance and audit may not, unless granted", () => {
    assert.equal(maySeeAccounts({ roles: ["admin"] }), true);
    assert.equal(maySeeAccounts({ roles: ["super_admin"] }), true);
    assert.equal(maySeeAccounts({ roles: ["finance"] }), false);
    assert.equal(maySeeAccounts({ roles: ["audit", "finance_manager"] }), false);
    assert.equal(maySeeAccounts({ roles: ["finance"], pageOverrides: [grant("/accounts", true)] }), true);
    // A grant on one page of the books opens the API, which cannot tell them apart.
    assert.equal(maySeeAccounts({ roles: ["finance"], pageOverrides: [grant("/accounts/ledger", true)] }), true);
    assert.equal(maySeeAccounts(null), false);
  });

  test("a grant set to no shuts the books even to an admin", () => {
    assert.equal(maySeeAccounts({ roles: ["admin"], pageOverrides: [grant("/accounts", false)] }), false);
  });

  test("the API answers an admin, and refuses finance until granted", async () => {
    const admin = await staffToken(request, app);
    const ok = await request(app).get("/api/accounts/status").set("Authorization", `Bearer ${admin}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const finance = await staffTokenWithRoles(["finance"], "test-accounts-nogrant@soroman.test");
    await client`DELETE FROM staff_page_overrides WHERE staff_id = ${finance.staff.id}`;
    const refused = await request(app).get("/api/accounts/status").set("Authorization", `Bearer ${finance.accessToken}`);
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /admins/);

    await grantPage(finance.staff.id, "/accounts");
    try {
      const granted = await request(app).get("/api/accounts/status").set("Authorization", `Bearer ${finance.accessToken}`);
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
    } finally {
      await client`DELETE FROM staff_page_overrides WHERE staff_id = ${finance.staff.id}`;
    }
  });
});
