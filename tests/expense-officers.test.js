// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const chain = require("../lib/expenseChain");
const { officerIdsFor, isStationExpense } = require("../lib/expenseOfficers");

/**
 * Each expense has one expenditure officer — the owner's rule of 6 Oct 2026.
 *
 * Station and LPG plant expenses are Ibrahim Adamu's (#86), every other one —
 * refunds included — Ismail Adamu's (#104). Only the named officer, or a super
 * admin, verifies and pays it; holding the role is not enough, and being
 * named is enough without it. The admin and CFO stages work as before.
 */
describe("one named expenditure officer per expense", () => {
  const saved = [process.env.EXPENSE_OFFICER_STAFF_IDS, process.env.EXPENSE_OFFICER_STATION_STAFF_IDS];
  before(() => {
    delete process.env.EXPENSE_OFFICER_STAFF_IDS;
    delete process.env.EXPENSE_OFFICER_STATION_STAFF_IDS;
  });
  after(() => {
    if (saved[0] === undefined) delete process.env.EXPENSE_OFFICER_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STAFF_IDS = saved[0];
    if (saved[1] === undefined) delete process.env.EXPENSE_OFFICER_STATION_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STATION_STAFF_IDS = saved[1];
  });

  const ibrahim = { id: 86, roles: ["finance", "ticketing"] };
  const ismail = { id: 104, roles: ["expenditure_officer"] };
  const otherOfficer = { id: 555, roles: ["expenditure_officer"] };
  const admin = { id: 87, roles: ["admin"] };
  const superAdmin = { id: 1, roles: ["super_admin"] };
  const cfo = { id: 85, roles: ["finance"] };

  const general = (status) => ({ status, addedBy: 9 });
  const station = (status) => ({ status, addedBy: 9, deliveryCustomerId: 31 });
  const plant = (status) => ({ status, addedBy: 9, lpgStationId: 4 });

  test("station and plant expenses are Ibrahim's, everything else Ismail's", () => {
    assert.deepEqual(officerIdsFor(station("pending")), [86]);
    assert.deepEqual(officerIdsFor(plant("pending")), [86]);
    assert.deepEqual(officerIdsFor(general("pending")), [104]);
    assert.equal(isStationExpense({ delivery_customer_id: 3 }), true, "the database's own spelling");
    assert.equal(isStationExpense({ delivery_customer_id: null, lpg_station_id: null }), false);
  });

  test("the named officer verifies and pays; another holder of the role cannot", () => {
    assert.equal(chain.checkTransition(general("pending"), "verify", ismail).ok, true);
    assert.equal(chain.checkTransition(general("admin_approved"), "mark_paid", ismail).ok, true);
    const refused = chain.checkTransition(general("pending"), "verify", otherOfficer);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.match(refused.message, /Only this expense's expenditure officer can verify it/);
    assert.equal(chain.checkTransition(station("pending"), "verify", ismail).ok, false, "a station expense is not Ismail's");
  });

  test("named is enough without the role: Ibrahim verifies and pays station and plant expenses", () => {
    assert.equal(chain.checkTransition(station("pending"), "verify", ibrahim).ok, true);
    assert.equal(chain.checkTransition(plant("admin_approved"), "mark_paid", ibrahim).ok, true);
    assert.equal(chain.checkTransition(general("pending"), "verify", ibrahim).ok, false);
  });

  test("admins no longer verify; super admins still may do anything", () => {
    assert.equal(chain.checkTransition(general("pending"), "verify", admin).ok, false);
    assert.equal(chain.checkTransition(general("pending"), "verify", superAdmin).ok, true);
    assert.equal(chain.checkTransition(station("admin_approved"), "mark_paid", superAdmin).ok, true);
  });

  test("the CFO and admin stages are untouched", () => {
    assert.equal(chain.checkTransition(general("verified"), "audit_approve", cfo).ok, true);
    assert.equal(chain.checkTransition(general("audit_approved"), "admin_approve", admin).ok, true);
    assert.equal(chain.checkTransition(general("audit_approved"), "reject", admin, "no").ok, true);
  });

  test("what the screen offers follows the same rule, and says why when it offers nothing", () => {
    assert.deepEqual(chain.availableActions(station("pending"), ibrahim).actions.sort(), ["reject", "request_changes", "verify"]);
    const other = chain.availableActions(station("pending"), otherOfficer);
    assert.deepEqual(other.actions, []);
    assert.match(other.reason, /Station and LPG plant expenses are verified and paid by their own expenditure officer/);
    assert.deepEqual(chain.availableActions(general("pending"), admin).actions.sort(), ["reject", "request_changes"]);
  });
});
