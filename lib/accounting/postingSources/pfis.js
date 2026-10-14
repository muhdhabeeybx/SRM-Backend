const { sql } = require("drizzle-orm");
const { landedCostsFor } = require("../landedCost");

/**
 * Cargo in the general ledger: what was bought, what it cost to sell, and
 * what the tank found or lost against the books. Every litre is valued at its
 * PFI's landed cost (lib/accounting/landedCost) — the product plus the cargo
 * costs that go into stock.
 *
 *   pfi_purchase  a cargo bought, on the day it started trading, at what it
 *                 was billed (its billed quantity × unit price):
 *                   Dr Stock / Cr Cargo supplier payables (the supplier named
 *                   on the PFI, 0083)
 *                 A trucking batch drawn off a cargo is not bought again — its
 *                 litres are the cargo's.
 *   pfi_cogs      what was sold each day off each PFI, per unit and place, at
 *                 the landed cost per litre:
 *                   Dr Cost of product sold (the PFI that sold it)
 *                   Cr Stock (the cargo whose tank it came from)
 *                 The litres are the ones the sales booked (order_sale,
 *                 truck_sale, station_sale), read from the same records.
 *   pfi_surplus   evacuation surplus (0053): Dr Stock / Cr Stock gains
 *   pfi_loss      operational loss (0073):   Dr Stock losses / Cr Stock
 *
 * Cargo costs themselves are booked by expenses.js straight into Stock when
 * their account goes into stock, which is what the landed cost divides.
 */

const rowsOf = (r) => r.rows ?? r;
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);
const unitOf = (type) => (type === "trucking" ? "trucking" : "depot");

async function purchases(db, ctx) {
  const costs = await landedCostsFor(db, ctx);
  const rows = rowsOf(await db.execute(sql`
    SELECT p.id, p.pfi_number, p.pfi_type::text AS pfi_type, p.supplier_vendor_id, p.location_id,
           ${DAY("COALESCE(p.activated_at, p.pfi_date, p.created_at)")} AS day
      FROM pfis p
     WHERE p.status::text IN ('active', 'finished')
  `));
  return rows
    .filter((p) => !costs.get(Number(p.id))?.isBatch && costs.get(Number(p.id))?.bought > 0)
    .map((p) => {
      const value = costs.get(Number(p.id)).bought;
      return {
        id: String(p.id),
        date: p.day,
        memo: `Cargo bought: ${p.pfi_number}`,
        unit: unitOf(p.pfi_type),
        pfiId: Number(p.id),
        location: p.location_id != null ? ["depot", Number(p.location_id)] : null,
        lines: [
          { key: "stock", debit: value },
          { key: "supplier_payables", credit: value, party: p.supplier_vendor_id ? ["vendor", Number(p.supplier_vendor_id)] : null },
        ],
      };
    });
}

/**
 * Cost of sales, from the litres every sale took. The sources that sell are
 * marked `sells` and cache their records for the run, so these are exactly
 * the sales the books hold.
 */
async function costOfSales(db, ctx) {
  const costs = await landedCostsFor(db, ctx);
  const sellers = require("./index").filter((s) => s.sells);
  const groups = new Map();
  for (const source of sellers) {
    for (const r of await source.load(db, ctx)) {
      for (const s of r.sold || []) {
        if (!s.pfiId || !(s.litres > 0)) continue;
        const where = r.location ? r.location.join(":") : "";
        const key = [s.pfiId, r.date, r.unit || "", where].join("|");
        const g = groups.get(key) || { pfiId: s.pfiId, date: r.date, unit: r.unit || null, location: r.location || null, litres: 0 };
        g.litres += s.litres;
        groups.set(key, g);
      }
    }
  }
  return [...groups].map(([key, g]) => {
    const c = costs.get(Number(g.pfiId));
    const value = c ? g.litres * c.perLitre : 0;
    return {
      id: key,
      date: g.date,
      memo: `Cost of ${g.litres.toLocaleString("en-NG", { maximumFractionDigits: 2 })} litres sold`,
      unit: g.unit,
      location: g.location,
      pfiId: g.pfiId,
      lines: [
        { key: "cost_of_product_sold", debit: value },
        { key: "stock", credit: value, pfiId: c ? c.stockPfiId : g.pfiId },
      ],
    };
  });
}

const adjustments = (table, kind) => async (db, ctx) => {
  const costs = await landedCostsFor(db, ctx);
  const rows = rowsOf(await db.execute(sql`
    SELECT a.id, a.qty_litres::numeric AS litres, p.pfi_number,
           p.id AS pfi_id, p.pfi_type::text AS pfi_type, p.location_id,
           COALESCE(to_char(a.recorded_on, 'YYYY-MM-DD'), ${DAY("a.created_at")}) AS day
      FROM ${sql.raw(table)} a JOIN pfis p ON p.id = a.pfi_id
     WHERE a.voided_at IS NULL
  `));
  return rows.map((a) => {
    const c = costs.get(Number(a.pfi_id));
    const value = num(a.litres) * (c ? c.perLitre : 0);
    const stockPfi = c ? c.stockPfiId : Number(a.pfi_id);
    const gain = kind === "surplus";
    return {
      id: String(a.id),
      date: a.day,
      memo: `${gain ? "Evacuation surplus" : "Operational loss"}: ${a.pfi_number}`,
      unit: unitOf(a.pfi_type),
      pfiId: Number(a.pfi_id),
      location: a.location_id != null ? ["depot", Number(a.location_id)] : null,
      lines: gain
        ? [{ key: "stock", debit: value, pfiId: stockPfi }, { key: "stock_gains", credit: value }]
        : [{ key: "stock_losses", debit: value }, { key: "stock", credit: value, pfiId: stockPfi }],
    };
  });
};

module.exports = [
  { type: "pfi_purchase", load: purchases },
  { type: "pfi_cogs", load: costOfSales },
  { type: "pfi_surplus", load: adjustments("pfi_evacuation_surpluses", "surplus") },
  { type: "pfi_loss", load: adjustments("pfi_operational_losses", "loss") },
];
