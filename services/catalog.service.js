const { sql, eq, gt } = require("drizzle-orm");
const { db } = require("../config/db");
const { depots, products, depotProductPrices, pfis } = require("../db/schema");

/**
 * The short trade code a product is known by on the floor — PMS, AGO, LPG.
 *
 * This used to be read straight off `products.category`, because that column
 * literally held "PMS (Premium Motor Spirit)". Normalising categories on
 * 2026-08-09 replaced those with real classifications, so every catalog client
 * started showing "Fuel" where it had shown "PMS": the mobile app rendered a
 * product called Petrol with a badge reading Fuel, while order history — which
 * reads name and sku separately — still said Petrol. Same product, two answers,
 * depending on the screen.
 *
 * `sku` is where the trade code actually lives, so that is what this reads.
 * The hyphen is stripped because clients key their product metadata on JETA1,
 * not JET-A1, and `initials(name)` is the last resort for a product whose sku
 * was never filled in — "Cooking Gas" is a better badge than an empty one.
 */
const tradeCode = (product) => {
  const sku = String(product?.sku || "").trim();
  if (sku) return sku.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  return String(product?.name || "")
    .split(/\s+/)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase()
    .slice(0, 4);
};

/**
 * The single definition of "orderable" — shared by every sales channel.
 *
 * The WhatsApp engine and the portal must never disagree about what can be
 * bought where and at what price, so both load through here.
 *
 * The rule is a PRICE, and only a price: a depot sells a product when someone
 * has set a figure above zero against it. Stock used to gate this too — a
 * depot with no active PFI was filtered out entirely — which meant a depot
 * created and priced in the admin stayed invisible on the site, in the
 * snapshot and in the order flow, with nothing on screen to say why. Stock is
 * still measured and still reserved when it exists (see placeOrder), it just
 * no longer decides what may be advertised or bought.
 */

/** All depots carrying a price, each with its priced products. */
const loadCatalog = async () => {
  const [depotRows, priceRows, stockRows] = await Promise.all([
    db.select({ id: depots.id, name: depots.name, state: depots.state }).from(depots),
    db
      .select({
        depotId: depotProductPrices.depotId,
        productId: depotProductPrices.productId,
        price: depotProductPrices.currentPrice,
        name: products.name,
        unit: products.unit,
        sku: products.sku,
        category: products.category,
      })
      .from(depotProductPrices)
      .innerJoin(products, eq(products.id, depotProductPrices.productId))
      .where(gt(depotProductPrices.currentPrice, "0")),
    // Sellable stock = active PFIs' remaining litres, per depot × product —
    // the same pool placeOrder reserves from.
    db
      .select({
        depotId: pfis.locationId,
        productId: pfis.productId,
        stock: sql`sum(${pfis.startingQtyLitres} + ${pfis.evacuationSurplusLitres} - ${pfis.soldQtyLitres})`.mapWith(Number),
      })
      .from(pfis)
      .where(eq(pfis.status, "active"))
      .groupBy(pfis.locationId, pfis.productId),
  ]);

  const stockByKey = new Map(stockRows.map((r) => [`${r.depotId}:${r.productId}`, r.stock]));

  return depotRows
    .map((depot) => ({
      id: depot.id,
      name: depot.name,
      state: depot.state,
      products: priceRows
        .filter((p) => p.depotId === depot.id)
        .map((p) => ({
          id: p.productId,
          name: p.name,
          sku: p.sku || "",
          // The badge every sales channel shows beside the name: PMS, AGO, LPG.
          code: tradeCode(p),
          // Legacy alias. Clients read `category` for the badge today, from when
          // the category column held the trade code, so it keeps carrying the
          // code rather than "Fuel" — that way this fix needs no coordinated
          // client release. New code should read `code`; this can go once the
          // shipped mobile builds have aged out.
          category: tradeCode(p),
          unit: p.unit || "Liters",
          price: Number(p.price),
          // Still carried: order placement reserves against it where it
          // exists. Nothing gates a sale on it any more — the WhatsApp engine
          // capped a quantity by it until the same change reached that channel
          // too. Zero means "no active PFI recorded", not "not for sale".
          stock: stockByKey.get(`${p.depotId}:${p.productId}`) || 0,
        })),
    }))
    // A depot with no priced product has nothing to sell and stays out.
    .filter((depot) => depot.products.length > 0);
};

/**
 * The catalog as the public may see it: names, states, and prices — never
 * litres. Stock levels are commercial information (the WhatsApp copy refuses
 * to reveal them even when a quantity is over stock), so the internal `stock`
 * field stops here — an exact number would tell competitors how much we hold.
 * Being listed means a price is set, which is now the whole of the rule.
 */
const publicCatalog = async () => {
  const catalog = await loadCatalog();
  return catalog.map((depot) => ({
    ...depot,
    products: depot.products.map(({ stock, ...product }) => product),
  }));
};

module.exports = { loadCatalog, publicCatalog, tradeCode };
