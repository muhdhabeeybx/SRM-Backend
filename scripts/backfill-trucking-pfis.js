#!/usr/bin/env node
/**
 * Give every delivery batch that has no PFI one of its own.
 *
 * ── What a batch is, and why some have no PFI ─────────────────────────────
 *
 * A delivery batch has never been a row: it is every delivery_inventory row
 * sharing an allocation_code. Batches raised on the delivery desk therefore
 * existed only as a code — no cost, no officers, no bank account, no line in
 * any PFI report. Migration 0045 added the 'trucking' type so a batch raised
 * in the PFI register is a PFI from the start; this brings the older ones up
 * to the same footing.
 *
 * ── Which batches are converted, and which are deliberately not ───────────
 *
 * Only codes whose truck rows point at NO PFI at all. A code whose rows carry
 * a pfi_id is a sub-batch drawn from a cargo that already exists — PFI-14B's
 * trucks were loaded out of PFI/14/26/DANGOTE/COASTAL — and giving it a PFI of
 * its own would double-count that product: once in the coastal cargo it came
 * from, once in a trucking PFI beside it. Those stay as they are and keep
 * naming the cargo they were drawn from.
 *
 * ── What the new PFI says ─────────────────────────────────────────────────
 *
 * Only what the batch itself can prove:
 *   quantity   the sum of what its trucks loaded
 *   price      the product price on its trucks, but ONLY where every costed
 *              truck agrees; otherwise left unpriced, which reads "—" rather
 *              than inventing an average nobody entered
 *   depot      matched to the depot register by name, tokens sorted, because
 *              one depot is typed three ways ("Calabar Soroman Depot",
 *              "Soroman Calabar Depot", "Soroman Depot Calabar")
 *   product    matched to the product register the same way
 *   status     finished where the delivery desk has closed the batch, else
 *              active — it is already trading, so not_started would be a lie
 *
 * sold_qty_litres is set to the whole loaded quantity: this product has left
 * the tank and is on the road, which is what activation does for a trucking
 * PFI raised the new way (see pfi.repository). Without it every "PMS
 * remaining" tile would count product already loaded out.
 *
 * Officers and bank accounts are left empty. Nobody can be named after the
 * fact, and guessing would put a person's name against an approval they never
 * gave — they are filled in from the PFI's own Edit screen.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 * Dry run unless --apply is passed. Every write is in ONE transaction, so a
 * failure halfway leaves nothing behind. Re-running is a no-op: a code that
 * now has a PFI is no longer a code without one.
 *
 * Usage:
 *   node scripts/backfill-trucking-pfis.js                        # dry run
 *   node scripts/backfill-trucking-pfis.js --apply                # writes
 *   DATABASE_URL="postgresql://…/soroman_test" node scripts/…     # elsewhere
 */
require("dotenv").config();
const postgres = require("postgres");

const APPLY = process.argv.includes("--apply");

/** Tokens sorted, so three spellings of one depot compare equal. */
const tokenKey = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/** The trading names a product is written under, mapped to what it is. */
const PRODUCT_ALIASES = [
  [/pms|petrol|premium motor/i, "pms petrol"],
  [/ago|diesel|gas\s*oil/i, "ago diesel"],
  [/lpg|cooking gas|propane/i, "lpg"],
  [/dpk|kerosene/i, "dpk kerosene"],
];

const productKey = (name) => {
  const t = String(name || "").trim();
  for (const [pattern, key] of PRODUCT_ALIASES) if (pattern.test(t)) return key;
  return tokenKey(t);
};

const money = (n) => `₦${Number(n || 0).toLocaleString("en-NG")}`;
const qty = (n) => Number(n || 0).toLocaleString("en-NG");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const host = new URL(url).hostname;
  console.log(`Database: ${host}`);
  console.log(APPLY ? "Mode: APPLY — this writes.\n" : "Mode: dry run — nothing is written.\n");

  const sql = postgres(url, { ssl: url.includes("localhost") ? false : "require" });

  try {
    // Every code, with what its trucks say, and whether a PFI already owns it.
    const batches = await sql`
      SELECT
        upper(trim(di.allocation_code))                     AS code,
        count(*)::int                                       AS trucks,
        sum(di.quantity_allocated)::numeric                 AS volume,
        min(nullif(di.date_allocated, ''))                  AS first_loaded,
        array_agg(DISTINCT nullif(trim(di.depot), ''))      AS depots,
        array_agg(DISTINCT nullif(trim(di.pfi_product), '')) AS products,
        array_agg(DISTINCT di.pfi_id)                       AS pfi_ids,
        array_agg(DISTINCT di.product_price)                AS prices
      FROM delivery_inventory di
      WHERE nullif(trim(di.allocation_code), '') IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `;

    const owned = await sql`
      SELECT id, pfi_number, pfi_type, upper(trim(coalesce(allocation_code, pfi_number))) AS key
      FROM pfis
    `;
    const ownedKeys = new Set(owned.map((p) => p.key));
    const ownerById = new Map(owned.map((p) => [Number(p.id), p]));

    const statuses = await sql`SELECT upper(trim(code)) AS code, status FROM delivery_batches`;
    const statusByCode = new Map(statuses.map((r) => [r.code, r.status]));

    const depots = await sql`SELECT id, name FROM depots`;
    const depotByKey = new Map(depots.map((d) => [tokenKey(d.name), d]));

    const products = await sql`SELECT id, name, COALESCE(unit, 'Litres') AS unit FROM products`;
    const productByKey = new Map();
    for (const p of products) {
      const key = productKey(p.name);
      if (!productByKey.has(key)) productByKey.set(key, p);
    }

    const plan = [];
    const skipped = [];

    for (const b of batches) {
      // A NULL inside an int[] arrives as NaN through this driver, not null,
      // so "no PFI" has to be tested for as "not a real id".
      const pfiIds = (b.pfi_ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
      if (pfiIds.length > 0) {
        // Its own PFI, or the cargo it was drawn from — different facts, and
        // saying "drawn from" about a batch that IS a PFI reads as a mistake.
        const owners = pfiIds.map((id) => ownerById.get(id)).filter(Boolean);
        const isOwnPfi = owners.some((o) => o.key === b.code);
        skipped.push({
          code: b.code,
          why: isOwnPfi
            ? `already its own PFI (#${owners.map((o) => o.id).join(", ")})`
            : `drawn from ${owners.map((o) => o.pfi_number).join(", ") || `PFI ${pfiIds.join(", ")}`}`,
        });
        continue;
      }
      if (ownedKeys.has(b.code)) {
        skipped.push({ code: b.code, why: "already has a PFI of its own" });
        continue;
      }

      const depotName = (b.depots || []).filter(Boolean)[0] || "";
      const productName = (b.products || []).filter(Boolean)[0] || "";
      const depot = depotByKey.get(tokenKey(depotName)) || null;
      const product = productByKey.get(productKey(productName)) || null;

      // One price, or none. An average of disagreeing prices is a figure
      // nobody entered and everybody would then quote.
      // Same NaN-for-NULL caveat as the pfi ids above. A price of 0 is "not
      // entered" here exactly as it is everywhere else in the PFI figures.
      const prices = (b.prices || []).map(Number).filter((p) => Number.isFinite(p) && p > 0);
      const uniquePrices = [...new Set(prices)];
      const unitPrice = uniquePrices.length === 1 ? uniquePrices[0] : null;

      plan.push({
        code: b.code,
        trucks: b.trucks,
        volume: Math.round(Number(b.volume)),
        firstLoaded: b.first_loaded || null,
        depotName,
        depotId: depot?.id ?? null,
        depotResolved: depot?.name ?? null,
        productName,
        productId: product?.id ?? null,
        productResolved: product?.name ?? null,
        productUnit: product?.unit || "Litres",
        unitPrice,
        priceNote:
          uniquePrices.length > 1
            ? `${uniquePrices.length} different product prices on its trucks — left unpriced`
            : uniquePrices.length === 0
              ? "no product price entered yet — left unpriced"
              : null,
        status: statusByCode.get(b.code) === "completed" ? "finished" : "active",
      });
    }

    // ── What it will do ─────────────────────────────────────────────────
    console.log(`${plan.length} batch${plan.length === 1 ? "" : "es"} to convert:\n`);
    for (const p of plan) {
      console.log(`  ${p.code}  ${p.status}`);
      console.log(`    ${p.trucks} trucks · ${qty(p.volume)} ${p.productUnit} · first loaded ${p.firstLoaded || "—"}`);
      console.log(`    depot   "${p.depotName}" → ${p.depotResolved ? `#${p.depotId} ${p.depotResolved}` : "NO MATCH — left unlinked"}`);
      console.log(`    product "${p.productName}" → ${p.productResolved ? `#${p.productId} ${p.productResolved}` : "NO MATCH — left unlinked"}`);
      console.log(`    price   ${p.unitPrice != null ? `${money(p.unitPrice)} per ${p.productUnit.replace(/s$/, "").toLowerCase()} · cargo ${money(p.unitPrice * p.volume)}` : p.priceNote}`);
      console.log("");
    }

    if (skipped.length) {
      console.log("Left alone:");
      for (const s of skipped) console.log(`  ${s.code} — ${s.why}`);
      console.log("");
    }

    if (!APPLY) {
      console.log("Dry run. Re-run with --apply to write.");
      return;
    }
    if (plan.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    // ── Write ───────────────────────────────────────────────────────────
    const written = await sql.begin(async (tx) => {
      const out = [];
      for (const p of plan) {
        const [pfi] = await tx`
          INSERT INTO pfis (
            pfi_number, pfi_type, status, allocation_code,
            location_id, location_name, product_id, product_name, product_unit,
            starting_qty_litres, sold_qty_litres, unit_price, ticket_count,
            pfi_date, review_note
          ) VALUES (
            ${p.code}, 'trucking', ${p.status}, ${p.code},
            ${p.depotId}, ${p.depotResolved || p.depotName}, ${p.productId}, ${p.productResolved || p.productName}, ${p.productUnit},
            ${p.volume}, ${p.volume}, ${p.unitPrice == null ? "0" : String(p.unitPrice)}, ${p.trucks},
            ${p.firstLoaded || null},
            ${"Backfilled from the delivery batch of the same code. Raised before the PFI register covered trucking, so it has no raiser or approver on record."}
          )
          RETURNING id, pfi_number
        `;

        // The batch's trucks now name their PFI, so the two are joined by an
        // id rather than only by a code somebody typed.
        const rows = await tx`
          UPDATE delivery_inventory
          SET pfi_id = ${pfi.id}, pfi_number = ${pfi.pfi_number}, updated_at = now()
          WHERE upper(trim(allocation_code)) = ${p.code} AND pfi_id IS NULL
          RETURNING id
        `;
        out.push({ code: p.code, pfiId: pfi.id, rows: rows.length });
      }
      return out;
    });

    console.log("Written:");
    for (const w of written) {
      console.log(`  ${w.code} → PFI #${w.pfiId}, ${w.rows} truck rows linked`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
