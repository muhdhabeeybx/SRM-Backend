const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const misc = require("../schemas/misc.schema");

/**
 * The PFI list's Type filter takes every kind of PFI that can be raised. When
 * it did not, the PFI page's Trucking filter answered 400 before the query ran.
 */
describe("the PFI list's type filter", () => {
  test("takes every type a PFI can be raised as", () => {
    for (const type of ["coastal", "gantry", "delivery", "trucking"]) {
      assert.ok(misc.updatePfi.safeParse({ pfiType: type }).success, `${type} cannot be written`);
      const r = misc.listPfis.safeParse({ type, limit: "1000" });
      assert.ok(r.success, `${type}: ${JSON.stringify(r.error?.issues)}`);
      assert.equal(r.data.type, type);
    }
  });

  test("and still refuses a type nobody can raise", () => {
    assert.equal(misc.listPfis.safeParse({ type: "teleport" }).success, false);
    assert.equal(misc.updatePfi.safeParse({ pfiType: "teleport" }).success, false);
  });
});
