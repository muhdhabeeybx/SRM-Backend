// Must precede any require that reaches config/db.
require("dotenv").config();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../app");
const { client } = require("../config/db");
const { staffRepo } = require("../repositories");
const { closeDb, staffTokenWithRoles } = require("./helpers");

/**
 * Passwords a super admin sets: on a new account, or over somebody's own.
 *
 * What has to hold: only a super admin can do it; a new account given one gets
 * no invitation and signs in with it; by default it is temporary, so the
 * account can do nothing but choose its own until it does; choosing one frees
 * it; setting one over an existing account ends that account's sessions; and
 * the password is never written to the audit log.
 */
const RUN = Date.now();
const emailOf = (tag) => `pw-${tag}-${RUN}@soroman.test`;
let superAdmin;
let admin;

const login = (email, password) => request(app).post("/api/auth/login").send({ email, password });
const asToken = (token) => ({
  get: (url) => request(app).get(url).set("Authorization", `Bearer ${token}`),
  post: (url, body) => request(app).post(url).set("Authorization", `Bearer ${token}`).send(body),
});

before(async () => {
  superAdmin = await staffTokenWithRoles(["super_admin"], emailOf("super"));
  admin = await staffTokenWithRoles(["admin"], emailOf("admin"));
});

after(async () => {
  const ids = (await client`SELECT id FROM staff WHERE email LIKE ${`pw-%-${RUN}@soroman.test`}`).map((r) => r.id);
  if (ids.length) {
    // This run's own audit rows first: an actor's row cannot outlive them.
    await client`DELETE FROM audit_logs WHERE actor_staff_id IN ${client(ids)}
                  OR (entity_type = 'staff' AND entity_id IN ${client(ids)})`;
    await client`DELETE FROM staff WHERE id IN ${client(ids)}`;
  }
  await closeDb();
});

const create = (token, body) =>
  asToken(token).post("/api/admin", { first_name: "Temp", surname: "Person", roles: [2], ...body });

describe("a new account with a password", () => {
  test("signs in with it, and can do nothing but choose its own until it does", async () => {
    const email = emailOf("new");
    const res = await create(superAdmin.accessToken, { email, password: "Welcome123" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.passwordSet, true);
    assert.equal(res.body.data.mustChangePassword, true);

    const row = await staffRepo.findByEmail(email);
    assert.equal(row.passwordResetToken, null, "no invitation link is made");

    const first = await login(email, "Welcome123");
    assert.equal(first.status, 200);
    assert.equal(first.body.data.user.mustChangePassword, true);
    const token = first.body.data.accessToken;

    const blocked = await asToken(token).get("/api/staff-messages/unread-count");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");

    const changed = await asToken(token).post("/api/admin/me/password", {
      current_password: "Welcome123", new_password: "MyOwnPass99",
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const again = await login(email, "MyOwnPass99");
    assert.equal(again.body.data.user.mustChangePassword, false);
    assert.equal((await asToken(again.body.data.accessToken).get("/api/staff-messages/unread-count")).status, 200);
  });

  test("not temporary when the super admin says so", async () => {
    const email = emailOf("kept");
    const res = await create(superAdmin.accessToken, { email, password: "KeepThis123", must_change_password: false });
    assert.equal(res.status, 201);
    const first = await login(email, "KeepThis123");
    assert.equal(first.body.data.user.mustChangePassword, false);
    assert.equal((await asToken(first.body.data.accessToken).get("/api/staff-messages/unread-count")).status, 200);
  });

  test("without one, the invitation goes as before", async () => {
    const email = emailOf("invite");
    const res = await create(superAdmin.accessToken, { email });
    assert.equal(res.status, 201);
    const row = await staffRepo.findByEmail(email);
    assert.equal(row.isPasswordSet, false);
    assert.ok(row.passwordResetToken, "an invitation link is made");
    assert.equal(row.mustChangePassword, false);
  });

  test("a short password is refused", async () => {
    const res = await create(superAdmin.accessToken, { email: emailOf("short"), password: "abc" });
    assert.equal(res.status, 400);
  });
});

describe("a super admin setting somebody's password", () => {
  test("only a super admin, and not on their own account", async () => {
    const target = await staffTokenWithRoles(["finance"], emailOf("target1"));
    const url = `/api/admin/${target.staff.id}/password`;
    assert.equal((await asToken(admin.accessToken).post(url, { password: "Temporary1" })).status, 403);
    assert.equal(
      (await asToken(superAdmin.accessToken).post(`/api/admin/${superAdmin.staff.id}/password`, { password: "Temporary1" })).status,
      400,
    );
    assert.equal((await asToken(superAdmin.accessToken).post(url, { password: "short" })).status, 400);
  });

  test("ends their sessions, makes them choose their own, and is audited without the password", async () => {
    const target = await staffTokenWithRoles(["finance"], emailOf("target2"));
    const old = target.accessToken;
    assert.equal((await asToken(old).get("/api/staff-messages/unread-count")).status, 200);

    const res = await asToken(superAdmin.accessToken).post(`/api/admin/${target.staff.id}/password`, { password: "Temporary1" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.mustChangePassword, true);

    assert.equal((await asToken(old).get("/api/staff-messages/unread-count")).status, 401, "old session ended");

    const signedIn = await login(emailOf("target2"), "Temporary1");
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.data.user.mustChangePassword, true);

    const [audit] = await client`
      SELECT metadata FROM audit_logs
       WHERE entity_type = 'staff' AND entity_id = ${String(target.staff.id)} AND action = 'staff.password_set'
       ORDER BY id DESC LIMIT 1`;
    assert.ok(audit);
    assert.doesNotMatch(JSON.stringify(audit.metadata), /Temporary1/);
  });

  test("a reset link chosen password also frees them", async () => {
    const target = await staffTokenWithRoles(["finance"], emailOf("target3"));
    await asToken(superAdmin.accessToken).post(`/api/admin/${target.staff.id}/password`, { password: "Temporary1" });
    const crypto = require("crypto");
    const raw = crypto.randomBytes(16).toString("hex");
    await staffRepo.update(target.staff.id, {
      passwordResetToken: crypto.createHash("sha256").update(raw).digest("hex"),
      passwordResetExpires: new Date(Date.now() + 60_000),
    });
    const set = await request(app).post("/api/auth/set-password").send({ token: raw, password: "FromTheLink1" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const signedIn = await login(emailOf("target3"), "FromTheLink1");
    assert.equal(signedIn.body.data.user.mustChangePassword, false);
  });
});
