// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { inArray } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { CATALOG } = require("../notifications/catalog");
const { choiceForType } = require("../notifications/staffChoices");
const { lagosToday } = require("../lib/zonedDay");
const workReminders = require("../services/workReminders.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Reminders of waiting work — the owner's rules of 6 Oct 2026.
 *
 * What has to hold: only the six reminders exist; each reaches the people who
 * hold the role AND are named on the PFI, and nobody else — work on a PFI with
 * nobody on that desk goes to no one; the daily report goes out at 20:00 and
 * 22:00 only, the no-orders alert at 18:00 only; a person switched off gets
 * nothing; a second round in the same hour texts nobody twice.
 *
 * The test database is shared and full of other suites' rows, so these assert
 * on this run's own PFIs and people, never on company-wide totals.
 */
const RUN = Date.now();
const SERIAL = 900 + (RUN % 90);
const LABEL = { A: `PFI ${SERIAL}`, B: `PFI ${SERIAL + 1}`, C: `PFI ${SERIAL + 2}`, T: `PFI ${SERIAL + 3}` };

/** A Lagos hour today, as an instant (Lagos is UTC+1 all year). */
const todayAt = (hour) => new Date(`${lagosToday()}T${String(hour - 1).padStart(2, "0")}:00:00Z`);

let pfiA;
let pfiB;
let pfiC;
let pfiT;
let financeOnA;
let financeOnB;
let financeNowhere;
let ticketingOnA;
let exitOnA;
let entryOnA;
let salesManagerOnA;
let truckSalesOnT;
let admin;
let officer;
let stationOfficer;
let cfo;
let raiser;
const orderIds = [];
const expenseIds = [];
const staffIds = [];

const person = async (roles, tag) => {
  const s = await staffTokenWithRoles(roles, `work-rem-${tag}-${RUN}@soroman.test`);
  const id = Number(s.staff.id);
  staffIds.push(id);
  return id;
};

/** An order on a PFI, placed `hoursAgo` hours ago. */
const order = async (pfi, hoursAgo, { status = "Pending", paymentStatus = "Unpaid", releasedHoursAgo = null } = {}) => {
  const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
  const released = releasedHoursAgo == null ? null : new Date(Date.now() - releasedHoursAgo * 3600 * 1000).toISOString();
  const [o] = await client`
    INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                        price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id,
                        created_at, released_at)
    SELECT ${"WREM" + Math.floor(Math.random() * 1e9)}, ${c.id}, 'Lagos', d.id, p.id, 100,
           1000, 100000, 0, 'pickup', ${status}, ${paymentStatus}, ${pfi.id},
           now() - (${hoursAgo} * interval '1 hour'), ${released}::timestamptz
      FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
    RETURNING id`;
  orderIds.push(Number(o.id));
  return Number(o.id);
};

/** The messages a round would send, for this run's people only. */
const round = (at, trigger = "schedule", ids = staffIds) =>
  workReminders.buildRound(at, { trigger, staffIds: ids }).then((r) => r.messages);

const of = (messages, staffId, kind) => messages.filter((m) => m.person.id === staffId && (!kind || m.kind === kind));

describe("Work reminders", () => {
  // On unless switched off; set here so a local .env cannot turn these tests off.
  const savedSwitch = process.env.WORK_REMINDERS_ENABLED;
  const savedCfo = process.env.EXPENSE_CFO_STAFF_IDS;
  const savedOfficers = [process.env.EXPENSE_OFFICER_STAFF_IDS, process.env.EXPENSE_OFFICER_STATION_STAFF_IDS];

  before(async () => {
    process.env.WORK_REMINDERS_ENABLED = "true";
    [pfiA, pfiB, pfiC, pfiT] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/${SERIAL}/26/WREM-A-${RUN}`, status: "active", startingQtyLitres: 1000, locationName: "Calabar Depot" },
        { pfiNumber: `PFI/${SERIAL + 1}/26/WREM-B-${RUN}`, status: "active", startingQtyLitres: 1000, locationName: "Lagos Depot" },
        { pfiNumber: `PFI/${SERIAL + 2}/26/WREM-C-${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/${SERIAL + 3}/26/WREM-T-${RUN}`, status: "active", startingQtyLitres: 1000, pfiType: "trucking" },
      ])
      .returning();

    financeOnA = await person(["finance"], "fin-a");
    financeOnB = await person(["finance"], "fin-b");
    financeNowhere = await person(["finance"], "fin-none");
    ticketingOnA = await person(["ticketing", "dispatch"], "tkt-a");
    exitOnA = await person(["security_exit"], "exit-a");
    entryOnA = await person(["security_entry"], "entry-a");
    salesManagerOnA = await person(["sales_manager"], "sm-a");
    truckSalesOnT = await person(["truck_sales"], "ts-t");
    admin = await person(["admin"], "admin");
    officer = await person(["expenditure_officer"], "officer");
    stationOfficer = await person(["truck_sales"], "stn-officer");
    cfo = await person(["finance"], "cfo");
    raiser = await person(["truck_sales"], "raiser");
    // The CFO and each expense's officer are named, as the expense chain names them.
    process.env.EXPENSE_CFO_STAFF_IDS = String(cfo);
    process.env.EXPENSE_OFFICER_STAFF_IDS = String(officer);
    process.env.EXPENSE_OFFICER_STATION_STAFF_IDS = String(stationOfficer);

    await client`
      INSERT INTO pfi_staff (pfi_id, staff_id) VALUES
        (${pfiA.id}, ${financeOnA}), (${pfiB.id}, ${financeOnB}),
        (${pfiA.id}, ${ticketingOnA}), (${pfiA.id}, ${exitOnA}), (${pfiA.id}, ${entryOnA}),
        (${pfiA.id}, ${salesManagerOnA}), (${pfiT.id}, ${truckSalesOnT})`;

    // On A: two payments late, one too new; one paid order not ticketed.
    await order(pfiA, 5);
    await order(pfiA, 3);
    await order(pfiA, 1);
    await order(pfiA, 4, { status: "Released", paymentStatus: "Paid", releasedHoursAgo: 3 });
    // On A: a ticketed truck on the yard three hours.
    const loading = await order(pfiA, 6, { status: "Loading", paymentStatus: "Paid", releasedHoursAgo: 5 });
    await client`
      INSERT INTO order_trucks (order_id, truck_index, quantity, truck_number, status, created_at)
      VALUES (${loading}, 1, 100, ${`WR${RUN % 100000}`}, 'gated_in', now() - interval '3 hours')`;
    // On C, which has no finance officer: a late payment nobody owns.
    await order(pfiC, 5);

    // One expense at each stage of the chain, every one waiting three hours;
    // the one sent back was raised by `raiser`.
    const made = await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, amount, exchange_rate, description, status, added_by,
                                created_at, updated_at, verified_at, audit_approved_at, admin_approved_at, reviewed_at)
      SELECT ${pfiA.id}, c.id, 5000, 1, ${`Work reminder test ${RUN}`}, s.status,
             CASE WHEN s.status = 'changes_requested' THEN ${raiser}::int END,
             now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours',
             now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours'
        FROM (SELECT id FROM expense_categories ORDER BY id LIMIT 1) c,
             (VALUES ('pending'::expense_status), ('verified'::expense_status), ('audit_approved'::expense_status),
                     ('admin_approved'::expense_status), ('changes_requested'::expense_status)) s(status)
      RETURNING id`;
    expenseIds.push(...made.map((e) => Number(e.id)));
    // And one raised for a filling station, waiting to be verified.
    const [stationExpense] = await client`
      INSERT INTO pfi_expenses (category_id, amount, exchange_rate, description, status, delivery_customer_id, created_at, updated_at)
      SELECT c.id, 7000, 1, ${`Work reminder station test ${RUN}`}, 'pending', dc.id, now() - interval '3 hours', now() - interval '3 hours'
        FROM (SELECT id FROM expense_categories ORDER BY id LIMIT 1) c,
             (SELECT id FROM delivery_customers ORDER BY id LIMIT 1) dc
      RETURNING id`;
    expenseIds.push(Number(stationExpense.id));
  });

  after(async () => {
    if (savedSwitch === undefined) delete process.env.WORK_REMINDERS_ENABLED;
    else process.env.WORK_REMINDERS_ENABLED = savedSwitch;
    if (savedCfo === undefined) delete process.env.EXPENSE_CFO_STAFF_IDS;
    else process.env.EXPENSE_CFO_STAFF_IDS = savedCfo;
    if (savedOfficers[0] === undefined) delete process.env.EXPENSE_OFFICER_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STAFF_IDS = savedOfficers[0];
    if (savedOfficers[1] === undefined) delete process.env.EXPENSE_OFFICER_STATION_STAFF_IDS;
    else process.env.EXPENSE_OFFICER_STATION_STAFF_IDS = savedOfficers[1];
    await client`DELETE FROM notifications WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM staff_notification_overrides WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM daily_reports WHERE submitted_by = ANY(${staffIds})`;
    await client`DELETE FROM audit_events WHERE action = ${workReminders.ROUND_ACTION} AND (metadata->>'partial')::boolean = true
                   AND created_at > now() - interval '1 hour'`;
    await client`DELETE FROM pfi_expenses WHERE id = ANY(${expenseIds})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM order_trucks WHERE order_id = ANY(${orderIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id, pfiC.id, pfiT.id]));
    await client`UPDATE staff SET is_active = false WHERE id = ANY(${staffIds})`;
    await closeDb();
  });

  test("finance is told of late payments on its own PFI, named, and nothing else", async () => {
    const messages = await round(todayAt(10));
    const [m] = of(messages, financeOnA, "desk");
    assert.ok(m, "finance on A is reminded");
    // The one-hour-old order is not late yet.
    assert.equal(m.text, `Hello ${m.person.firstName}, 2 orders on ${LABEL.A} are waiting for you to confirm their payment.`);
  });

  test("nobody assigned, nobody told: not another PFI's finance, not unassigned finance, not the admins", async () => {
    const messages = await round(todayAt(10));
    assert.equal(of(messages, financeOnB, "desk").length, 0, "finance on B has nothing on B");
    assert.equal(of(messages, financeNowhere).length, 0, "finance on no PFI gets nothing");
    // C's late payment has no finance officer, so it reaches no one at all.
    const everyone = await workReminders.buildRound(todayAt(10), { trigger: "schedule" });
    assert.equal(everyone.messages.filter((m) => m.text.includes(LABEL.C)).length, 0);
  });

  test("admins hear only of expenses waiting for their final approval", async () => {
    const messages = await round(todayAt(10));
    const [m] = of(messages, admin, "desk");
    assert.ok(m, "the admin is reminded");
    assert.match(m.text, /^Hello \S+, \d+ expense requests? (is|are) waiting for your final approval\.$/);
  });

  test("each expense stage reaches whoever's turn it is, and only them", async () => {
    const messages = await round(todayAt(10));
    const text = (id) => of(messages, id, "desk")[0]?.text || "";
    assert.match(text(officer), /^Hello \S+, \d+ expense requests? (is|are) waiting for you to verify\. \d+ approved expense requests? (is|are) waiting for you to pay\.$/);
    assert.match(text(cfo), /^Hello \S+, \d+ expense requests? (is|are) waiting for your CFO approval\.$/);
    assert.equal(text(raiser), `Hello ${of(messages, raiser)[0].person.firstName}, 1 of your expense requests was sent back for changes.`);
    // The admin is not reminded to verify or to pay — only the final approval.
    assert.doesNotMatch(text(admin), /verify|to pay|CFO/);
    // The rest of finance is not the CFO.
    assert.doesNotMatch(text(financeOnA), /expense/);
    // A station's expense waits on the station officer — role or not — and only on them.
    assert.match(text(stationOfficer), /^Hello \S+, \d+ expense requests? (is|are) waiting for you to verify\.$/);
  });

  test("ticketing hears of paid orders not ticketed on its PFI", async () => {
    const messages = await round(todayAt(10));
    const [m] = of(messages, ticketingOnA, "desk");
    assert.equal(m.text, `Hello ${m.person.firstName}, 1 paid order on ${LABEL.A} is not ticketed yet. Please write its ticket.`);
  });

  test("the exit gate hears of ticketed trucks not gated out; the entrance gate has no work reminders", async () => {
    const messages = await round(todayAt(10));
    const [m] = of(messages, exitOnA, "desk");
    assert.equal(m.text, `Hello ${m.person.firstName}, 1 ticketed truck on ${LABEL.A} has not been gated out yet. Please record its exit.`);
    assert.equal(of(messages, entryOnA, "desk").length, 0);
  });

  test("the daily report is chased at 20:00 and 22:00 only, until it is in", async () => {
    assert.equal(of(await round(todayAt(18)), salesManagerOnA, "report").length, 0, "not at 18:00");
    assert.equal(of(await round(todayAt(19)), salesManagerOnA, "report").length, 0, "not at 19:00");

    const [m] = of(await round(todayAt(20)), salesManagerOnA, "report");
    assert.ok(m, "chased at 20:00");
    assert.equal(m.text, `Hello ${m.person.firstName}, please enter your report for today, ${m.data.day}: daily sales report for ${LABEL.A}.`);
    assert.equal(of(await round(todayAt(22)), salesManagerOnA, "report").length, 1, "and again at 22:00");

    await client`
      INSERT INTO daily_reports (report_type, report_date, location, pfi_number, submitted_by, status)
      VALUES ('sales_manager', ${lagosToday()}, 'Calabar', ${pfiA.pfiNumber}, ${salesManagerOnA}, 'submitted')`;
    assert.equal(of(await round(todayAt(22)), salesManagerOnA, "report").length, 0, "filed, so not chased");
  });

  test("no orders by 18:00: every officer on that PFI is asked why, and only then", async () => {
    const at6 = await round(todayAt(18));
    const [m] = of(at6, financeOnB, "noOrders");
    assert.ok(m, "finance on B is asked");
    assert.equal(m.text, `Hello ${m.person.firstName}, no orders have been raised today, ${m.data.day}, on ${LABEL.B} at Lagos Depot. What is the issue?`);
    assert.equal(of(at6, financeOnA, "noOrders").length, 0, "A raised orders today");
    assert.equal(of(at6, truckSalesOnT, "noOrders").length, 0, "a trucking PFI does not take orders");
    assert.equal(of(await round(todayAt(16)), financeOnB, "noOrders").length, 0, "not before 18:00");
  });

  test("one work text per person per round, sent once an hour", async () => {
    const at = new Date();
    const first = await workReminders.runRound({ trigger: "manual", at, staffIds: [financeOnA] });
    const mine = first.results.find((r) => r.staffId === financeOnA && r.kind === "desk");
    assert.ok(["texted", "app_only"].includes(mine.status), `${mine.status} ${mine.error || ""}`);

    const [row] = await client`
      SELECT 1 FROM notifications WHERE staff_id = ${financeOnA} AND type = ${workReminders.NOTICES.desk}`;
    assert.ok(row, "a bell notice was written");

    const again = await workReminders.runRound({ trigger: "manual", at, staffIds: [financeOnA] });
    assert.equal(again.results.find((r) => r.staffId === financeOnA && r.kind === "desk").status, "duplicate");
  });

  test("a person switched off on Manage Users is sent nothing", async () => {
    await client`
      INSERT INTO staff_notification_overrides (staff_id, choice, enabled) VALUES (${exitOnA}, 'work_reminders', false)`;
    const r = await workReminders.runRound({ trigger: "manual", staffIds: [exitOnA] });
    assert.equal(r.results.find((x) => x.staffId === exitOnA)?.status, "switched_off");
    const rows = await client`
      SELECT 1 FROM notifications WHERE staff_id = ${exitOnA}
         AND type IN ('staff.work_reminder', 'staff.report_reminder', 'staff.no_orders_alert')`;
    assert.equal(rows.length, 0);
  });

  test("a partial round does not stand in for the scheduled one; a full one does", async () => {
    const at = new Date("2020-01-06T09:00:00Z");
    const key = workReminders.roundKey(at);
    try {
      await workReminders.runRound({ trigger: "manual", at, staffIds: [financeOnA] });
      assert.equal(await workReminders.roundAlreadySent(key), false);
      await client`
        INSERT INTO audit_events (action, actor_type, entity_type, entity_id, metadata)
        VALUES (${workReminders.ROUND_ACTION}, 'system', 'work_reminder_round', ${key}, ${JSON.stringify({ partial: false })}::jsonb)`;
      assert.equal(await workReminders.roundAlreadySent(key), true);
      assert.equal((await workReminders.runRound({ trigger: "schedule", at })).skipped, true);
    } finally {
      await client`DELETE FROM audit_events WHERE action = ${workReminders.ROUND_ACTION} AND entity_id = ${key}`;
    }
  });
});

describe("Work reminder wording and settings", () => {
  test("they are on unless switched off, and an off round sends nothing", async () => {
    const saved = process.env.WORK_REMINDERS_ENABLED;
    try {
      delete process.env.WORK_REMINDERS_ENABLED;
      assert.equal(workReminders.settings().enabled, true, "on by default");
      process.env.WORK_REMINDERS_ENABLED = "false";
      assert.equal(workReminders.settings().enabled, false);
      const r = await workReminders.runRound({ trigger: "manual" });
      assert.equal(r.skipped, true);
      assert.match(r.reason, /switched off/);
    } finally {
      if (saved === undefined) delete process.env.WORK_REMINDERS_ENABLED;
      else process.env.WORK_REMINDERS_ENABLED = saved;
    }
  });

  test("each round sends what is due at its hour", () => {
    const at = (h) => new Date(`2026-10-06T${String(h - 1).padStart(2, "0")}:00:00Z`);
    const due = (h, trigger = "schedule") => {
      const d = workReminders.dueKinds(at(h), trigger);
      return ["desk", "report", "noOrders"].filter((k) => d[k]).join("+");
    };
    assert.equal(due(8), "desk");
    assert.equal(due(18), "desk+noOrders");
    assert.equal(due(20), "desk+report");
    assert.equal(due(22), "report");
    assert.equal(due(10, "manual"), "desk");
    assert.equal(due(21, "manual"), "desk+report+noOrders");
    assert.equal(workReminders.cronExpression(), "0 8,10,12,14,16,18,20,22 * * *");
  });

  test("a person on several desks gets one text, each desk named by PFI", () => {
    const sms = CATALOG["staff.work_reminder"].sms({
      firstName: "Musa",
      expenseFinal: 1,
      payments: [{ pfi: "PFI 47", count: 3 }, { pfi: "PFI 49", count: 1 }],
      tickets: [],
      exits: [{ pfi: "PFI 47", count: 2 }],
    });
    assert.equal(
      sms,
      "Hello Musa, 1 expense request is waiting for your final approval. 4 orders are waiting for you to confirm their payment: 3 on PFI 47 and 1 on PFI 49. 2 ticketed trucks on PFI 47 have not been gated out yet. Please record their exit.",
    );
  });

  test("the three texts are one personal choice an admin can switch off", () => {
    for (const type of ["staff.work_reminder", "staff.report_reminder", "staff.no_orders_alert"]) {
      const choice = choiceForType(type);
      assert.equal(choice?.key, "work_reminders", type);
      assert.equal(choice.personal, true);
    }
  });
});
