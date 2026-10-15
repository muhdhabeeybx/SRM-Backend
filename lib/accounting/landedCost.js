const { sql } = require("drizzle-orm");
const { BILLED_ON_OWN_QUANTITY } = require("../pfiFinance");
const { familyOf } = require("../pfiFamily");

/**
 * What a litre of each PFI's product cost us, landed — the owner's choice
 * (14 Oct 2026): the cargo costs that are part of the product's cost go into
 * its stock value, and reach profit only as the litres are sold.
 *
 *   a cargo           (what was paid for the product + its cargo costs that
 *                     go into stock) ÷ the litres landed in the tank.
 *                     What was paid is its billed quantity × its unit price —
 *                     the BL for a coastal cargo, its own quantity otherwise
 *                     (lib/pfiFinance). Dividing by the tank, not the BL, puts
 *                     what was lost on the way into the cost of what arrived.
 *   a trucking batch  drawn off a cargo (PFI-47B off PFI/47): that cargo's
 *                     cost per litre, plus its own costs over its own litres.
 *                     Its litres are the cargo's stock, so selling them takes
 *                     the cargo's stock down. A batch whose cargo cannot be
 *                     told is costed at its own rate.
 *
 * Which costs go in is each account's `into_stock` (0081) — on for freight,
 * jetty, survey, clearing, insurance; off for customer commission.
 *
 * The figure is today's, so a cost approved late changes what earlier sales
 * cost — and the posting engine books that change, late where the month is
 * closed. That is what makes a PFI's profit true once all its costs are in.
 */

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const rowsOf = (r) => r.rows ?? r;

async function landedCosts(db) {
  const pfis = rowsOf(await db.execute(sql`
    SELECT id, pfi_number, pfi_type::text AS pfi_type, unit_price::numeric AS price,
           bl_qty_litres::numeric AS bl, starting_qty_litres::numeric AS tank,
           parent_pfi_id, created_at
      FROM pfis`));
  // Exactly what postingSources/expenses.js books into Stock for each bill —
  // the same rows, the same naira, VAT and WHT rounded to the kobo the same
  // way — so a cargo sold to its last litre leaves nothing in Stock.
  const extras = rowsOf(await db.execute(sql`
    SELECT e.pfi_id,
           SUM(x.owed + ROUND(COALESCE(e.wht_deduction, 0) * x.rate, 2)
               + CASE WHEN e.vat_withheld THEN ROUND(COALESCE(e.vat_amount, 0) * x.rate, 2) ELSE 0 END) AS extras
      FROM pfi_expenses e
      JOIN expense_categories c ON c.id = e.category_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN 1 ELSE e.exchange_rate END AS rate,
               COALESCE(e.amount_ngn, CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN e.amount END) AS owed
      ) x
     WHERE e.deleted_at IS NULL AND e.pfi_id IS NOT NULL
       AND e.status IN ('admin_approved', 'paid') AND c.into_stock AND NOT COALESCE(c.is_refund, false)
       -- Commission money is handed to staff, never into stock (0084).
       AND c.system_key IS DISTINCT FROM 'customer_commission'
       -- Bought something kept (0088): an asset, not part of the product.
       AND NOT EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.expense_id = e.id AND fa.deleted_at IS NULL)
       AND x.owed IS NOT NULL AND x.rate IS NOT NULL
     GROUP BY e.pfi_id`));
  const extraOf = new Map(extras.map((r) => [Number(r.pfi_id), num(r.extras)]));
  const byId = new Map(pfis.map((p) => [Number(p.id), p]));

  // A trucking batch's cargo: its recorded parent, else the cargo of the same
  // number with no letter, raised before it.
  const cargos = pfis.filter((p) => p.pfi_type !== "trucking" && familyOf(p.pfi_number)?.letter === "");
  const cargoOf = (p) => {
    if (p.parent_pfi_id != null && byId.has(Number(p.parent_pfi_id))) return byId.get(Number(p.parent_pfi_id));
    const fam = familyOf(p.pfi_number);
    if (!fam || !fam.letter) return null;
    const same = cargos
      .filter((c) => familyOf(c.pfi_number)?.serial === fam.serial && new Date(c.created_at) <= new Date(p.created_at))
      .sort((a, b) => Number(b.id) - Number(a.id));
    return same[0] || null;
  };
  const isBatch = (p) => p.pfi_type === "trucking" && !!cargoOf(p);

  const own = (p) => {
    const tank = num(p.tank);
    const billedQty = BILLED_ON_OWN_QUANTITY.has(p.pfi_type) ? tank : num(p.bl);
    const bought = billedQty * num(p.price);
    const extra = extraOf.get(Number(p.id)) || 0;
    return {
      bought,
      extras: extra,
      litres: tank,
      perLitre: tank > 0 ? (bought + extra) / tank : num(p.price),
    };
  };

  const out = new Map();
  for (const p of pfis) {
    const id = Number(p.id);
    if (isBatch(p)) {
      const cargo = cargoOf(p);
      const base = own(cargo);
      const extra = extraOf.get(id) || 0;
      const tank = num(p.tank);
      out.set(id, {
        pfiId: id, stockPfiId: Number(cargo.id), isBatch: true, bought: 0, extras: extra, litres: tank,
        perLitre: base.perLitre + (tank > 0 ? extra / tank : 0),
      });
    } else {
      out.set(id, { pfiId: id, stockPfiId: id, isBatch: false, ...own(p) });
    }
  }
  return out;
}

/** Cached for one posting run: every source that needs a cost reads the same one. */
const landedCostsFor = async (db, ctx) => {
  if (!ctx.landedCosts) ctx.landedCosts = await landedCosts(db);
  return ctx.landedCosts;
};

module.exports = { landedCosts, landedCostsFor };
