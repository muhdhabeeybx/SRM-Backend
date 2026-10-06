// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { db } = require("../config/db");
const { staff, notifications, notificationDeliveries: deliveries } = require("../db/schema");
const { eq, and, sql } = require("drizzle-orm");
const chain = require("../lib/expenseChain");
const { notifyExpenseStage } = require("../services/expenseNotifications.service");
const { closeDb } = require("./helpers");

const RUN = Date.now();

/**
 * notifyExpenseStage fires notify() without awaiting the dispatch (deliberately
 * — see the comment on notifyExpenseStage), and each recipient's own delivery
 * does two preference lookups before its inbox row lands, one recipient after
 * another — so the row count climbs over tens to a few hundred ms, not
 * instantly. Poll until every id the test cares about has shown up, rather
 * than an exact row count: this suite shares one local Postgres with every
 * other test file, so `finance`/`admin`/`expenditure_officer`-role staff from
 * unrelated fixtures can legitimately also be in the recipient list, and
 * asserting an exact set would make this test order-dependent.
 */
async function waitForRecipients(type, expenseId, mustInclude, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let ids = [];
  for (;;) {
    const rows = await db
      .select({ staffId: notifications.staffId })
      .from(notifications)
      .where(and(eq(notifications.type, type), sql`${notifications.data}->>'expenseId' = ${String(expenseId)}`));
    ids = rows.map((r) => r.staffId);
    const hasAll = mustInclude.every((id) => ids.includes(id));
    if (hasAll || Date.now() > deadline) return ids;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("expenseNotifications — the submitter hears about every stage, not just the ends", () => {
  let submitter;
  let officer;
  let cfo;
  let otherFinance;
  let admin;
  const savedCfo = process.env.EXPENSE_CFO_STAFF_IDS;
  const savedOfficer = process.env.EXPENSE_OFFICER_STAFF_IDS;
  const savedStationOfficer = process.env.EXPENSE_OFFICER_STATION_STAFF_IDS;
  let otherOfficer;
  let stationOfficer;

  before(async () => {
    const make = async (roles, tag) => {
      const [row] = await db
        .insert(staff)
        .values({
          firstName: "Notify",
          surname: tag,
          email: `notify-${tag.toLowerCase()}-${RUN}@soroman.test`,
          password: "TestPassw0rd!",
          isPasswordSet: true,
          roles,
          isActive: true,
        })
        .returning();
      return row;
    };

    // A submitter with no approval role of their own, distinct from every
    // stage's role-recipient, so "was the submitter included" is unambiguous.
    submitter = await make(["sales_manager"], "Submitter");
    officer = await make([chain.ROLE.OFFICER], "Officer");
    cfo = await make([chain.ROLE.CFO], "Cfo");
    // Holds the same role as the CFO, the way the whole finance team does.
    otherFinance = await make([chain.ROLE.CFO], "Finance");
    admin = await make([chain.ROLE.ADMIN], "Admin");
    // The CFO is named, not the role: only `cfo` is the CFO here.
    process.env.EXPENSE_CFO_STAFF_IDS = String(cfo.id);
    // Each expense has one named officer (lib/expenseOfficers.js); another
    // holder of the role is not it.
    otherOfficer = await make([chain.ROLE.OFFICER], "OtherOfficer");
    stationOfficer = await make(["truck_sales"], "StationOfficer");
    process.env.EXPENSE_OFFICER_STAFF_IDS = String(officer.id);
    process.env.EXPENSE_OFFICER_STATION_STAFF_IDS = String(stationOfficer.id);
  });

  /**
   * Take the fixture staff away again.
   *
   * They used to be left behind, and that quietly broke this file over time:
   * every run added four more staff, one of them holding the CFO role, so the
   * `verified` fan-out grew by one recipient per run — each costing two
   * preference lookups and an inbox insert. After a few dozen runs the local
   * test database held twenty finance-role staff and thirty thousand
   * notification rows, and the 3-second poll below started timing out. The
   * failure looked exactly like a broken notification path rather than what it
   * was, which is the expensive part.
   *
   * `notifications.staff_id` is ON DELETE CASCADE, so removing the staff takes
   * their inbox rows with them.
   */
  after(async () => {
    if (savedCfo === undefined) delete process.env.EXPENSE_CFO_STAFF_IDS;
    else process.env.EXPENSE_CFO_STAFF_IDS = savedCfo;
    if (savedOfficer === undefined) delete process.env.EXPENSE_OFFICER_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STAFF_IDS = savedOfficer;
    if (savedStationOfficer === undefined) delete process.env.EXPENSE_OFFICER_STATION_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STATION_STAFF_IDS = savedStationOfficer;
    await db.delete(staff).where(sql`${staff.email} LIKE ${`notify-%-${RUN}@soroman.test`}`);
    await closeDb();
  });

  let nextId = 1;
  const baseExpense = () => ({
    id: RUN + nextId++,
    added_by: submitter.id,
    recorded_by: submitter.id,
    category_id: null,
    amount: "50000.00",
    description: "Test expense",
    vendor: "",
    payee_account_name: "",
    payee_bank_name: "",
    payee_account_number: "",
  });

  test("verified: the named CFO is asked to approve; the rest of finance is not; the submitter is told where it is", async () => {
    const expense = baseExpense();
    await notifyExpenseStage({ expense, stage: chain.STATUS.VERIFIED, actorId: officer.id, actorName: "Officer" });

    const recipients = await waitForRecipients("expense.verified", expense.id, [cfo.id]);
    assert.ok(recipients.includes(cfo.id), "the CFO is asked for approval");
    assert.ok(!recipients.includes(otherFinance.id), "another finance-role holder is not told it awaits THEIR CFO approval");
    assert.ok(!recipients.includes(submitter.id), "the submitter does not get the approver's 'awaiting your approval'");
    assert.ok(!recipients.includes(officer.id), "the officer who just acted is not notified of their own action");

    const progress = await waitForRecipients("expense.progress", expense.id, [submitter.id]);
    assert.ok(progress.includes(submitter.id), "the submitter hears their expense was verified and is with the CFO");
    assert.ok(!progress.includes(cfo.id));
  });

  test("the CFO step falls back to the role when the named CFO is not an active member of staff", async () => {
    process.env.EXPENSE_CFO_STAFF_IDS = "999999999";
    try {
      const expense = baseExpense();
      await notifyExpenseStage({ expense, stage: chain.STATUS.VERIFIED, actorId: officer.id, actorName: "Officer" });
      const recipients = await waitForRecipients("expense.verified", expense.id, [cfo.id, otherFinance.id]);
      assert.ok(recipients.includes(cfo.id) && recipients.includes(otherFinance.id), "nobody named, so the role hears — never no one");
    } finally {
      process.env.EXPENSE_CFO_STAFF_IDS = String(cfo.id);
    }
  });

  test("audit_approved: admin role + the submitter, not the CFO who just approved it", async () => {
    const expense = baseExpense();
    await notifyExpenseStage({ expense, stage: chain.STATUS.AUDIT_APPROVED, actorId: cfo.id, actorName: "Cfo" });

    const recipients = await waitForRecipients("expense.audit_approved", expense.id, [admin.id]);
    assert.ok(recipients.includes(admin.id), "admin role recipient");
    assert.ok(!recipients.includes(submitter.id), "the submitter is not asked for final approval");
    assert.ok((await waitForRecipients("expense.progress", expense.id, [submitter.id])).includes(submitter.id));
    assert.ok(!recipients.includes(cfo.id), "the CFO who just acted is not notified of their own action");
  });

  test("admin_approved: the named officer + the submitter, not the admin who just gave final approval", async () => {
    const expense = baseExpense();
    await notifyExpenseStage({ expense, stage: chain.STATUS.ADMIN_APPROVED, actorId: admin.id, actorName: "Admin" });

    const recipients = await waitForRecipients("expense.admin_approved", expense.id, [officer.id]);
    assert.ok(recipients.includes(officer.id), "the named officer (they will make the payment)");
    assert.ok(!recipients.includes(otherOfficer.id), "another holder of the role is not this expense's officer");
    assert.ok(!recipients.includes(submitter.id), "the submitter is not told to pay it");
    assert.ok((await waitForRecipients("expense.progress", expense.id, [submitter.id])).includes(submitter.id));
    assert.ok(!recipients.includes(admin.id), "the admin who just acted is not notified of their own action");
  });

  test("a submitter who also holds the approving role is not double-notified, and is excluded when they are the actor", async () => {
    const expense = baseExpense();
    expense.added_by = cfo.id; // the CFO raised this one themselves

    // Someone else (the officer) verifies it — the CFO-submitter must appear
    // exactly once (as the role recipient), not twice, in their own entry.
    await notifyExpenseStage({ expense, stage: chain.STATUS.VERIFIED, actorId: officer.id, actorName: "Officer" });
    const recipients1 = await waitForRecipients("expense.verified", expense.id, [cfo.id]);
    assert.equal(recipients1.filter((id) => id === cfo.id).length, 1, "CFO appears once, not twice");

    // The CFO-submitter approves their own request — the admin role recipient
    // still hears about it (someone always needs to give final sign-off);
    // only the submitter-specific entry drops out, since here that's the actor.
    const expense2 = baseExpense();
    expense2.added_by = cfo.id;
    await notifyExpenseStage({ expense: expense2, stage: chain.STATUS.AUDIT_APPROVED, actorId: cfo.id, actorName: "Cfo" });
    const recipients2 = await waitForRecipients("expense.audit_approved", expense2.id, [admin.id]);
    assert.ok(recipients2.includes(admin.id), "the role recipient still fires");
    assert.ok(!recipients2.includes(cfo.id), "the actor-submitter is excluded, even as the role holder");
  });

  test("pending reaches the expense's named officer only; a station's goes to the station officer; paid still reaches every participant", async () => {
    const pendingExpense = baseExpense();
    await notifyExpenseStage({ expense: pendingExpense, stage: chain.STATUS.PENDING, actorId: submitter.id, actorName: "Submitter" });
    const pendingRecipients = await waitForRecipients("expense.pending", pendingExpense.id, [officer.id]);
    assert.ok(pendingRecipients.includes(officer.id));
    // Only the named officer verifies now (6 Oct 2026) — not the admins, not
    // another holder of the role.
    assert.ok(!pendingRecipients.includes(admin.id), "admins no longer verify");
    assert.ok(!pendingRecipients.includes(otherOfficer.id), "another holder of the role is not this expense's officer");
    assert.ok(!pendingRecipients.includes(submitter.id), "pending doesn't add the submitter — they are the one who just acted");

    const stationExpense = { ...baseExpense(), delivery_customer_id: 1 };
    await notifyExpenseStage({ expense: stationExpense, stage: chain.STATUS.PENDING, actorId: submitter.id, actorName: "Submitter" });
    const stationRecipients = await waitForRecipients("expense.pending", stationExpense.id, [stationOfficer.id]);
    assert.deepEqual(stationRecipients, [stationOfficer.id], "a station's expense is the station officer's, even without the role");

    const paidExpense = baseExpense();
    paidExpense.verified_by = officer.id;
    paidExpense.audit_approved_by = cfo.id;
    paidExpense.admin_approved_by = admin.id;
    paidExpense.paid_by = officer.id;
    await notifyExpenseStage({ expense: paidExpense, stage: chain.STATUS.PAID, actorId: officer.id, actorName: "Officer" });
    const paidRecipients = await waitForRecipients("expense.paid", paidExpense.id, [submitter.id, cfo.id, admin.id]);
    assert.ok(paidRecipients.includes(submitter.id));
    assert.ok(paidRecipients.includes(cfo.id));
    assert.ok(paidRecipients.includes(admin.id));
    assert.ok(!paidRecipients.includes(officer.id), "the officer who marked it paid is not notified of their own action");
  });

  /**
   * A text is for whoever has to act, and for whose request it is.
   *
   * Two rules in one, and they pull in opposite directions — which is why both
   * halves are asserted here. A stage that is somebody's turn must reach that
   * person's phone, because an unnoticed request is money that has stopped
   * moving. A stage that has merely happened must not.
   */
  const channelsByStaff = async (type, expenseId) => {
    const rows = await db
      .select({ staffId: deliveries.staffId, channel: deliveries.channel })
      .from(deliveries)
      .where(sql`${deliveries.notificationId} IN (
        SELECT id FROM notifications
         WHERE type = ${type}
           AND data->>'expenseId' = ${String(expenseId)}
      )`);
    return (id) => rows.filter((r) => Number(r.staffId) === Number(id)).map((r) => r.channel);
  };

  test("the approver whose turn it is gets a text", async () => {
    const expenseId = 900000 + (RUN % 1000);
    await notifyExpenseStage({
      expense: { id: expenseId, added_by: submitter.id, amount: "125000", description: `Channels ${RUN}` },
      stage: chain.STATUS.VERIFIED,
      actorId: officer.id,
      actorName: "Officer",
    });
    await waitForRecipients("expense.verified", expenseId, [cfo.id]);
    await waitForRecipients("expense.progress", expenseId, [submitter.id]);
    const channelsFor = await channelsByStaff("expense.verified", expenseId);
    const progressFor = await channelsByStaff("expense.progress", expenseId);

    // The CFO has to approve it — that is the whole point of the message.
    assert.ok(channelsFor(cfo.id).includes("sms"), "the CFO is waited on, so the CFO is texted");
    assert.ok(progressFor(submitter.id).includes("sms"), "and it is the submitter's own request");
  });

  test("an announcement does not buzz everyone who touched it", async () => {
    const expenseId = 910000 + (RUN % 1000);
    // Paid is terminal: nobody is waiting on anybody, so only the person whose
    // request it was is worth interrupting.
    await notifyExpenseStage({
      expense: {
        id: expenseId,
        added_by: submitter.id,
        verified_by: cfo.id,
        amount: "125000",
        description: `Paid ${RUN}`,
      },
      stage: chain.STATUS.PAID,
      actorId: admin.id,
      actorName: "Admin",
    });
    await waitForRecipients("expense.paid", expenseId, [submitter.id]);
    const channelsFor = await channelsByStaff("expense.paid", expenseId);

    assert.ok(channelsFor(submitter.id).includes("sms"), "the submitter's money moved");
    const others = channelsFor(cfo.id);
    if (others.length) {
      assert.ok(!others.includes("sms"), "a bystander on a finished request is not texted");
      assert.ok(others.includes("email"), "but is still told");
    }
  });
});
