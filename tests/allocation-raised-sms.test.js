// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const recipients = require("../notifications/recipients");
const { getType } = require("../notifications/catalog");
const { rolesFor } = require("../notifications/staffChoices");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * A truck allocation waiting for approval reaches the approvers by text as
 * well as the bell (2026-10-21) — and never the person who raised it.
 */
const RUN = Date.now();
const staffIds = [];
let raiser;
let approver;

describe("allocation waiting for approval: the text to the approvers", () => {
  before(async () => {
    for (const tag of ["raiser", "approver"]) {
      const s = await staffTokenWithRoles(["admin"], `alloc-sms-${tag}-${RUN}@soroman.test`);
      staffIds.push(Number(s.staff.id));
    }
    [raiser, approver] = staffIds;
  });

  after(async () => {
    if (staffIds.length) await client`DELETE FROM staff WHERE id IN ${client(staffIds)}`;
    await closeDb();
  });

  test("goes out by text as well as the bell", () => {
    assert.ok(getType("staff.pfi_allocation_raised").channels.includes("sms"));
  });

  test("the approvers are reached, the one who raised it is not", async () => {
    const to = await recipients.resolve({ roles: rolesFor("pfi_allocations"), exceptStaffIds: [raiser] });
    const ids = to.filter((r) => r.principal?.type === "staff").map((r) => Number(r.principal.id));
    assert.ok(ids.includes(approver), "another admin is told");
    assert.ok(!ids.includes(raiser), "the raiser is not told about their own request");
  });

  test("says which PFI, how much, and where to approve it, in one text", () => {
    const sms = getType("staff.pfi_allocation_raised").sms({
      pfiShort: "PFI 38B", parentShort: "PFI 38", trucks: 52, quantity: 2_530_000, unit: "Litres",
      value: 3_415_500_000, raisedByName: "Habeeb Suleiman",
    });
    assert.match(sms, /New trucking PFI 38B needs your approval: 52 trucks, 2,530,000 Litres off PFI 38, N3,415,500,000\./);
    assert.match(sms, /Raised by Habeeb Suleiman\. Approve on the dashboard\.$/);
    assert.ok(!sms.includes("₦"), "N, not ₦, so it stays one GSM part");
    assert.ok(sms.length <= 160, `${sms.length} characters`);
  });

  test("litres to a station name the station, not trucks", () => {
    const sms = getType("staff.pfi_allocation_raised").sms({
      pfiShort: "PFI 49B", parentShort: "PFI 49", trucks: 1, quantity: 50_000, unit: "Litres",
      value: 70_000_000, stationName: "Kano Filling Station", raisedByName: "Habeeb Suleiman",
    });
    assert.match(sms, /50,000 Litres to Kano Filling Station off PFI 49/);
    assert.ok(!/truck/.test(sms.replace("trucking", "")));
  });
});
