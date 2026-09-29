require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const { outstandingReports, sendReminders, reminderText } = require("../services/reportReminders.service");
const { closeDb } = require("./helpers");

/**
 * Who has not filed, and who gets texted about it.
 *
 * Against the database, because every rule is a rule about rows: which staff
 * own a batch (PFI assignment, or the depot it sells from), which sheets
 * count as filed, and which targets the server will refuse to text. The test
 * database is shared, so every assertion is about this run's own rows.
 */
const RUN = `RR${Date.now()}`.slice(-9);
const DAY = "2026-09-22";

describe("report reminders", () => {
  const ids = {};

  before(async () => {
    const [depot] = await client`
      INSERT INTO depots (name, code, address, city, state, country, postcode, max_capacity, established_year)
      VALUES (${`${RUN} Depot`}, ${RUN}, 'Test', 'Test', 'Test', 'NG', '000000', 10, '2026')
      RETURNING id`;
    ids.depot = Number(depot.id);

    const pfis = await client`
      INSERT INTO pfis (pfi_number, pfi_type, status, starting_qty_litres, unit_price, location_id, location_name)
      VALUES (${`PFI/${RUN}1/26/A`}, 'coastal',  'active',   1000000, '300',  ${ids.depot}, ${`${RUN} Depot`}),
             (${`PFI/${RUN}2/26/B`}, 'coastal',  'active',   1000000, '300',  NULL, 'Elsewhere'),
             (${`PFI ${RUN}3T`},     'trucking', 'active',   500000,  '1200', NULL, 'Road'),
             (${`PFI/${RUN}4/26/C`}, 'coastal',  'finished', 1000000, '300',  NULL, 'Closed')
      RETURNING id`;
    [ids.pfiA, ids.pfiB, ids.trucking, ids.finished] = pfis.map((p) => Number(p.id));

    const people = await client`
      INSERT INTO staff (first_name, surname, email, phone_number, roles, can_view_all_locations)
      VALUES ('Sade',   ${RUN}, ${`sade.${RUN}@t.dev`},   '08030000001', ARRAY['sales_manager']::text[],      false),
             ('Musa',   ${RUN}, ${`musa.${RUN}@t.dev`},   '08030000002', ARRAY['sales_manager']::text[],      false),
             ('Gate',   ${RUN}, ${`gate.${RUN}@t.dev`},   NULL,          ARRAY['security_entry']::text[],     false),
             ('Seer',   ${RUN}, ${`seer.${RUN}@t.dev`},   '08030000004', ARRAY['sales_manager']::text[],      true),
             ('Kemi',   ${RUN}, ${`kemi.${RUN}@t.dev`},   '08030000005', ARRAY['commission_officer']::text[], false)
      RETURNING id`;
    [ids.sade, ids.musa, ids.gate, ids.seer, ids.kemi] = people.map((p) => Number(p.id));

    // Sade: assigned to PFI A itself. Musa: to A's depot, so A through scope.
    // Gate: on B, no phone. Seer: sees everything, assigned nowhere.
    // Kemi: a commission officer on B.
    await client`
      INSERT INTO pfi_staff (pfi_id, staff_id)
      VALUES (${ids.pfiA}, ${ids.sade}), (${ids.pfiB}, ${ids.gate}), (${ids.pfiB}, ${ids.kemi})`;
    await client`INSERT INTO depot_staff (depot_id, staff_id) VALUES (${ids.depot}, ${ids.musa})`;

    // Sade files A's sales sheet; nobody files B's. The pfi_number is typed on
    // a form, so it arrives in lower case with stray spaces.
    await client`
      INSERT INTO daily_reports (report_date, location, pfi_number, report_type, submitted_by, submitted_by_name)
      VALUES (${DAY}, 'Test', ${` pfi/${RUN.toLowerCase()}1/26/a `}, 'sales_manager', ${ids.sade}, 'Sade')`;
  });

  after(async () => {
    const staffIds = [ids.sade, ids.musa, ids.gate, ids.seer, ids.kemi];
    await client`DELETE FROM audit_events WHERE action = 'daily_report.reminder' AND entity_id = ${DAY}`;
    await client`DELETE FROM daily_reports WHERE report_date = ${DAY} AND location = 'Test'`;
    await client`DELETE FROM pfi_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM depot_staff WHERE staff_id = ANY(${staffIds})`;
    await client`DELETE FROM staff WHERE id = ANY(${staffIds})`;
    await client`DELETE FROM pfis WHERE id = ANY(${[ids.pfiA, ids.pfiB, ids.trucking, ids.finished]})`;
    await client`DELETE FROM depots WHERE id = ${ids.depot}`;
    await closeDb();
  });

  const deskOf = (data, role, pfiId) =>
    data.roles.find((r) => r.type === role).desks.find((d) => d.pfiId === pfiId);

  test("lists active depot batches only, under every desk", async () => {
    const data = await outstandingReports(DAY);
    const listed = new Set(data.pfis.map((p) => p.id));
    assert.ok(listed.has(ids.pfiA) && listed.has(ids.pfiB));
    assert.ok(!listed.has(ids.trucking), "trucking PFIs file no desk sheets");
    assert.ok(!listed.has(ids.finished), "finished PFIs are not chased");
    assert.equal(data.roles.length, 5);
  });

  test("a desk is filed by any sheet of its type on the batch, however it was typed", async () => {
    const data = await outstandingReports(DAY);
    const a = deskOf(data, "sales_manager", ids.pfiA);
    assert.equal(a.status, "filed");
    assert.equal(a.filedBy[0].name, "Sade");
    assert.equal(deskOf(data, "sales_manager", ids.pfiB).status, "missing");
  });

  test("owners are role plus scope: the PFI itself or its depot, never mere visibility", async () => {
    const data = await outstandingReports(DAY);
    const a = deskOf(data, "sales_manager", ids.pfiA);
    const names = a.officers.map((o) => o.name).sort();
    assert.deepEqual(names, [`Musa ${RUN}`, `Sade ${RUN}`]);
    assert.equal(a.officers.find((o) => o.staffId === ids.sade).filed, true);
    assert.equal(a.officers.find((o) => o.staffId === ids.musa).filed, false);
    assert.ok(!a.officers.some((o) => o.staffId === ids.seer), "see-everything is not ownership");

    // commission_officer files the commissions sheet.
    const comm = deskOf(data, "commissions", ids.pfiB);
    assert.deepEqual(comm.officers.map((o) => o.staffId), [ids.kemi]);
    // Nobody is scoped to B's sales desk: a staffing gap, listed with no one.
    assert.equal(deskOf(data, "sales_manager", ids.pfiB).officers.length, 0);
  });

  test("the server refuses to chase a filed desk or a stranger, and one text covers a person's desks", async () => {
    const dry = await sendReminders({
      date: DAY,
      dryRun: true,
      targets: [
        { staffId: ids.musa, role: "sales_manager", pfiId: ids.pfiA },   // filed by Sade
        { staffId: ids.seer, role: "sales_manager", pfiId: ids.pfiB },   // not an officer there
        { staffId: ids.gate, role: "security_gate", pfiId: ids.pfiB },
        { staffId: ids.kemi, role: "commissions", pfiId: ids.pfiB },
        { staffId: ids.kemi, role: "commissions", pfiId: ids.pfiB },     // a duplicate
      ],
    });
    assert.deepEqual(dry.skipped.map((s) => s.reason).sort(), ["Already filed", "Not an officer on this desk"]);
    assert.equal(dry.messages.length, 2);
    const kemi = dry.messages.find((m) => m.staffId === ids.kemi);
    assert.equal(kemi.desks.length, 1);
    assert.match(kemi.text, /^Hello Kemi, your commission report for Tue 22 Sep is not in yet for PFI /);
  });

  test("a send reports each person's outcome and is recorded against the desk", async () => {
    const prev = process.env.SMS_ENABLED;
    process.env.SMS_ENABLED = "false";
    try {
      const out = await sendReminders(
        {
          date: DAY,
          targets: [
            { staffId: ids.gate, role: "security_gate", pfiId: ids.pfiB },
            { staffId: ids.kemi, role: "commissions", pfiId: ids.pfiB },
          ],
        },
        { actor: { type: "staff", id: null, name: "Tester" } },
      );
      const gate = out.results.find((r) => r.staffId === ids.gate);
      const kemi = out.results.find((r) => r.staffId === ids.kemi);
      assert.equal(gate.ok, false);
      assert.match(gate.error, /No phone number/);
      assert.equal(kemi.ok, false);
      assert.match(kemi.error, /disabled/i);

      const rows = await client`
        SELECT metadata FROM audit_events
         WHERE action = 'daily_report.reminder' AND entity_id = ${DAY}`;
      assert.equal(rows.length, 2);
    } finally {
      process.env.SMS_ENABLED = prev;
    }
  });

  test("only a delivered reminder shows against the officer", async () => {
    await client`
      INSERT INTO audit_events (action, actor_type, actor_name, entity_type, entity_id, metadata)
      VALUES ('daily_report.reminder', 'staff', 'Tester', 'daily_report_day', ${DAY},
              ${JSON.stringify({ staffId: ids.kemi, ok: true, desks: [{ role: "commissions", pfiId: ids.pfiB }] })}::jsonb)`;
    const data = await outstandingReports(DAY);
    const kemi = deskOf(data, "commissions", ids.pfiB).officers[0];
    assert.equal(kemi.reminders.length, 1, "the failed attempt above is not counted");
    assert.equal(kemi.reminders[0].by, "Tester");
  });

  test("the text names several reports in one message", () => {
    const text = reminderText({
      firstName: "Abubakar",
      date: "2026-09-28",
      desks: [
        { role: "sales_manager", pfiNumber: "PFI/47/26/MT LESTE/CALABAR/17KT" },
        { role: "commissions", pfiNumber: "PFI/47/26/MT LESTE/CALABAR/17KT" },
      ],
    });
    assert.equal(
      text,
      "Hello Abubakar, your reports for Mon 28 Sep are not in yet: " +
        "daily sales report for PFI 47; commission report for PFI 47. " +
        "Please file them on the dashboard.",
    );
  });
});
