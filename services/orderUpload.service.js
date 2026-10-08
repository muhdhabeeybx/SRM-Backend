/**
 * Orders uploaded by staff from a list — orders the business already took,
 * entered after the fact to wait for their payment.
 *
 * One list, one PFI. Each row is a date, the customer's name, company and
 * phone, the product, the quantity and the rate. A row may name the customer
 * account outright (`customerId`) instead of a phone — for a list that carries
 * no phone numbers — and `customerCompany` is the company a NEW customer is
 * opened with when the row's company is something else (a truck plate, say). Every order is placed the
 * only way an order is ever made — placeOrder — on that PFI at that rate, so
 * the stock comes off it and the order is in every report like any other. It
 * is then dated to the day the row gives.
 *
 * What makes them different is lib/uploadedOrders.js: they stay Pending and
 * never lapse at the end of the day, because a back-dated order would lapse
 * the moment it was entered. The customer is sent nothing — the order is
 * already known to them.
 *
 * Two steps, always: `plan` reads the list and says what would happen, row by
 * row, writing nothing; `apply` does it. Re-applying the same list is safe —
 * each row's key finds the order it already made.
 */
const crypto = require("crypto");
const { eq } = require("drizzle-orm");
const { db } = require("../config/db");
const { orders } = require("../db/schema");
const { pfiRepo, depotRepo, customerRepo, orderRepo, auditLogRepo } = require("../repositories");
const { toE164 } = require("../utils/phone");
const { lagosToday } = require("../lib/zonedDay");
const { orderKey } = require("../lib/uploadedOrders");
const { sellableQty } = require("../lib/pfiStock");

/** The same product, however the list spells it. */
const PRODUCT_WORDS = [
  ["petrol", ["pms", "petrol", "premium motor spirit", "gasoline"]],
  ["diesel", ["ago", "diesel", "automotive gas oil"]],
  ["lpg", ["lpg", "gas", "cooking gas", "liquefied petroleum gas"]],
  ["kerosene", ["dpk", "kerosene", "hhk"]],
];
const productKind = (name) => {
  const text = String(name || "").trim().toLowerCase();
  if (!text) return "";
  for (const [kind, words] of PRODUCT_WORDS) {
    if (words.some((w) => text === w || text.includes(w))) return kind;
  }
  return text;
};

/** "2026-10-06", "06/10/2026", "6/10/2026" or "06-10-2026" — day first, as the desk writes it. */
function parseDay(raw) {
  const text = String(raw ?? "").trim();
  let y, m, d;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, y, m, d] = match;
  else if ((match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) [, d, m, y] = match;
  else return null;
  const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== day) return null;
  return day;
}

const amount = (raw) => {
  const n = Number(String(raw ?? "").replace(/[₦,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

/** The list's own fingerprint, so the same list re-applied finds the orders it made. */
const batchOf = (pfiId, rows) =>
  crypto.createHash("sha1").update(JSON.stringify([Number(pfiId), rows])).digest("hex").slice(0, 10);

async function loadPfi(pfiId) {
  const pfi = await pfiRepo.findById(pfiId);
  if (!pfi) throw httpError(404, `PFI ${pfiId} not found`);
  if (pfi.status !== "active") throw httpError(409, `${pfi.pfiNumber} is not trading, so no order can be placed on it`);
  if (!pfi.locationId || !pfi.productId) throw httpError(409, `${pfi.pfiNumber} has no location or product`);
  const depot = await depotRepo.findById(pfi.locationId);
  if (!depot) throw httpError(409, `${pfi.pfiNumber}'s location no longer exists`);
  return { pfi, depot };
}

/**
 * What applying the list would do, row by row. Writes nothing.
 *
 * @param {object} args
 * @param {number} args.pfiId
 * @param {Array<{date, name, company, phone, product, qty, rate, deliveryType?}>} args.rows
 */
async function plan({ pfiId, rows }) {
  const { pfi, depot } = await loadPfi(pfiId);
  const today = lagosToday();
  const pfiKind = productKind(pfi.productName);
  const batch = batchOf(pfi.id, rows);

  const planned = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const problems = [];
    const day = parseDay(r.date);
    if (!day) problems.push(`date "${r.date ?? ""}" is not a day (use 2026-10-06 or 06/10/2026)`);
    else if (day > today) problems.push(`${day} is in the future`);

    const name = String(r.name ?? "").trim();
    if (!name) problems.push("no name");
    const company = String(r.company ?? "").trim();
    const customerCompany = r.customerCompany != null ? String(r.customerCompany).trim() : company;
    const namedId = String(r.customerId ?? "").trim();
    const phone = namedId ? null : toE164(String(r.phone ?? "").trim());
    if (!namedId && !phone) problems.push(`phone "${r.phone ?? ""}" is not a phone number`);

    if (productKind(r.product) !== pfiKind) {
      problems.push(`product "${r.product ?? ""}" is not ${pfi.productName} — ${pfi.pfiNumber} sells only that`);
    }
    const qty = amount(r.qty);
    if (!Number.isInteger(qty) || qty <= 0) problems.push(`quantity "${r.qty ?? ""}" must be a whole number above 0`);
    const rate = amount(r.rate);
    if (!(rate > 0)) problems.push(`rate "${r.rate ?? ""}" must be above 0`);
    const deliveryType = String(r.deliveryType || "pickup").trim().toLowerCase();
    if (!["pickup", "delivery"].includes(deliveryType)) problems.push(`delivery type "${r.deliveryType}" must be pickup or delivery`);

    let customer = null;
    if (namedId) {
      const named = /^\d+$/.test(namedId) ? await customerRepo.findById(Number(namedId)) : null;
      if (!named) problems.push(`customer #${namedId} not found`);
      else if (named.houseAccount) problems.push(`customer #${namedId} is the company's own account`);
      else customer = { id: named.id, name: named.name, companyName: named.companyName || "", existing: true };
    } else if (phone) {
      const found = await customerRepo.findByAnyPhone(phone);
      customer = found
        ? { id: found.customer.id, name: found.customer.name, companyName: found.customer.companyName || "", existing: true }
        : { id: null, name, companyName: customerCompany, existing: false };
    }

    const key = orderKey(batch, i + 1);
    const already = await orderRepo.findByIdempotencyKey(key);

    planned.push({
      row: i + 1,
      key,
      day,
      name,
      company,
      phone,
      product: pfi.productName,
      qty,
      rate,
      value: Number.isFinite(qty * rate) ? qty * rate : null,
      deliveryType,
      customer,
      already: already ? { id: already.id, orderNumber: already.orderNumber } : null,
      problems,
    });
  }

  const good = planned.filter((p) => !p.problems.length && !p.already);
  return {
    batch,
    pfi: { id: pfi.id, pfiNumber: pfi.pfiNumber, productName: pfi.productName, sellable: sellableQty(pfi) },
    depot: { id: depot.id, name: depot.name },
    rows: planned,
    summary: {
      rows: planned.length,
      toPlace: good.length,
      already: planned.filter((p) => p.already).length,
      refused: planned.filter((p) => p.problems.length).length,
      newCustomers: new Set(good.filter((p) => !p.customer?.existing).map((p) => p.phone)).size,
      quantity: good.reduce((s, p) => s + p.qty, 0),
      value: good.reduce((s, p) => s + p.value, 0),
    },
  };
}

/** Lagos noon on the given day: the day reads the same in every timezone a screen might use. */
const noonLagos = (day) => new Date(`${day}T12:00:00+01:00`);

/**
 * Place the orders. Only rows with no problem; a row whose order already
 * exists is left as it is. Each order is its own act — one that fails (stock
 * run out, say) is reported and the rest go on.
 */
async function apply({ pfiId, rows, staffId }) {
  if (!staffId) throw httpError(400, "Name the member of staff the upload is entered as");
  // Required here rather than at the top: order.service requires half the app.
  const { placeOrder } = require("./order.service");
  const planned = await plan({ pfiId, rows });
  const { pfi, depot } = await loadPfi(pfiId);
  const actor = { type: "staff", staffId: Number(staffId) };
  const today = lagosToday();
  const customersByPhone = new Map();
  const results = [];

  for (const p of planned.rows) {
    if (p.problems.length) {
      results.push({ row: p.row, outcome: "refused", reason: p.problems.join("; ") });
      continue;
    }
    if (p.already) {
      results.push({ row: p.row, outcome: "already", orderId: p.already.id, orderNumber: p.already.orderNumber });
      continue;
    }
    try {
      let customerId = p.customer.id ?? customersByPhone.get(p.phone) ?? null;
      if (!customerId) {
        const again = await customerRepo.findByAnyPhone(p.phone);
        if (again) {
          customerId = again.customer.id;
        } else {
          const created = await customerRepo.create({
            name: p.name,
            email: "",
            phone: p.phone,
            companyName: p.customer.companyName,
            address: "",
            status: "Active",
            balance: "0",
            deposit: "0",
            previousDeposit: "0",
          });
          customerId = created.id;
          await auditLogRepo.record({
            entityType: "customer",
            entityId: created.id,
            action: "customer.created",
            actor,
            metadata: { name: created.name, phone: created.phone, companyName: created.companyName, via: "order-upload", batch: planned.batch },
          });
        }
        customersByPhone.set(p.phone, customerId);
      }

      const { order } = await placeOrder({
        customerId,
        state: depot.state || depot.city || "",
        depotId: depot.id,
        productId: pfi.productId,
        quantity: p.qty,
        deliveryType: p.deliveryType,
        deliveryAddress: "",
        companyName: p.company,
        actor,
        idempotencyKey: p.key,
        pinned: { pfiId: pfi.id, price: p.rate },
        quiet: true,
      });

      // Dated to the day the row gives. Today's keeps the moment it was entered.
      if (p.day !== today) {
        const placedAt = noonLagos(p.day);
        await db.update(orders).set({ createdAt: placedAt, updatedAt: new Date() }).where(eq(orders.id, order.id));
        await auditLogRepo.record({
          entityType: "order",
          entityId: order.id,
          action: "order.updated",
          actor,
          metadata: { changes: { createdAt: [order.createdAt, placedAt] }, via: "order-upload" },
        });
      }
      await auditLogRepo.record({
        entityType: "order",
        entityId: order.id,
        action: "order.uploaded",
        actor,
        metadata: { batch: planned.batch, row: p.row, day: p.day, pfiId: pfi.id, never_lapses: true },
      });
      results.push({ row: p.row, outcome: "placed", orderId: order.id, orderNumber: order.orderNumber });
    } catch (err) {
      results.push({ row: p.row, outcome: "failed", reason: err.message });
    }
  }

  return { batch: planned.batch, pfi: planned.pfi, results };
}

module.exports = { plan, apply, parseDay, productKind };
