const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { familyOf, memberName, allocationCodeFor, nextLetter, lettersUsed } = require("../lib/pfiFamily");

/**
 * A cargo's trucks take the family's next free letter. The names are the
 * live book's own, separators and all, so the rules are checked against what
 * is actually there.
 */
describe("PFI families — reading serials and letters", () => {
  test("the serial and letter are read through every separator the book uses", () => {
    assert.deepEqual(familyOf("PFI/47/26/MT LESTE/CALABAR/17KT"), { serial: "47", letter: "" });
    assert.deepEqual(familyOf("PFI 36B/26/MT STELLAR/CALABAR"), { serial: "36", letter: "B" });
    assert.deepEqual(familyOf("PFI-41C"), { serial: "41", letter: "C" });
    assert.deepEqual(familyOf("PFI 41C"), { serial: "41", letter: "C" });
    assert.deepEqual(familyOf("pfi/25b/mt bora"), { serial: "25", letter: "B" });
  });

  test("a word after the serial is not a letter", () => {
    // "PFI/8/DANGOTE" — D is the start of a word, not a suffix.
    assert.deepEqual(familyOf("PFI/8/DANGOTE/PMS/FEB23"), { serial: "8", letter: "" });
    assert.equal(familyOf("PFI/10BX/26"), null, "two letters is not a family member");
    assert.equal(familyOf("Dangote allocation"), null);
  });

  test("the new letter goes where the family keeps it", () => {
    assert.equal(memberName("PFI/47/26/MT LESTE/CALABAR/17KT", "C"), "PFI/47C/26/MT LESTE/CALABAR/17KT");
    assert.equal(memberName("PFI 39/26/PMS/MT STELLAR/LIQUID BULK", "B"), "PFI 39B/26/PMS/MT STELLAR/LIQUID BULK");
    // A lettered parent hands its place over rather than stacking.
    assert.equal(memberName("PFI/25B/MT BORA/CALABAR/JUN", "D"), "PFI/25D/MT BORA/CALABAR/JUN");
    assert.equal(allocationCodeFor("47", "C"), "PFI-47C");
  });

  test("the next letter skips every one the family already holds, whatever kind", () => {
    // PFI/25B is coastal and PFI-25C trucking; both hold their letter.
    const names = ["PFI/25/26/MT BORA/AIPEC", "PFI/25B/MT BORA/CALABAR/JUN", "PFI-25C", "PFI/250/X", "PFI-2B"];
    const used = lettersUsed("25", names);
    assert.deepEqual([...used].sort(), ["B", "C"], "250 and 2 are other families");
    assert.equal(nextLetter(used), "D");
    assert.equal(nextLetter([]), "B", "A is the parent itself");
    assert.equal(nextLetter("BCDEFGHIJKLMNOPQRSTUVWXYZ".split("")), null);
  });
});
