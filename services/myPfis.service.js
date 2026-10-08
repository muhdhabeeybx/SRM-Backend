const { client } = require("../config/db");
const { pfiRepo, pfiExpenseRepo, pfiFileRepo } = require("../repositories");
const { computeFinancials } = require("../lib/pfiFinance");
const { DESKLESS_PFI_TYPES } = require("./order.service");

/**
 * The PFIs a staff member is assigned to, as their dashboard shows them.
 *
 * Litres, counts and bank accounts — never money. Cost, price, value, expenses
 * and profit are the admins' to read, and they are left out of this payload
 * rather than hidden on the screen, so nothing reaching an officer's browser
 * carries them.
 *
 * ── Where every litre is ───────────────────────────────────────────────────
 *
 *   stock      = sold + awaiting payment + available
 *
 * The same three-way split lib/pfiFinance.js makes, taken from it rather than
 * recomputed, so this card and PFI Tracking cannot disagree about a batch.
 *
 * On a PFI with a loading desk and a gate (coastal), what is sold then moves:
 *
 *   sold  →  loaded (ticket generated)  →  exited (gated out)
 *
 * Each gap is counted off its own rows, never subtracted: exits run slightly
 * ahead of the ticket ledger on some cargoes (a truck may gate out on an
 * order-level ticket), so "loaded minus exited" would be wrong in both
 * directions.
 *
 *   sold, not yet loaded     open paid orders, less what their tickets cover
 *   loaded, not yet exited   trucks ticketed or on the yard, not yet out
 *
 * Gantry and delivery PFIs have no desk and no gate: an order is released the
 * moment it is paid (order.service.js, completeDesklessOrder), so sold and
 * loaded are the same litres and there is nothing to exit. A trucking PFI
 * sells through truck sales, not orders, so every order-based figure on it is
 * structurally zero — the screen reads its delivery batch instead, and this
 * says so by returning null rather than a confident 0.
 */

const num = (v) => Number(v) || 0;

/** Active first, then not started, then closed; newest first within each. */
const STATUS_RANK = { active: 0, not_started: 1, finished: 2 };

const kindOf = (pfiType) => {
  if (pfiType === "trucking") return "trucks";
  if (DESKLESS_PFI_TYPES.includes(pfiType)) return "deskless";
  return "depot";
};

/** Paid orders still open, and how much of each its tickets have not covered. */
const unloadedFor = async (ids) => {
  const rows = await client`
    SELECT o.pfi_id AS "pfiId",
           COUNT(*) FILTER (WHERE o.quantity > COALESCE(m.qty, 0))::int AS orders,
           COALESCE(SUM(GREATEST(o.quantity - COALESCE(m.qty, 0), 0)), 0)::bigint AS litres
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT SUM(qty_litres) AS qty FROM pfi_movements
         WHERE order_id = o.id AND pfi_id = o.pfi_id
      ) m ON true
     WHERE o.pfi_id = ANY(${ids})
       AND o.payment_status = 'Paid'
       AND o.status IN ('Paid', 'Released', 'Loading')
     GROUP BY o.pfi_id`;
  return new Map(rows.map((r) => [Number(r.pfiId), { orders: r.orders, litres: num(r.litres) }]));
};

/** Trucks out of the gate, and trucks ticketed or on the yard but not yet out. */
const trucksFor = async (ids) => {
  const rows = await client`
    SELECT o.pfi_id AS "pfiId",
           COUNT(*) FILTER (WHERE t.status = 'gated_out')::int AS "exitedTrucks",
           COALESCE(SUM(t.quantity) FILTER (WHERE t.status = 'gated_out'), 0)::bigint AS exited,
           COUNT(*) FILTER (WHERE t.status IN ('loaded', 'gated_in'))::int AS "waitingTrucks",
           COALESCE(SUM(t.quantity) FILTER (WHERE t.status IN ('loaded', 'gated_in')), 0)::bigint AS waiting
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
     WHERE o.pfi_id = ANY(${ids})
       AND COALESCE(o.status::text, '') NOT IN ('Cancelled', 'Expired')
     GROUP BY o.pfi_id`;
  return new Map(rows.map((r) => [Number(r.pfiId), r]));
};

/** Distinct customers with a paid order on each PFI. */
const customersFor = async (ids) => {
  const rows = await client`
    SELECT pfi_id AS "pfiId", COUNT(DISTINCT customer_id)::int AS customers
      FROM orders
     WHERE pfi_id = ANY(${ids}) AND payment_status = 'Paid'
     GROUP BY pfi_id`;
  return new Map(rows.map((r) => [Number(r.pfiId), r.customers]));
};

/**
 * @param user the authenticated staff member (req.user)
 * @returns {Promise<{ pfis: object[] }>}
 */
const getMyPfis = async (user) => {
  const ids = [...new Set((user?.scope?.pfiIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return { pfis: [] };

  const rows = await pfiRepo.findByIds(ids);
  if (!rows.length) return { pfis: [] };
  const found = rows.map((p) => Number(p.id));

  const [aggs, unloaded, trucks, customers, banks] = await Promise.all([
    pfiExpenseRepo.aggregatesFor(found),
    unloadedFor(found),
    trucksFor(found),
    customersFor(found),
    pfiFileRepo.banksFor(found),
  ]);

  const pfis = rows.map((pfi) => {
    const id = Number(pfi.id);
    const agg = aggs.get(id) || {};
    const f = computeFinancials(pfi, agg);
    const kind = kindOf(pfi.pfiType);

    // What the stock is spoken for by, and what is genuinely free. Available
    // is floored at zero; a PFI that has taken more orders than it holds says
    // by how much instead of printing a negative stock.
    const committed = f.sold + f.awaitingPayment;
    const sales = kind === "trucks" ? null : {
      sold: f.sold,
      soldOrders: agg.orderCount || 0,
      customers: customers.get(id) || 0,
      awaitingPayment: f.awaitingPayment,
      awaitingOrders: f.awaitingPaymentOrders,
      available: Math.max(0, f.stockQtyLitres - committed),
      oversold: Math.max(0, committed - f.stockQtyLitres),
    };

    const t = trucks.get(id);
    const u = unloaded.get(id);
    const loading = kind !== "depot" ? null : {
      loaded: f.movementQty,
      soldNotLoaded: u?.litres || 0,
      soldNotLoadedOrders: u?.orders || 0,
      loadedNotExited: num(t?.waiting),
      loadedNotExitedTrucks: t?.waitingTrucks || 0,
      exited: num(t?.exited),
      exitedTrucks: t?.exitedTrucks || 0,
    };

    return {
      id,
      pfiNumber: pfi.pfiNumber,
      pfiType: pfi.pfiType,
      status: pfi.status,
      kind,
      productName: pfi.productName || "",
      productUnit: pfi.productUnit || "Litres",
      locationName: pfi.locationName || "",
      allocationCode: (pfi.allocationCode || "").trim().toUpperCase() || null,
      activatedAt: pfi.activatedAt || null,
      stock: {
        landed: f.tankQtyLitres,
        evacuationSurplus: f.evacuationSurplusLitres,
        operationalLoss: f.operationalLossLitres,
        total: f.stockQtyLitres,
      },
      sales,
      loading,
      banks: (banks.get(id) || []).map((b) => ({
        id: b.id,
        bankName: b.bankName,
        accountName: b.accountName,
        accountNumber: b.accountNumber,
        status: b.status,
      })),
    };
  });

  pfis.sort((a, b) =>
    (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) || b.id - a.id
  );
  return { pfis };
};

module.exports = { getMyPfis };
