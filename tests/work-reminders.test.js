// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { inArray } = require("drizzle-orm");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { CATALOG } = require("../notifications/catalog");
const { choiceForType } = require("../notifications/staffChoices");
const workReminders = require("../services/workReminders.service");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * The two-hourly reminders of waiting work.
 *
 * What has to hold: work reaches the people who owe it (the desk on the PFI,
 * the role, or the person), nobody else, and only once it has waited long
 * enough; each person gets one message listing all of it; a person switched
 * off is not sent anything; and a second round in the same hour texts nobody
 * twice.
 *
 * The test database is shared and full of other suites' rows, so these assert
 * on this run's own PFIs and people, never on company-wide totals.
 */
const RUN = Date.now();
const SERIAL = 900 + (RUN % 99);

let pfiA;
let pfiB;
let financeOnA;
let financeOnB;
let raiser;
let salesManager;
const orderIds = [];
const expenseIds = [];
const staffIds = [];

const person = async (roles, tag) => {
  const s = await staffTokenWithRoles(roles, `work-rem-${tag}-${RUN}@soroman.test`);
  const id = Number(s.staff.id);
  staffIds.push(id);
  return id;
};

/** An order on a PFI, placed `hoursAgo` hours ago and still unpaid. */
const pendingOrder = async (pfi, hoursAgo) => {
  const [c] = await client`SELECT id FROM customers ORDER BY id LIMIT 1`;
  const [o] = await client`
    INSERT INTO orders (order_number, customer_id, state, depot_id, product_id, quantity,
                        price, total_amount, amount_paid, delivery_type, status, payment_status, pfi_id, created_at)
    SELECT ${"WREM" + Math.floor(Math.random() * 1e9)}, ${c.id}, 'Lagos', d.id, p.id, 100,
           1000, 100000, 0, 'pickup', 'Pending', 'Unpaid', ${pfi.id}, now() - (${hoursAgo} * interval '1 hour')
      FROM (SELECT id FROM depots LIMIT 1) d, (SELECT id FROM products LIMIT 1) p
    RETURNING id`;
  orderIds.push(Number(o.id));
  return Number(o.id);
};

const lineOf = (p, kind) => p?.lines.find((l) => l.kind === kind);

describe("Work reminders", () => {
  before(async () => {
    [pfiA, pfiB] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/${SERIAL}/26/WREM-A-${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/${SERIAL + 1}/26/WREM-B-${RUN}`, status: "active", startingQtyLitres: 1000 },
      ])
      .returning();

    financeOnA = await person(["finance"], "fin-a");
    financeOnB = await person(["finance"], "fin-b");
    raiser = await person(["truck_sales"], "raiser");
    salesManager = await person(["sales_manager"], "sm");

    await client`
      INSERT INTO pfi_staff (pfi_id, staff_id)
      VALUES (${pfiA.id}, ${financeOnA}), (${pfiB.id}, ${financeOnB}), (${pfiA.id}, ${salesManager}), (${pfiA.id}, ${raiser})`;

    // Two late orders on A and one too new to chase.
    await pendingOrder(pfiA, 5);
    await pendingOrder(pfiA, 3);
    await pendingOrder(pfiA, 1);

    // An expense sent back to the person who raised it.
    const [e] = await client`
      INSERT INTO pfi_expenses (pfi_id, category_id, amount, exchange_rate, description, status, added_by, reviewed_at, created_at, updated_at)
      SELECT ${pfiA.id}, c.id, 5000, 1, 'Work reminder test', 'changes_requested', ${raiser},
             now() - interval '4 hours', now() - interval '1 day', now() - interval '4 hours'
        FROM (SELECT id FROM expense_categories ORDER BY id LIMIT 1) c
      RETURNING id`;
    expenseIds.push(Number(e.id));
  });

  after(async () => {
    await client`DELETE FROM notifications WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM staff_notification_overrides WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM audit_events WHERE action = ${workReminders.ROUND_ACTION} AND (metadata->>'partial')::boolean = true
                   AND created_at > now() - interval '1 hour'`;
    await client`DELETE FROM pfi_expenses WHERE id = ANY(${expenseIds})`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM orders WHERE id = ANY(${orderIds})`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id]));
    await client`UPDATE staff SET is_active = false WHERE id = ANY(${staffIds})`;
    await closeDb();
  });

  test("late work on a PFI reaches that PFI's desk, counted, with the oldest", async () => {
    const { people } = await workReminders.buildRound(new Date(), { staffIds });
    const a = people.find((p) => p.staffId === financeOnA);
    const line = lineOf(a, "payments");
    assert.ok(line, "finance on A is reminded of A's payments");
    // The one-hour-old order is not late yet.
    assert.equal(line.count, 2);
    assert.equal(line.oldestHours, 5);
    assert.equal(line.text, "2 orders to confirm payment for, oldest 5h");
  });

  test("another PFI's desk is not told", async () => {
    const { people } = await workReminders.buildRound(new Date(), { staffIds });
    const b = people.find((p) => p.staffId === financeOnB);
    assert.equal(lineOf(b, "payments"), undefined);
  });

  test("an expense sent back reaches whoever raised it, and only them", async () => {
    const { people } = await workReminders.buildRound(new Date(), { staffIds });
    const mine = people.find((p) => p.staffId === raiser);
    assert.equal(lineOf(mine, "expenseChanges")?.text, "1 expense sent back to you for changes, oldest 4h");
    for (const p of people.filter((x) => x.staffId !== raiser)) {
      assert.equal(lineOf(p, "expenseChanges"), undefined, `${p.name} is not the raiser`);
    }
  });

  test("an unfiled report from yesterday is chased; today's waits for the evening", async () => {
    // 11:00 Lagos: yesterday's report is late, today's is not due.
    const morning = new Date(`2026-10-05T10:00:00Z`);
    const { people } = await workReminders.buildRound(morning, { staffIds: [salesManager] });
    const lines = (people[0]?.lines || []).filter((l) => l.kind === "reports").map((l) => l.text);
    assert.ok(lines.some((t) => t.startsWith("your daily sales report for Sun 4 Oct") && t.includes(`PFI ${SERIAL}`)), lines.join(" | "));
    assert.ok(!lines.some((t) => t.includes("Mon 5 Oct")), "today's report is not chased in the morning");

    // 19:00 Lagos: today's is chased too.
    const evening = new Date(`2026-10-05T18:00:00Z`);
    const later = await workReminders.buildRound(evening, { staffIds: [salesManager] });
    const eveningLines = (later.people[0]?.lines || []).map((l) => l.text);
    assert.ok(eveningLines.some((t) => t.includes("Mon 5 Oct")), eveningLines.join(" | "));
  });

  test("one message lists everything, and the round texts each person once an hour", async () => {
    const at = new Date();
    const first = await workReminders.runRound({ trigger: "manual", at, staffIds: [financeOnA] });
    const mine = first.results.find((r) => r.staffId === financeOnA);
    assert.ok(["texted", "app_only"].includes(mine.status), `${mine.status} ${mine.error || ""}`);
    assert.match(mine.text, /^Hello .*waiting on you on the dashboard: 2 orders to confirm payment for, oldest 5h/);

    const [row] = await client`
      SELECT title, body FROM notifications WHERE staff_id = ${financeOnA} AND type = ${workReminders.NOTICE}`;
    assert.ok(row, "a bell notice was written");

    const again = await workReminders.runRound({ trigger: "manual", at, staffIds: [financeOnA] });
    assert.equal(again.results.find((r) => r.staffId === financeOnA).status, "duplicate");
  });

  test("a person switched off on Manage Users is not sent anything", async () => {
    await client`
      INSERT INTO staff_notification_overrides (staff_id, choice, enabled) VALUES (${financeOnB}, 'work_reminders', false)`;
    await pendingOrder(pfiB, 4);
    const round = await workReminders.runRound({ trigger: "manual", staffIds: [financeOnB] });
    assert.equal(round.results.find((r) => r.staffId === financeOnB)?.status, "switched_off");
    const rows = await client`SELECT 1 FROM notifications WHERE staff_id = ${financeOnB} AND type = ${workReminders.NOTICE}`;
    assert.equal(rows.length, 0);
  });

  test("a partial round does not stand in for the scheduled one; a full one does", async () => {
    // An hour long gone, so no real round shares it.
    const at = new Date("2020-01-06T09:00:00Z");
    const round = workReminders.roundKey(at);
    try {
      await workReminders.runRound({ trigger: "manual", at, staffIds: [financeOnA] });
      assert.equal(await workReminders.roundAlreadySent(round), false);
      await client`
        INSERT INTO audit_events (action, actor_type, entity_type, entity_id, metadata)
        VALUES (${workReminders.ROUND_ACTION}, 'system', 'work_reminder_round', ${round}, ${JSON.stringify({ partial: false })}::jsonb)`;
      assert.equal(await workReminders.roundAlreadySent(round), true);
      const skipped = await workReminders.runRound({ trigger: "schedule", at });
      assert.equal(skipped.skipped, true);
    } finally {
      await client`DELETE FROM audit_events WHERE action = ${workReminders.ROUND_ACTION} AND entity_id = ${round}`;
    }
  });
});

describe("Work reminder wording and settings", () => {
  test("the SMS greets, lists up to five, and says how many more", () => {
    const sms = CATALOG["staff.work_reminder"].sms({
      firstName: "Musa",
      lines: ["a", "b", "c", "d", "e", "f", "g"],
    });
    assert.equal(sms, "Hello Musa, waiting on you on the dashboard: a; b; c; d; e; and 2 more. Please clear them.");
    assert.equal(
      CATALOG["staff.work_reminder"].sms({ lines: ["4 orders to ticket, oldest 6h"] }),
      "Waiting on you on the dashboard: 4 orders to ticket, oldest 6h. Please clear them.",
    );
  });

  test("it is a personal choice an admin can switch off", () => {
    const choice = choiceForType("staff.work_reminder");
    assert.equal(choice?.key, "work_reminders");
    assert.equal(choice.personal, true);
  });

  test("the rounds run on the reminder hours, Lagos time", () => {
    const saved = process.env.WORK_REMINDER_HOURS;
    try {
      delete process.env.WORK_REMINDER_HOURS;
      assert.equal(workReminders.cronExpression(), "0 8,10,12,14,16,18,20 * * *");
      // 09:30 Lagos → the 10:00 round is next; 21:00 Lagos → tomorrow 08:00.
      assert.equal(workReminders.nextRound(new Date("2026-10-05T08:30:00Z")), "2026-10-05 10:00");
      assert.equal(workReminders.nextRound(new Date("2026-10-05T20:00:00Z")), "2026-10-06 08:00");
      assert.equal(workReminders.roundKey(new Date("2026-10-05T09:15:00Z")), "2026-10-05 10:00");
    } finally {
      if (saved === undefined) delete process.env.WORK_REMINDER_HOURS;
      else process.env.WORK_REMINDER_HOURS = saved;
    }
  });

  test("a desk with nobody on the PFI falls to its company-wide holders, then the admins", () => {
    const people = [
      { id: 1, roles: new Set(["finance"]), pfis: new Set([7]), depots: new Set() },
      { id: 2, roles: new Set(["finance"]), pfis: new Set(), depots: new Set() },
      { id: 3, roles: new Set(["admin"]), pfis: new Set(), depots: new Set() },
    ];
    const dir = {
      byId: new Map(people.map((p) => [p.id, p])),
      holders: (roles) => people.filter((p) => roles.some((r) => p.roles.has(r))),
      admins: () => people.filter((p) => p.roles.has("admin")),
    };
    const ids = (list) => list.map((p) => p.id);
    assert.deepEqual(ids(workReminders.deskOwners(dir, ["finance"], { pfiId: 7 })), [1]);
    assert.deepEqual(ids(workReminders.deskOwners(dir, ["finance"], { pfiId: 8 })), [2]);
    assert.deepEqual(ids(workReminders.deskOwners(dir, ["ticketing"], { pfiId: 7 })), [3]);
  });
});
