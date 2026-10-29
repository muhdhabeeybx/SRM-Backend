// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const chain = require("../lib/expenseChain");
const { officerIdsFor } = require("../lib/expenseOfficers");

/**
 * Every expense has one expenditure officer — the owner's rule of 29 Oct 2026.
 *
 * Ismail Manu Adamu (#104) is the officer for all of them: filling station and
 * LPG plant expenses, refunds and everything else. From 6 Oct they had been
 * split, station and plant ones going to Ibrahim Adamu (#86). Only the named
 * officer, or a super admin, verifies and pays; holding the role is not
 * enough, and being named is enough without it. The admin and CFO stages
 * work as before.
 */
describe("one named expenditure officer for every expense", () => {
  const saved = process.env.EXPENSE_OFFICER_STAFF_IDS;
  before(() => {
    delete process.env.EXPENSE_OFFICER_STAFF_IDS;
  });
  after(() => {
    if (saved === undefined) delete process.env.EXPENSE_OFFICER_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STAFF_IDS = saved;
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

  test("station, plant and every other expense are Ismail's", () => {
    assert.deepEqual(officerIdsFor(station("pending")), [104]);
    assert.deepEqual(officerIdsFor(plant("pending")), [104]);
    assert.deepEqual(officerIdsFor(general("pending")), [104]);
  });

  test("the named officer verifies and pays; another holder of the role cannot", () => {
    assert.equal(chain.checkTransition(general("pending"), "verify", ismail).ok, true);
    assert.equal(chain.checkTransition(general("admin_approved"), "mark_paid", ismail).ok, true);
    const refused = chain.checkTransition(general("pending"), "verify", otherOfficer);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.match(refused.message, /Only this expense's expenditure officer can verify it/);
  });

  test("Ismail verifies and pays station and plant expenses; Ibrahim no longer does", () => {
    assert.equal(chain.checkTransition(station("pending"), "verify", ismail).ok, true);
    assert.equal(chain.checkTransition(plant("pending"), "verify", ismail).ok, true);
    assert.equal(chain.checkTransition(station("admin_approved"), "mark_paid", ismail).ok, true);
    assert.equal(chain.checkTransition(plant("admin_approved"), "mark_paid", ismail).ok, true);
    assert.equal(chain.checkTransition(station("pending"), "verify", ibrahim).ok, false);
    assert.equal(chain.checkTransition(plant("admin_approved"), "mark_paid", ibrahim).ok, false);
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
    assert.deepEqual(chain.availableActions(station("pending"), ismail).actions.sort(), ["reject", "request_changes", "verify"]);
    assert.ok(chain.availableActions(plant("admin_approved"), ismail).actions.includes("mark_paid"));
    // Ibrahim keeps what his finance role gives everyone in finance — reject
    // and send back — but not the officer's verify or pay.
    assert.deepEqual(chain.availableActions(station("pending"), ibrahim).actions.sort(), ["reject", "request_changes"]);
    assert.ok(!chain.availableActions(plant("admin_approved"), ibrahim).actions.includes("mark_paid"));
    const other = chain.availableActions(station("pending"), otherOfficer);
    assert.deepEqual(other.actions, []);
    assert.match(other.reason, /This expense is verified and paid by its expenditure officer/);
    assert.deepEqual(chain.availableActions(general("pending"), admin).actions.sort(), ["reject", "request_changes"]);
  });
});
