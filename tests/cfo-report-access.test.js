const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  maySeeCfoReport,
  requireCfoReportAccess,
  CFO_REPORT_ROUTE,
  CFO_REPORT_STAFF_IDS,
} = require("../middleware/cfoReportAccess");

/**
 * Who may reach the CFO report.
 *
 * Pure rules — no database. The gate reads only `req.user.pageOverrides`,
 * which authenticateStaff has already loaded fresh from the row, so the rule
 * is a function of its argument and tests as one.
 *
 * What these pin down is the part that is easy to "tidy" back into a bug: no
 * role opens this report, super_admin included, and a caller with no override
 * row is refused rather than falling through to a default.
 */

/** A caller carrying the page override the dashboard would have loaded. */
const withOverride = (allowed, over = {}) => ({
  id: 7,
  roles: ["finance"],
  pageOverrides: [{ routePath: CFO_REPORT_ROUTE, allowed }],
  ...over,
});

const runGate = (user) => {
  const req = { user };
  let status = null;
  let body = null;
  let nexted = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  requireCfoReportAccess(req, res, () => {
    nexted = true;
  });
  return { status, body, nexted };
};

describe("CFO report access — the rule", () => {
  test("an explicit grant admits", () => {
    assert.equal(maySeeCfoReport(withOverride(true)), true);
  });

  test("an explicit denial refuses", () => {
    assert.equal(maySeeCfoReport(withOverride(false)), false);
  });

  test("no override row refuses — absence is not a fallthrough", () => {
    // The whole point of the deny-by-default: somebody added to staff next
    // month is out until they are granted in, rather than in until somebody
    // notices. This is where /delivery-costing differs, deliberately.
    assert.equal(maySeeCfoReport({ id: 7, roles: ["finance"], pageOverrides: [] }), false);
    assert.equal(maySeeCfoReport({ id: 7, roles: ["finance"] }), false);
  });

  test("an override for some other page is not this page", () => {
    const user = {
      id: 7,
      roles: ["finance"],
      pageOverrides: [{ routePath: "/delivery-costing", allowed: true }],
    };
    assert.equal(maySeeCfoReport(user), false);
  });

  test("no role opens it, super_admin included", () => {
    // Four staff hold super_admin and only two of them were named, so a role
    // bypass would admit exactly the people the request excluded.
    for (const role of ["super_admin", "admin", "finance", "audit"]) {
      assert.equal(
        maySeeCfoReport({ id: 7, roles: [role], pageOverrides: [] }),
        false,
        `${role} must not open the report by role alone`
      );
    }
  });

  test("a denial beats super_admin", () => {
    const user = withOverride(false, { roles: ["super_admin"] });
    assert.equal(maySeeCfoReport(user), false);
  });

  test("an unauthenticated caller refuses rather than throwing", () => {
    assert.equal(maySeeCfoReport(null), false);
    assert.equal(maySeeCfoReport(undefined), false);
  });
});

describe("CFO report access — the middleware", () => {
  test("a granted caller passes through", () => {
    const { nexted, status } = runGate(withOverride(true));
    assert.equal(nexted, true);
    assert.equal(status, null);
  });

  test("everyone else gets 403 and is told who to ask", () => {
    const { nexted, status, body } = runGate(withOverride(false));
    assert.equal(nexted, false);
    assert.equal(status, 403);
    assert.equal(body.success, false);
    // A bare "Forbidden" on a page the sidebar offered you is the confusing
    // state this restriction is meant to end, so the message has to say what
    // was refused and what to do about it.
    assert.match(body.message, /CFO report/i);
    assert.match(body.message, /access/i);
  });

  test("a caller with no override at all gets 403, not a crash", () => {
    const { nexted, status } = runGate({ id: 7, roles: ["truck_sales"] });
    assert.equal(nexted, false);
    assert.equal(status, 403);
  });
});

describe("CFO report access — the allowlist", () => {
  test("the three named staff, and the route the dashboard matches on", () => {
    // Habeeb Suleiman, General Admin, Muideen Salami — the ids seeded by
    // db/migrations/0041_cfo_report_is_allowlisted.sql. Kept in step so a
    // change to one is a visible change to the other.
    assert.deepEqual(CFO_REPORT_STAFF_IDS, [1, 39, 85]);
    // The dashboard route, not the API mount. A mismatch here fails in the
    // worse direction — menu shows, API refuses — so it is pinned.
    assert.equal(CFO_REPORT_ROUTE, "/cfo-report");
  });
});
