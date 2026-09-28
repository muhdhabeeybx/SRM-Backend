// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { sessionRepo } = require("../repositories");
const { closeDb, staffToken } = require("./helpers");

/**
 * When each member of staff was last active, for Manage Users: on the list,
 * when and how many sign-ins are live; on the detail, also from where.
 */
let token;
let meId;

const get = (url) => request(app).get(url).set("Authorization", `Bearer ${token}`).set("User-Agent", "StaffActivityTest/1.0");

describe("Staff activity on Manage Users", () => {
  before(async () => {
    token = await staffToken(request, app);
    [{ id: meId }] = await client`SELECT id FROM staff WHERE email = 'test-staff@soroman.test'`;
  });

  after(closeDb);

  test("the list says when somebody was last active and how many sign-ins are live", async () => {
    const res = await get("/api/admin");
    assert.equal(res.status, 200);
    const me = res.body.data.staff.find((s) => Number(s.id) === Number(meId));
    assert.ok(me.lastActiveAt, "a signed-in person has a last-active time");
    assert.ok(!Number.isNaN(new Date(me.lastActiveAt).getTime()), "as a date that parses");
    assert.ok(me.activeSessions >= 1);
    assert.ok(me.activeBrowsers >= 1 && me.activeBrowsers <= me.activeSessions, "browsers, not sign-ins");
    assert.ok(!("lastSession" in me), "addresses stay off the list");
  });

  test("the detail adds where the latest sign-in came from", async () => {
    const res = await get(`/api/admin/${meId}`);
    assert.equal(res.status, 200);
    const { admin } = res.body.data;
    assert.ok(admin.lastActiveAt);
    assert.ok(admin.lastSession, "the latest sign-in");
    assert.equal(typeof admin.lastSession.ipAddress, "string");
  });

  test("somebody who has never signed in has no activity, not an error", async () => {
    const activity = await sessionRepo.staffActivity([2147483000]);
    assert.equal(activity.size, 0);
  });
});
