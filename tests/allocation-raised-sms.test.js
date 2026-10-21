// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { client } = require("../config/db");
const recipients = require("../notifications/recipients");
const staffChoices = require("../notifications/staffChoices");
const { getType } = require("../notifications/catalog");
const { rolesFor } = staffChoices;
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * A truck allocation waiting for approval (2026-10-21): the bell reaches every
 * approver, and a text reaches only whoever is ticked for it on Manage Users
 * (General Admin). Neither ever reaches the person who raised it.
 */
const RUN = Date.now();
const staffIds = [];
let raiser;
let approver;
let texted;

const SMS = "staff.pfi_allocation_raised_sms";
const sends = async (type, to) =>
  recipients.withoutExcepted(await staffChoices.apply(type, await recipients.resolve(to), {}), to)
    .filter((r) => r.principal?.type === "staff")
    .map((r) => Number(r.principal.id));

describe("allocation waiting for approval: who hears, and how", () => {
  before(async () => {
    for (const tag of ["raiser", "approver", "texted"]) {
      const s = await staffTokenWithRoles(["admin"], `alloc-sms-${tag}-${RUN}@soroman.test`);
      staffIds.push(Number(s.staff.id));
    }
    [raiser, approver, texted] = staffIds;
    // Ticked for the text, as General Admin is on prod.
    await client`INSERT INTO staff_notification_overrides (staff_id, choice, enabled) VALUES (${texted}, 'pfi_allocations_text', true)`;
  });

  after(async () => {
    if (staffIds.length) {
      await client`DELETE FROM staff_notification_overrides WHERE staff_id IN ${client(staffIds)}`;
      await client`DELETE FROM staff WHERE id IN ${client(staffIds)}`;
    }
    await closeDb();
  });

  test("the bell stays with every approver; the text is its own notice", () => {
    assert.deepEqual(getType("staff.pfi_allocation_raised").channels, ["in_app", "push"]);
    assert.deepEqual(getType(SMS).channels, ["sms"]);
    assert.deepEqual(rolesFor("pfi_allocations_text"), [], "nobody by default");
  });

  test("the bell reaches the approvers, not the one who raised it", async () => {
    const ids = await sends("staff.pfi_allocation_raised", { roles: rolesFor("pfi_allocations"), exceptStaffIds: [raiser] });
    assert.ok(ids.includes(approver));
    assert.ok(!ids.includes(raiser));
  });

  test("the text reaches only whoever is ticked for it", async () => {
    const ids = await sends(SMS, { roles: rolesFor("pfi_allocations_text"), exceptStaffIds: [raiser] });
    assert.ok(ids.includes(texted));
    assert.ok(!ids.includes(approver), "an admin not ticked is not texted");
  });

  test("a ticked approver who raised it himself is not texted about it", async () => {
    const ids = await sends(SMS, { roles: rolesFor("pfi_allocations_text"), exceptStaffIds: [texted] });
    assert.ok(!ids.includes(texted));
  });

  test("reads as whole sentences, with N for naira", () => {
    const sms = getType(SMS).sms({
      pfiShort: "PFI 38B", parentShort: "PFI 38", trucks: 52, quantity: 2_530_000, unit: "Litres",
      value: 3_415_500_000, raisedByName: "Habeeb Suleiman",
    });
    assert.equal(
      sms.replace(/^\S+ (?=Good day)/, ""),
      "Good day. A new trucking PFI, PFI 38B, has been raised off PFI 38 and is awaiting your approval. " +
        "It covers 52 trucks carrying 2,530,000 Litres, valued at N3,415,500,000, and was raised by Habeeb Suleiman. " +
        "Kindly review and approve it on the dashboard.",
    );
    assert.ok(!sms.includes("₦"), "N, not ₦, so it stays in GSM-7");
  });

  test("litres to a station name the station, not trucks", () => {
    const sms = getType(SMS).sms({
      pfiShort: "PFI 49B", parentShort: "PFI 49", trucks: 1, quantity: 50_000, unit: "Litres",
      value: 70_000_000, stationName: "Kano Filling Station", raisedByName: "Habeeb Suleiman",
    });
    assert.match(sms, /It sends 50,000 Litres to Kano Filling Station, valued at N70,000,000/);
  });
});
