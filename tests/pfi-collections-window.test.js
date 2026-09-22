const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const misc = require("../schemas/misc.schema");

/**
 * The window on the credits offered when confirming an order's payment.
 *
 * A field the write schema does not name is a field the API silently discards
 * — validate() strips unknown keys — so these assert on the parsed OUTPUT.
 * See tests/bank-account-usage.test.js for the trap in full.
 */
describe("a PFI's collections window", () => {
  test("survives creating a PFI instead of being stripped", () => {
    const r = misc.createPfi.safeParse({
      pfi_number: "PFI/51/26/TEST",
      collections_open_from: "2026-09-01",
    });
    assert.equal(r.success, true);
    assert.equal(
      r.data.collections_open_from,
      "2026-09-01",
      "the window was stripped — the PFI would be created with no window and nothing would say so",
    );
  });

  test("and survives an update, in either spelling", () => {
    for (const key of ["collections_open_from", "collectionsOpenFrom"]) {
      const r = misc.updatePfi.safeParse({ [key]: "2026-08-15" });
      assert.equal(r.success, true, `${key} was rejected`);
      assert.ok(key in r.data, `${key} was stripped`);
    }
  });

  test("a nonsense date is refused rather than quietly dropped", () => {
    const r = misc.updatePfi.safeParse({ collections_open_from: "not-a-date" });
    assert.equal(r.success, false);
  });
});
