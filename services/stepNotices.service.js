const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { notify } = require("../notifications");
const { officersFor, DESK_ROLES } = require("../notifications/deskOfficers");
const { generateOrderReference } = require("../utils/helpers");
const gantryRegister = require("../lib/gantryTicketRegister");

/**
 * The texts that follow an order, and a truck sale, from move to move.
 *
 * Each function here is called by the code that made the move, AFTER the move
 * is written, and tells whoever is next: the desk's officers on that PFI
 * (notifications/deskOfficers.js), the driver of the truck, the customer. The
 * wording lives in the catalog (deskSteps, deliverySms); this file only decides
 * who hears what, and gathers the facts the wording needs.
 *
 *   Orders       placed     → finance on the PFI: confirm the payment
 *                released   → ticketing: write the tickets
 *                ticketed   → the entrance gate: expect these trucks
 *                             each driver: your ticket; the customer: trucks ticketed
 *                first in   → the exit gate: trucks are on the yard
 *                truck out  → the customer: this truck has left
 *                completed  → finance and ticketing: every truck is out
 *                cancelled  → finance and ticketing
 *
 *   Truck sales  loaded     → each driver: you are loaded; truck sales: sell them
 *                sold       → each customer: what you bought, where to pay;
 *                             the driver: every drop; finance: money to expect
 *                customer   → the driver: who you deliver to; the customer: your truck
 *                payment    → driver, customer, payer; finance: confirm the deposit
 *                confirmed  → the customer: payment confirmed
 *
 * Gantry and delivery PFIs have no ticketing or gate desks — their orders go
 * straight from payment to Completed (order.service completeDesklessOrder) —
 * so they are told nothing about tickets or gates. The exception is a gantry
 * PFI on a ticket register (from 12 Oct 2026): a released order there waits
 * for the stock officer to pick its gantry tickets, and they are told.
 *
 * EVERY function is fire-and-forget and never throws. The move has already
 * happened; a failed text must not turn it into an error, and a caller must not
 * wait on a phone network to answer its own request.
 */

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);
const DESKLESS_PFI_TYPES = ["gantry", "delivery"];
const hasDesks = (ctx) => !DESKLESS_PFI_TYPES.includes(ctx?.pfiType);

/**
 * Whether this exact text has gone out in the last few minutes.
 *
 * The screens write a truck's share as several rows — a customer moved on a
 * truck patches every one of them — and each write would otherwise text the
 * driver again. Per process, and short: it only has to outlast one save.
 */
const RECENT_MS = 10 * 60 * 1000;
const recent = new Map();
const alreadySent = (key) => {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > RECENT_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
};

/** notify(), unless the same type, person and subject went out just now. */
const notifyOnce = (key, type, opts) => (alreadySent(`${type}|${key}`) ? null : notify(type, opts));

/** Run a notice in the background, logging rather than raising. */
const later = (label, fn) => {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.error(`[stepNotices] ${label} failed:`, err.message));
};

// ─── Orders ─────────────────────────────────────────────────────────────────

/** Everything an order's texts say, in one read. Null when the order is gone. */
const orderContext = async (orderId) => {
  const [row] = rowsOf(
    await db.execute(sql`
      SELECT o.id, o.pfi_id AS "pfiId", o.depot_id AS "depotId", o.quantity,
             o.total_amount AS "totalAmount", o.pricing_status AS "pricingStatus",
             COALESCE(NULLIF(o.company_name, ''), c.company_name) AS "companyName",
             o.customer_id AS "customerId",
             COALESCE(NULLIF(c.name, ''), c.company_name, '') AS "customerName",
             d.name AS "depotName", pr.name AS "product", pr.unit,
             p.pfi_number AS "pfiNumber", COALESCE(p.pfi_type, 'coastal') AS "pfiType"
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN depots d    ON d.id = o.depot_id
        LEFT JOIN products pr ON pr.id = o.product_id
        LEFT JOIN pfis p      ON p.id = o.pfi_id
       WHERE o.id = ${Number(orderId)}
    `)
  );
  if (!row) return null;
  const reference = generateOrderReference(row.companyName, row.id);
  return {
    ...row,
    data: {
      orderId: row.id,
      reference,
      orderNumber: reference,
      customerName: row.customerName || "",
      product: row.product || "",
      unit: row.unit || "Litres",
      quantity: row.quantity,
      totalAmount: row.totalAmount,
      depotName: row.depotName || "",
      pfiNumber: row.pfiNumber || "",
    },
  };
};

/** Tell one desk on the order's PFI. */
const toDesk = async (type, ctx, roles, extra = {}, { adminsLast = true } = {}) => {
  const to = await officersFor({ pfiId: ctx.pfiId, depotId: ctx.depotId, roles, adminsLast });
  if (!to.length) return;
  await notify(type, { to, data: { ...ctx.data, ...extra } });
};

/** An order has been placed: finance confirms its payment. */
const orderPlaced = (orderId) =>
  later("orderPlaced", async () => {
    const ctx = await orderContext(orderId);
    if (!ctx) return;
    await toDesk("desk.order_to_confirm", ctx, DESK_ROLES.finance, {
      awaitingPrice: ctx.pricingStatus === "pending",
    });
  });

/**
 * An order arrived at a status. Called by the state machine for every move
 * (orderStatus.service announce), so every path — payment, credit release,
 * the gate, a cancellation — tells the desks the same way.
 *
 * Loading is not here: the move into it is the ticketing call, which knows
 * the trucks and says so itself (ticketsWritten).
 */
const orderArrived = (orderId, status, { reason, ticketsWithPayment = false } = {}) =>
  later(`orderArrived:${status}`, async () => {
    if (!["Released", "Completed", "Cancelled"].includes(status)) return;
    const ctx = await orderContext(orderId);
    if (!ctx) return;

    if (status === "Released" && hasDesks(ctx)) {
      await toDesk("desk.order_to_ticket", ctx, DESK_ROLES.tickets);
    }
    // Not when its tickets were picked with the payment: it is already done.
    // Stock officers only, never the admins (owner, 20 Oct 2026).
    if (status === "Released" && !ticketsWithPayment && ctx.pfiType === "gantry" && (await gantryRegister.isOn(ctx.pfiId))) {
      await toDesk("desk.order_to_stock", ctx, DESK_ROLES.stock, {}, { adminsLast: false });
    }
    if (status === "Completed" && hasDesks(ctx)) {
      const [{ n = 0 } = {}] = rowsOf(
        await db.execute(sql`SELECT COUNT(*)::int AS n FROM order_trucks WHERE order_id = ${Number(orderId)}`)
      );
      await toDesk("desk.order_completed", ctx, [...DESK_ROLES.finance, ...DESK_ROLES.tickets], { truckCount: n });
    }
    if (status === "Cancelled") {
      await toDesk("desk.order_cancelled", ctx, [...DESK_ROLES.finance, ...DESK_ROLES.tickets], { reason: reason || "" });
    }
  });

/**
 * Tickets were written for some of an order's trucks.
 *
 * One text to the entrance gate listing them, one to the customer, and one to
 * each driver with his own ticket. `loads` are the order_trucks rows this call
 * wrote or re-ticketed.
 */
const ticketsWritten = (orderId, loads = []) =>
  later("ticketsWritten", async () => {
    if (!loads.length) return;
    const ctx = await orderContext(orderId);
    if (!ctx) return;

    const ids = loads.map((l) => Number(l.id)).filter(Number.isFinite);
    const tickets = ids.length
      ? rowsOf(
          await db.execute(sql`
            SELECT order_truck_id AS "loadId", ticket_number AS "ticketNumber"
              FROM tickets WHERE order_truck_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          `)
        )
      : [];
    const ticketOf = new Map(tickets.map((t) => [Number(t.loadId), t.ticketNumber]));
    const plates = loads.map((l) => l.truckNumber);

    if (hasDesks(ctx)) {
      await toDesk("desk.trucks_to_admit", ctx, DESK_ROLES.gateIn, { plates, truckCount: loads.length });
    }
    if (ctx.customerId) {
      await notify("order.trucks_ticketed", {
        to: { customerId: ctx.customerId },
        data: { ...ctx.data, plates, truckCount: loads.length },
      });
    }
    for (const l of loads) {
      if (!l.driverPhone) continue;
      await notify("order.truck_ticketed_driver", {
        to: { phone: l.driverPhone, name: l.driverName || "" },
        data: {
          ...ctx.data,
          loadId: l.id,
          ticketNumber: String(l.manualTicketNumber || "").trim() || ticketOf.get(Number(l.id)) || "",
          truckNumber: l.truckNumber,
          quantity: l.quantity,
        },
      });
    }
  });

/**
 * A truck came through the entrance gate. Only the order's FIRST truck tells
 * the exit gate — one text per order, not one per truck. "First" is no other
 * truck on the order having entered, so a repeated gate-in of the same truck
 * cannot send it twice.
 */
const truckGatedIn = (orderId, load) =>
  later("truckGatedIn", async () => {
    if (!load?.id) return;
    const [{ n = 0 } = {}] = rowsOf(
      await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM order_trucks
         WHERE order_id = ${Number(orderId)} AND id <> ${Number(load.id)}
           AND security_entered_at IS NOT NULL
      `)
    );
    if (n !== 0) return;
    const ctx = await orderContext(orderId);
    if (!ctx || !hasDesks(ctx)) return;
    await toDesk("desk.trucks_on_yard", ctx, DESK_ROLES.gateOut, { truckNumber: load?.truckNumber || "" });
  });

/** A truck left the depot: its customer hears, per truck. */
const truckGatedOut = (orderId, load) =>
  later("truckGatedOut", async () => {
    const ctx = await orderContext(orderId);
    if (!ctx?.customerId || !load) return;
    await notify("order.truck_departed", {
      to: { customerId: ctx.customerId },
      data: {
        ...ctx.data,
        truckNumber: load.truckNumber,
        quantity: load.quantity,
        driverName: load.entryDriverName || load.driverName || "",
        driverPhone: load.entryDriverPhone || load.driverPhone || "",
      },
    });
  });

// ─── Truck sales ────────────────────────────────────────────────────────────

/**
 * The truck and driver behind one load. The driver on the drivers register
 * wins over the free-text name on the truck, which predates it.
 */
const loadsWithDrivers = async (ids) => {
  if (!ids.length) return [];
  return rowsOf(
    await db.execute(sql`
      SELECT di.id, di.pfi_id AS "pfiId", di.allocation_code AS "allocationCode",
             di.truck_number AS "truckNumber", di.depot AS "depotName",
             di.quantity_allocated AS "quantity", di.pfi_product AS "product",
             p.pfi_number AS "pfiNumber", p.location_id AS "depotId",
             COALESCE(NULLIF(dr.phone, ''), NULLIF(ft.driver_phone, ''), '') AS "driverPhone",
             COALESCE(NULLIF(dr.name, ''), NULLIF(ft.driver_name, ''), '') AS "driverName"
        FROM delivery_inventory di
        LEFT JOIN fleet_trucks ft ON ft.id = di.truck_id
        LEFT JOIN drivers dr      ON dr.id = ft.driver_id
        LEFT JOIN pfis p          ON p.id = di.pfi_id
       WHERE di.id IN (${sql.join(ids.map((id) => sql`${Number(id)}`), sql`, `)})
    `)
  );
};

/**
 * Trucks were loaded onto a batch. Each driver is told he is loaded; the truck
 * sales desk on the PFI gets one text per batch listing them.
 */
const trucksLoaded = (inventoryIds = []) =>
  later("trucksLoaded", async () => {
    const loads = await loadsWithDrivers(inventoryIds);
    if (!loads.length) return;

    for (const l of loads) {
      if (!l.driverPhone) continue;
      await notify("delivery.truck_loaded", {
        to: { phone: l.driverPhone, name: l.driverName },
        data: {
          inventoryId: l.id,
          truckNumber: l.truckNumber,
          depotName: l.depotName,
          quantity: l.quantity,
          product: l.product,
          allocationCode: l.allocationCode,
          customerName: "",
        },
      });
    }

    const batches = new Map();
    for (const l of loads) {
      const key = `${l.pfiId ?? ""}|${l.allocationCode || ""}`;
      batches.set(key, [...(batches.get(key) || []), l]);
    }
    for (const group of batches.values()) {
      const first = group[0];
      const to = await officersFor({ pfiId: first.pfiId, depotId: first.depotId, roles: DESK_ROLES.truckSales });
      await notify("desk.trucks_to_sell", {
        to,
        data: {
          allocationCode: first.allocationCode || "",
          depotName: first.depotName || "",
          pfiNumber: first.pfiNumber || "",
          plates: group.map((l) => l.truckNumber),
          truckCount: group.length,
          customerName: "",
        },
      });
    }
  });

/**
 * The load a sale row belongs to: same plate (letters and digits only, as
 * the screens compare them) and, where the row names one, the same batch.
 * The newest wins — a truck that ran the code twice is on its latest trip.
 */
const loadForSale = async (sale) => {
  const plate = String(sale.truckNumber || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!plate) return null;
  const code = String(sale.allocationCode || "").trim().toUpperCase();
  const [row] = rowsOf(
    await db.execute(sql`
      SELECT id FROM delivery_inventory
       WHERE upper(regexp_replace(truck_number, '[^A-Za-z0-9]', '', 'g')) = ${plate}
         AND (${code}::text = '' OR upper(trim(allocation_code)) = ${code}::text)
       ORDER BY created_at DESC LIMIT 1
    `)
  );
  if (!row) return null;
  const [load] = await loadsWithDrivers([row.id]);
  return load || null;
};

const deliveryCustomerPhone = async (customerId) => {
  if (!customerId) return "";
  const [row] = rowsOf(
    await db.execute(sql`SELECT phone_number AS phone FROM delivery_customers WHERE id = ${Number(customerId)}`)
  );
  return row?.phone || "";
};

/**
 * Sale rows were written on trucks.
 *
 * A row with money on it is a payment: the driver learns the product is sold
 * and who to call, the customer and a separate payer learn it is paid, and
 * finance on the PFI is asked to confirm the deposit. A row with a customer and
 * no money puts that customer on the truck. Transfers between trucks and
 * expense rows move nothing anybody needs telling about.
 */
const salesRecorded = (sales = []) =>
  later("salesRecorded", async () => {
    for (const sale of sales) {
      if (!sale || sale.transferGroupId) continue;
      if (Number(sale.expensesAmount || 0) > 0) continue;

      const load = await loadForSale(sale);
      if (!load) continue;

      const amount = Number(sale.paymentAmount || 0);
      const customerPhone = await deliveryCustomerPhone(sale.customerId);
      const payerPhone = String(sale.phoneNumber || "").trim();
      // One subject per truck, customer and kind of news.
      const subject = `${load.id}|${sale.customerId || sale.customerName || ""}|${amount > 0 ? sale.id : "assigned"}`;
      const base = {
        inventoryId: load.id,
        truckNumber: load.truckNumber,
        customerName: sale.customerName || "",
        customerPhone,
        driverName: load.driverName,
        driverPhone: load.driverPhone,
        allocationCode: load.allocationCode || sale.allocationCode || "",
      };

      if (amount > 0) {
        const payer = { ...base, payerName: sale.payerName || sale.customerName || "", payerPhone };
        if (load.driverPhone) {
          await notifyOnce(subject, "delivery.paid_driver", { to: { phone: load.driverPhone, name: load.driverName }, data: payer });
        }
        if (customerPhone) {
          await notifyOnce(subject, "delivery.paid_customer", { to: { phone: customerPhone, name: sale.customerName }, data: payer });
        }
        if (payerPhone && payerPhone !== customerPhone) {
          await notifyOnce(subject, "delivery.paid_payer", { to: { phone: payerPhone, name: sale.payerName }, data: payer });
        }
        const to = await officersFor({ pfiId: load.pfiId, depotId: load.depotId, roles: DESK_ROLES.finance });
        await notifyOnce(subject, "desk.truck_payment", {
          to,
          data: { ...payer, amount, saleId: sale.id, pfiNumber: load.pfiNumber || "" },
        });
      } else if (sale.customerId) {
        if (load.driverPhone) {
          await notifyOnce(subject, "delivery.assigned_driver", { to: { phone: load.driverPhone, name: load.driverName }, data: base });
        }
        if (customerPhone) {
          await notifyOnce(subject, "delivery.assigned_customer", { to: { phone: customerPhone, name: sale.customerName }, data: base });
        }
      }
    }
  });

/**
 * The account a PFI's money goes into, for a customer told where to pay: its
 * first active account, the one the truck invoice prints. Null with none.
 */
const collectionAccount = async (pfiId) => {
  if (pfiId == null) return null;
  const [row] = rowsOf(
    await db.execute(sql`
      SELECT ba.account_name AS "accountName", ba.account_number AS "accountNumber", ba.bank_name AS "bankName"
        FROM bank_accounts ba
       WHERE ba.status = 'Active'
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ba.pfi_ids) = 'array' THEN ba.pfi_ids ELSE '[]'::jsonb END) AS x(pfi_id)
            WHERE x.pfi_id = ${String(pfiId)}
         )
       ORDER BY ba.id
       LIMIT 1
    `)
  );
  return row || null;
};

/**
 * A truck was sold from the Sell truck dialog. Each customer hears what they
 * bought and, when it is priced, where to pay; the driver once, with every
 * drop; finance on the PFI what money to expect, so they confirm each payment
 * on Pending Orders as it lands. Only the lines just sold — a second customer
 * added later is news to them, not to the first.
 */
const truckSold = (inventoryId, sales = []) =>
  later("truckSold", async () => {
    const [load] = await loadsWithDrivers([inventoryId]);
    if (!load || !sales.length) return;

    const account = await collectionAccount(load.pfiId);
    const base = {
      inventoryId: load.id,
      truckNumber: load.truckNumber,
      product: load.product || "",
      allocationCode: load.allocationCode || "",
      driverName: load.driverName,
      driverPhone: load.driverPhone,
    };
    const lines = [];
    for (const s of sales) {
      lines.push({
        customerName: s.customerName || "",
        customerPhone: await deliveryCustomerPhone(s.customerId),
        quantity: Number(s.quantity || 0),
        rate: Number(s.rate || 0),
        value: Number(s.salesValue || 0),
        destination: s.location || "",
      });
    }

    for (const l of lines) {
      if (!l.customerPhone) continue;
      await notify("delivery.sold_customer", {
        to: { phone: l.customerPhone, name: l.customerName },
        data: { ...base, ...l, account },
      });
    }

    if (load.driverPhone) {
      await notify("delivery.sold_driver", {
        to: { phone: load.driverPhone, name: load.driverName },
        data: { ...base, customerName: "", lines },
      });
    }

    const priced = lines.filter((l) => l.value > 0);
    if (!priced.length) return;
    const to = await officersFor({ pfiId: load.pfiId, depotId: load.depotId, roles: DESK_ROLES.finance });
    if (!to.length) return;
    await notify("desk.truck_sold", {
      to,
      data: {
        ...base,
        customerName: "",
        pfiNumber: load.pfiNumber || "",
        saleId: sales[0].id,
        lines: priced,
        total: priced.reduce((sum, l) => sum + l.value, 0),
      },
    });
  });

/** Finance marked a truck payment's deposit as received: the customer hears. */
const depositConfirmed = (sale) =>
  later("depositConfirmed", async () => {
    if (!sale || Number(sale.paymentAmount || 0) <= 0) return;
    const phone = await deliveryCustomerPhone(sale.customerId);
    if (!phone) return;
    await notify("delivery.payment_confirmed", {
      to: { phone, name: sale.customerName || "" },
      data: {
        saleId: sale.id,
        amount: sale.paymentAmount,
        truckNumber: sale.truckNumber,
        customerName: sale.customerName || "",
        allocationCode: sale.allocationCode || "",
      },
    });
  });

module.exports = {
  orderPlaced,
  orderArrived,
  ticketsWritten,
  truckGatedIn,
  truckGatedOut,
  trucksLoaded,
  truckSold,
  salesRecorded,
  depositConfirmed,
};
