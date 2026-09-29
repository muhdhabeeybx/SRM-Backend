/**
 * A cargo's family: the PFIs and truck batches that share its serial.
 *
 * Every member of a family carries the serial first in its number, with a
 * letter after it on all but the parent:
 *
 *   PFI/47/26/MT LESTE/CALABAR/17KT     the cargo
 *   PFI 47B                             trucks off it (older, hand-named)
 *   PFI/47C/26/MT LESTE/CALABAR/17KT    trucks off it (allocated)
 *   PFI-47C                             …and that batch's allocation code
 *
 * The separators vary — "/", " ", "-" all occur on the live book — so parsing
 * accepts any run of them. The letters are the family's, not trucking's:
 * PFI/25B is a coastal cargo and PFI-25C a batch of trucks, so a new letter
 * must skip every one already used by anything in the family.
 */

/** "PFI", separators, the serial, an optional letter, then a separator or the end. */
const MEMBER = /^(PFI[\s/-]*)(\d+)([A-Za-z]?)(?=[\s/-]|$)/i;

/** The letters a sub-allocation may take. A is the parent itself. */
const LETTERS = "BCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/**
 * Which family a PFI number or allocation code belongs to.
 *
 * @returns {{ serial: string, letter: string } | null} letter is "" on the parent
 */
function familyOf(value) {
  const m = String(value || "").trim().match(MEMBER);
  if (!m) return null;
  return { serial: String(Number(m[2])), letter: m[3].toUpperCase() };
}

/**
 * The parent's name with the letter put where the family keeps it.
 *
 *   ("PFI/47/26/MT LESTE/CALABAR/17KT", "C") → "PFI/47C/26/MT LESTE/CALABAR/17KT"
 *   ("PFI/25B/MT BORA/CALABAR/JUN", "D")     → "PFI/25D/MT BORA/CALABAR/JUN"
 *
 * A parent that is itself lettered hands its place to the new letter rather
 * than stacking a second one on it: 25B's trucks are 25D, not 25BD.
 */
function memberName(parentNumber, letter) {
  const name = String(parentNumber || "").trim();
  const m = name.match(MEMBER);
  if (!m) return null;
  return `${m[1]}${m[2]}${letter}${name.slice(m[0].length)}`;
}

/** The batch code, in the form the delivery register already uses: "PFI-47C". */
const allocationCodeFor = (serial, letter) => `PFI-${serial}${letter}`;

/**
 * The first letter nobody in the family holds.
 *
 * @param {Iterable<string>} used letters already taken (any case)
 * @returns {string | null} null when B–Z are all gone
 */
function nextLetter(used) {
  const taken = new Set([...used].map((l) => String(l || "").toUpperCase()));
  return LETTERS.find((l) => !taken.has(l)) || null;
}

/**
 * The letters taken in one family, from every name that might carry one.
 *
 * @param {string} serial
 * @param {Iterable<string>} names PFI numbers and allocation codes, any family
 */
function lettersUsed(serial, names) {
  const out = new Set();
  for (const name of names) {
    const f = familyOf(name);
    if (f && f.serial === serial && f.letter) out.add(f.letter);
  }
  return out;
}

module.exports = { familyOf, memberName, allocationCodeFor, nextLetter, lettersUsed, LETTERS };
