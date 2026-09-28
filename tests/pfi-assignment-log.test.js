// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { inArray } = require("drizzle-orm");

const app = require("../app");
const { db, client } = require("../config/db");
const { pfis } = require("../db/schema");
const { pfiRepo } = require("../repositories");
const { closeDb, staffToken, staffTokenWithRoles } = require("./helpers");

/**
 * The PFI assignment record (migration 0060): every assignment and removal,
 * who made it, how and when, append-only.
 *
 * What has to hold: each path that changes an assignment is recorded and
 * attributed; saving a user without changing their PFIs records nothing and
 * keeps the assignment's date; a change made outside the app is still
 * recorded, as unattributed; the record survives the PFI and the account it
 * describes; nothing in it can be edited or removed; and the summary built
 * from it agrees with what is actually assigned.
 */
const RUN = Date.now();

let superToken;
let superId;
let officerId;
let pfiA;
let pfiB;
let pfiC;
let doomed;

const as = (t) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${t}`),
  patch: (url, body) => request(app).patch(url).set("Authorization", `Bearer ${t}`).send(body),
  delete: (url) => request(app).delete(url).set("Authorization", `Bearer ${t}`),
});

const logFor = (staffId) => client`
  SELECT action, pfi_id AS "pfiId", pfi_number AS "pfiNumber", source, actor_staff_id AS "actorId",
         actor_name AS "actorName", ip_address AS ip, note
    FROM pfi_assignment_log WHERE staff_id = ${staffId} ORDER BY id`;

describe("PFI assignment record", () => {
  before(async () => {
    superToken = await staffToken(request, app);
    [{ id: superId }] = await client`SELECT id FROM staff WHERE email = 'test-staff@soroman.test'`;
    const officer = await staffTokenWithRoles(["ticketing"], `assign-log-${RUN}@soroman.test`);
    officerId = Number(officer.staff.id);
    await client`UPDATE staff SET first_name = 'Amaka', surname = 'Record' WHERE id = ${officerId}`;

    [pfiA, pfiB, pfiC, doomed] = await db
      .insert(pfis)
      .values([
        { pfiNumber: `PFI/LOG/A/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/LOG/B/${RUN}`, status: "active", startingQtyLitres: 1000 },
        { pfiNumber: `PFI/LOG/C/${RUN}`, status: "not_started", startingQtyLitres: 1000, auditOfficerId: officerId },
        { pfiNumber: `PFI/LOG/GONE/${RUN}`, status: "active", startingQtyLitres: 1000 },
      ])
      .returning();
  });

  after(async () => {
    // The log itself is append-only and stays; everything it describes goes.
    await client`DELETE FROM pfi_staff WHERE staff_id = ${officerId}`;
    await db.delete(pfis).where(inArray(pfis.id, [pfiA.id, pfiB.id, pfiC.id, doomed.id]));
    await closeDb();
  });

  test("assigning on Manage Users is recorded, with who did it and from where", async () => {
    const res = await as(superToken).patch(`/api/admin/${officerId}`, {
      can_view_all_locations: false,
      pfi_ids: [pfiA.id, pfiB.id],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const log = await logFor(officerId);
    assert.deepEqual(log.map((r) => [r.action, r.pfiId]), [["assigned", pfiA.id], ["assigned", pfiB.id]]);
    for (const r of log) {
      assert.equal(r.source, "manage_users");
      assert.equal(Number(r.actorId), Number(superId));
      assert.equal(r.actorName, "Test Staff");
      assert.ok(r.ip, "where the change came from");
    }
    assert.equal(log[0].pfiNumber, `PFI/LOG/A/${RUN}`, "the number as it was, kept on the row");
  });

  test("saving without changing their PFIs records nothing and keeps the date", async () => {
    const [before] = await client`SELECT created_at FROM pfi_staff WHERE staff_id = ${officerId} AND pfi_id = ${pfiA.id}`;
    await as(superToken).patch(`/api/admin/${officerId}`, { pfi_ids: [pfiB.id, pfiA.id], depot_ids: [] });
    assert.equal((await logFor(officerId)).length, 2);
    const [after] = await client`SELECT created_at FROM pfi_staff WHERE staff_id = ${officerId} AND pfi_id = ${pfiA.id}`;
    assert.equal(String(after.created_at), String(before.created_at));
  });

  test("an old build re-writing every assignment in one save records nothing", async () => {
    // What Manage Users used to do on every save, and what any build still
    // running that code does: delete all of a person's rows, insert them again.
    const before = (await logFor(officerId)).length;
    await client.begin(async (tx) => {
      await tx`DELETE FROM pfi_staff WHERE staff_id = ${officerId}`;
      await tx`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${pfiA.id}, ${officerId}), (${pfiB.id}, ${officerId})`;
    });
    assert.equal((await logFor(officerId)).length, before, "no end-and-begin churn");

    // Assigned and taken away again inside one transaction is no change either.
    await client.begin(async (tx) => {
      await tx`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${pfiC.id}, ${officerId})`;
      await tx`DELETE FROM pfi_staff WHERE staff_id = ${officerId} AND pfi_id = ${pfiC.id}`;
    });
    assert.equal((await logFor(officerId)).length, before);
  });

  test("taking one away is recorded as its end", async () => {
    await as(superToken).patch(`/api/admin/${officerId}`, { pfi_ids: [pfiA.id] });
    const log = await logFor(officerId);
    assert.deepEqual(log.at(-1), { ...log.at(-1), action: "removed", pfiId: pfiB.id, source: "manage_users" });
  });

  test("the record reads as current and past, with who began and ended each", async () => {
    const res = await as(superToken).get(`/api/admin/${officerId}/pfi-assignments`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { current, past, events } = res.body.data;
    assert.deepEqual(current.map((p) => p.pfiId), [pfiA.id]);
    assert.equal(current[0].assignedBy, "Test Staff");
    assert.equal(current[0].assignedVia, "Manage Users");
    assert.equal(current[0].pfi.status, "active");
    assert.deepEqual(past.map((p) => p.pfiId), [pfiB.id]);
    assert.equal(past[0].removedBy, "Test Staff");
    assert.equal(past[0].days, 0);
    assert.equal(events.length, 3);
    assert.equal(events[0].action, "removed", "newest first");
  });

  test("being named as a PFI's officer shows beside it, with whether they can open it", async () => {
    const { namedAsOfficer } = (await as(superToken).get(`/api/admin/${officerId}/pfi-assignments`)).body.data;
    assert.deepEqual(namedAsOfficer.map((n) => [n.pfiId, n.roles, n.hasAccess]), [
      [pfiC.id, ["Finance / Audit Officer"], false],
    ]);
  });

  test("releasing a PFI records its officers as assigned by whoever released it", async () => {
    await pfiRepo.activate({
      pfiId: pfiC.id,
      officers: { auditOfficerId: officerId },
      activatedBy: superId,
      context: { actorId: superId, source: "pfi_activation", note: "Named as an officer when the PFI was released to trade" },
    });
    const last = (await logFor(officerId)).at(-1);
    assert.equal(last.action, "assigned");
    assert.equal(last.pfiId, pfiC.id);
    assert.equal(last.source, "pfi_activation");
    assert.equal(Number(last.actorId), Number(superId));
  });

  test("a change made outside the app is still recorded, as unattributed", async () => {
    await client`INSERT INTO pfi_staff (pfi_id, staff_id) VALUES (${doomed.id}, ${officerId})`;
    const last = (await logFor(officerId)).at(-1);
    assert.equal(last.action, "assigned");
    assert.equal(last.source, "unattributed");
    assert.equal(last.actorId, null);
  });

  test("deleting the PFI ends the assignment on the record, and the record keeps its number", async () => {
    const res = await as(superToken).delete(`/api/pfis/${doomed.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const last = (await logFor(officerId)).at(-1);
    assert.equal(last.action, "removed");
    assert.equal(last.source, "pfi_deleted");
    assert.equal(last.pfiNumber, `PFI/LOG/GONE/${RUN}`);

    const { past } = (await as(superToken).get(`/api/admin/${officerId}/pfi-assignments`)).body.data;
    const gone = past.find((p) => p.pfiId === doomed.id);
    assert.equal(gone.pfiNumber, `PFI/LOG/GONE/${RUN}`);
    assert.equal(gone.pfi.exists, false);
    assert.equal(gone.removedVia, "PFI deleted");
  });

  test("nothing in the record can be changed or removed", async () => {
    await assert.rejects(client`UPDATE pfi_assignment_log SET note = 'edited' WHERE staff_id = ${officerId}`, /append-only/);
    await assert.rejects(client`DELETE FROM pfi_assignment_log WHERE staff_id = ${officerId}`, /append-only/);
    await assert.rejects(client`TRUNCATE pfi_assignment_log`, /append-only/);
  });

  test("the record outlives the account, and says who deleted it", async () => {
    const gone = await staffTokenWithRoles(["ticketing"], `assign-log-gone-${RUN}@soroman.test`);
    const goneId = Number(gone.staff.id);
    await client`UPDATE staff SET first_name = 'Kept', surname = 'OnRecord', can_view_all_locations = false WHERE id = ${goneId}`;
    await as(superToken).patch(`/api/admin/${goneId}`, { pfi_ids: [pfiA.id] });

    const res = await as(superToken).delete(`/api/admin/${goneId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const log = await logFor(goneId);
    assert.deepEqual(log.map((r) => [r.action, r.source]), [["assigned", "manage_users"], ["removed", "account_deleted"]]);
    const [row] = await client`SELECT staff_name FROM pfi_assignment_log WHERE staff_id = ${goneId} ORDER BY id DESC LIMIT 1`;
    assert.equal(row.staff_name, "Kept OnRecord", "the name as it was, though the account is gone");

    const record = await as(superToken).get(`/api/admin/${goneId}/pfi-assignments`);
    assert.equal(record.status, 200);
    assert.equal(record.body.data.past[0].removedVia, "Account deleted");
  });
});
