// The pages a PFI-confined person is let into anyway, sent with the session so
// the dashboard's menu matches denyPfiScopedUnlessStations / UnlessPlants.
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");

const { pfiScopedOpen } = require("../lib/pfiScope");
const { closeDb } = require("./helpers");

after(closeDb);

describe("pfiScopedOpen", () => {
  test("stations open Filling Stations, plants open LPG Plants", () => {
    // Adetona Saheed, 2026-10-28: 14 PFIs, all 7 stations and 7 plants.
    const scope = { pfiIds: [41, 62], fillingStationIds: [27, 28], lpgStationIds: [3] };
    assert.deepEqual(pfiScopedOpen({ scope }), ["/filing-stations", "/lpg/plants"]);
    assert.deepEqual(pfiScopedOpen({ scope: { pfiIds: [41], fillingStationIds: [27] } }), ["/filing-stations"]);
    assert.deepEqual(pfiScopedOpen({ scope: { pfiIds: [41], lpgStationIds: [3] } }), ["/lpg/plants"]);
  });

  test("nothing given, nothing opened", () => {
    assert.deepEqual(pfiScopedOpen({ scope: { pfiIds: [41] } }), []);
    assert.deepEqual(pfiScopedOpen({}), []);
    assert.deepEqual(pfiScopedOpen(undefined), []);
  });

  test("reads their own reach, not a page's narrowed scope", () => {
    // middleware/pagePfis.js swaps req.user.scope on a page with PFIs of its
    // own and keeps the person's reach in `assigned`.
    const user = { scope: { pfiIds: [41] }, assigned: { scope: { pfiIds: [41], fillingStationIds: [27] } } };
    assert.deepEqual(pfiScopedOpen(user), ["/filing-stations"]);
  });
});
