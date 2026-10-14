/**
 * Link old expenses to the vendors they name.
 *
 *   node scripts/link-expense-vendors.js            dry run: what would be linked, and what cannot be
 *   node scripts/link-expense-vendors.js --apply    link them
 *
 * The rule is services/vendorLinks.service.js — the one the Vendors page
 * offers Finance as "Link them". Only blanks are filled, no vendor is created,
 * and each link is written to the expense's own audit.
 *
 * Reads and writes DATABASE_URL — check which database .env names before
 * --apply.
 */
require("dotenv").config();
const links = require("../services/vendorLinks.service");

const APPLY = process.argv.includes("--apply");

(async () => {
  const p = await links.preview();
  console.log(`${p.unlinked} expenses name a vendor but are linked to none (${p.unlinkedApproved.count} approved or paid, ₦${p.unlinkedApproved.amount.toLocaleString("en-NG")}).`);
  console.log(`${p.matched} name a saved vendor and can be linked.`);
  console.log("Names that match no saved vendor — add these on Vendors to link them:");
  for (const u of p.unmatchedNames) console.log(`  ${String(u.count).padStart(4)}  ${u.name}  (₦${Math.round(u.amount).toLocaleString("en-NG")})`);

  if (!APPLY) {
    console.log("\nDry run — nothing changed. Run again with --apply to link them.");
    process.exit(0);
  }
  const { linked } = await links.apply({ actorName: "Vendor link script" });
  console.log(`\nLinked ${linked} expenses to their vendors.`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
