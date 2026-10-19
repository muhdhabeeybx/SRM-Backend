require("dotenv").config();

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { isViewOnlyPage, viewOnlyRefusal, isOwnAccount } = require("../middleware/viewOnlyPages");
const { staffToken, staffTokenWithRoles, closeDb } = require("./helpers");

/**
 * A page given to somebody to look at only (migration 0090): they may open it
 * and download from it, and nothing sent from it may add, edit or remove.
 */
describe("view-only pages", () => {
  after(closeDb);

  const row = (routePath, allowed, viewOnly) => ({ routePath, allowed, viewOnly });

  test("only an allowed, view-only grant on that exact page counts", () => {
    const user = { roles: ["finance"], pageOverrides: [row("/expenses", true, true), row("/vendors", true, false), row("/pfi", false, true)] };
    assert.equal(isViewOnlyPage(user, "/expenses"), true);
    assert.equal(isViewOnlyPage(user, "/vendors"), false);
    // A page they are not given is not "view only" — it is not theirs at all.
    assert.equal(isViewOnlyPage(user, "/pfi"), false);
    // Exact: a page under it is its own page, with its own answer.
    assert.equal(isViewOnlyPage(user, "/expenses/tax-report"), false);
    assert.equal(isViewOnlyPage(user, null), false);
  });

  test("a super admin is never view only", () => {
    assert.equal(isViewOnlyPage({ roles: ["super_admin"], pageOverrides: [row("/admin", true, true)] }, "/admin"), false);
  });

  test("reads and their own account go through; other writes do not", () => {
    const user = { roles: ["finance"], pageOverrides: [row("/expenses", true, true)] };
    const req = (method, originalUrl) => ({ method, originalUrl, user, headers: { "x-dashboard-page": "/expenses" } });
    assert.equal(viewOnlyRefusal(req("GET", "/api/expenses?page=2")), null);
    assert.equal(viewOnlyRefusal(req("PATCH", "/api/notifications/12/read")), null);
    assert.equal(viewOnlyRefusal(req("POST", "/api/admin/me/password")), null);
    assert.equal(viewOnlyRefusal(req("POST", "/api/expenses"))?.body.code, "VIEW_ONLY");
    assert.equal(viewOnlyRefusal(req("DELETE", "/api/orders/9"))?.body.code, "VIEW_ONLY");
    assert.equal(isOwnAccount("/api/notifications/broadcast"), false);
  });

  test("the API refuses a write from a view-only page and allows it from a full one", async () => {
    const finance = await staffTokenWithRoles(["finance"], "test-view-only@soroman.test");
    const auth = `Bearer ${finance.accessToken}`;
    await client`DELETE FROM staff_page_overrides WHERE staff_id = ${finance.staff.id}`;
    await client`
      INSERT INTO staff_page_overrides (staff_id, route_path, allowed, view_only)
      VALUES (${finance.staff.id}, '/vendors', TRUE, TRUE)`;
    try {
      const refused = await request(app).post("/api/vendors").set("Authorization", auth).set("X-Dashboard-Page", "/vendors").send({});
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "VIEW_ONLY");

      // Reading the same page is what view only is for.
      const read = await request(app).get("/api/vendors").set("Authorization", auth).set("X-Dashboard-Page", "/vendors");
      assert.equal(read.status, 200, JSON.stringify(read.body));

      // From a page that is fully theirs the same write reaches the route —
      // here it fails validation, which proves it got past the gate.
      const elsewhere = await request(app).post("/api/vendors").set("Authorization", auth).set("X-Dashboard-Page", "/expenses").send({});
      assert.notEqual(elsewhere.body.code, "VIEW_ONLY");
      assert.equal(elsewhere.status, 400, JSON.stringify(elsewhere.body));

      // Their own bell is theirs from any page.
      const bell = await request(app).post("/api/notifications/read-all").set("Authorization", auth).set("X-Dashboard-Page", "/vendors").send({});
      assert.notEqual(bell.body.code, "VIEW_ONLY");
    } finally {
      await client`DELETE FROM staff_page_overrides WHERE staff_id = ${finance.staff.id}`;
    }
  });

  test("Manage Users saves view only, and sign-in hands it to the dashboard", async () => {
    const admin = await staffToken(request, app);
    const person = await staffTokenWithRoles(["finance"], "test-view-only-saved@soroman.test");
    try {
      const saved = await request(app)
        .patch(`/api/admin/${person.staff.id}`)
        .set("Authorization", `Bearer ${admin}`)
        .send({ page_overrides: [{ route_path: "/expenses", allowed: true, view_only: true }, { route_path: "/pfi", allowed: false, view_only: true }] });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const read = await request(app).get(`/api/admin/${person.staff.id}`).set("Authorization", `Bearer ${admin}`);
      const overrides = read.body.data.admin.pageOverrides;
      assert.deepEqual(overrides.find((o) => o.routePath === "/expenses"), { routePath: "/expenses", allowed: true, viewOnly: true });
      // View only means nothing on a page they are not given, so it is not kept.
      assert.equal(overrides.find((o) => o.routePath === "/pfi").viewOnly, false);

      const login = await request(app).post("/api/auth/login").send({ email: "test-view-only-saved@soroman.test", password: "TestPassw0rd!" });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const mine = login.body.data.user.pageOverrides;
      assert.deepEqual(mine.find((o) => o.routePath === "/expenses"), { routePath: "/expenses", allowed: true, viewOnly: true });
    } finally {
      await client`DELETE FROM staff_page_overrides WHERE staff_id = ${person.staff.id}`;
    }
  });
});
