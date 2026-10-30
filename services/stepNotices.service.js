const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { notify } = require("../notifications");
const { officersFor, DESKS } = require("../notifications/deskOfficers");
const { generateOrderReference } = require("../utils/helpers");
const gantryRegister = require("../lib/gantryTicketRegister");
const pfiDesks = require("../lib/pfiDesks");

/**
 * The texts that follow an order, and a truck sale, from move to move.
 *
 * Each function here is called by the code that made the move, AFTER the move
 * is written. The wording lives in the catalog (deskSteps, deliverySms); this
 * file only decides who hears what, and gathers the facts the wording needs.
 *
 * A step texts somebody only when they have something to do next, and only
 * whoever holds that job on the PFI (notifications/deskOfficers.js). The owner,
 * 30 Oct 2026: too many messages. Telling someone what has already happened, or
 * what they just did themselves, is not a reason to send one.
 *
 *   Orders       placed     → finance on the PFI: confirm the payment
 *                released   → ticketing: write the tickets
 *                ticketed   → the entrance gate: expect these trucks
 *                first in   → the exit gate: trucks are on the yard
 *
 *   Truck sales  loaded     → truck sales: sell them
 *                sold       → each customer: what you bought, where to pay;
 *                             the driver: every drop
 *                customer   → the driver: who you deliver to; the customer: your truck
 *                payment    → the customer: payment confirmed, once per save
 *
 * A customer with the app also sees trucks ticketed and trucks leaving there;
 * those are not texts (the catalog's channels).
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
      SELECT o.id, o.pfi_id AS "pfiId", o.quantity,
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
const toDesk = async (type, ctx, desk, extra = {}) => {
  const to = await officersFor({ pfiId: ctx.pfiId, desk });
  if (!to.length) return;
  await notify(type, { to, data: { ...ctx.data, ...extra } });
};

/** An order has been placed: finance confirms its payment. */
const orderPlaced = (orderId) =>
  later("orderPlaced", async () => {
    const ctx = await orderContext(orderId);
    if (!ctx) return;
    await toDesk("desk.order_to_confirm", ctx, DESKS.finance, {
      awaitingPrice: ctx.pricingStatus === "pending",
    });
  });

/**
 * An order arrived at a status. Called by the state machine for every move
 * (orderStatus.service announce), so every path — payment, credit release, the
 * gate — tells the desks the same way. Only a release gives a desk work.
 *
 * Loading is not here: the move into it is the ticketing call, which knows
 * the trucks and says so itself (ticketsWritten).
 */
const orderArrived = (orderId, status, { ticketsWithPayment = false } = {}) =>
  later(`orderArrived:${status}`, async () => {
    if (status !== "Released") return;
    const ctx = await orderContext(orderId);
    if (!ctx) return;

    if (hasDesks(ctx)) {
      await toDesk("desk.order_to_ticket", ctx, DESKS.tickets);
    }
    // Not when its tickets were picked with the payment: it is already done.
    if (!ticketsWithPayment && ctx.pfiType === "gantry" && (await gantryRegister.isOn(ctx.pfiId))) {
      await toDesk("desk.order_to_stock", ctx, DESKS.stock);
    }
  });

/**
 * Tickets were written for some of an order's trucks.
 *
 * One text to the entrance gate listing them, and a notice in the customer's
 * app. `loads` are the order_trucks rows this call wrote or re-ticketed.
 */
const ticketsWritten = (orderId, loads = []) =>
  later("ticketsWritten", async () => {
    if (!loads.length) return;
    const ctx = await orderContext(orderId);
    if (!ctx) return;

    const plates = loads.map((l) => l.truckNumber);

    if (hasDesks(ctx)) {
      await toDesk("desk.trucks_to_admit", ctx, DESKS.gateIn, { plates, truckCount: loads.length });
    }
    if (ctx.customerId) {
      await notify("order.trucks_ticketed", {
        to: { customerId: ctx.customerId },
        data: { ...ctx.data, plates, truckCount: loads.length },
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
    await toDesk("desk.trucks_on_yard", ctx, DESKS.gateOut, { truckNumber: load?.truckNumber || "" });
  });

/** A truck left the depot: a notice in its customer's app, per truck. */
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
             p.pfi_number AS "pfiNumber",
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
 * Trucks were loaded onto a batch: the people who sell it get one text per
 * batch listing them. The batch's PFI is the one holding its code, else the one
 * its loads were drawn from (lib/pfiDesks.js).
 */
const trucksLoaded = (inventoryIds = []) =>
  later("trucksLoaded", async () => {
    const loads = await loadsWithDrivers(inventoryIds);
    if (!loads.length) return;

    const batches = new Map();
    for (const l of loads) {
      const key = `${l.pfiId ?? ""}|${l.allocationCode || ""}`;
      batches.set(key, [...(batches.get(key) || []), l]);
    }
    for (const group of batches.values()) {
      const first = group[0];
      const [batch] = await pfiDesks.listDesks([first.allocationCode]);
      const to = await officersFor({ pfiId: batch?.pfiId ?? first.pfiId, desk: DESKS.truckSales });
      if (!to.length) continue;
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

/** The customer hears their payment on a truck is confirmed. */
const tellPaymentConfirmed = async (sale, amount, subject) => {
  const phone = await deliveryCustomerPhone(sale.customerId);
  if (!phone) return;
  await notifyOnce(subject, "delivery.payment_confirmed", {
    to: { phone, name: sale.customerName || "" },
    data: {
      saleId: sale.id,
      amount,
      truckNumber: sale.truckNumber,
      customerName: sale.customerName || "",
      allocationCode: sale.allocationCode || "",
    },
  });
};

/**
 * Sale rows were written on trucks.
 *
 * A row matched to a bank statement line is finance confirming the money — the
 * Confirm button on Pending Payments is that match — so the customer hears, one
 * text however many lines the save matched. A row with a customer and no money
 * puts that customer on the truck. A deposit keyed in by hand is not confirmed
 * yet (depositConfirmed). Transfers between trucks and expense rows move
 * nothing anybody needs telling about.
 */
const salesRecorded = (sales = []) =>
  later("salesRecorded", async () => {
    const confirmed = new Map();

    for (const sale of sales) {
      if (!sale || sale.transferGroupId) continue;
      if (Number(sale.expensesAmount || 0) > 0) continue;

      const load = await loadForSale(sale);
      if (!load) continue;

      const amount = Number(sale.paymentAmount || 0);
      if (amount > 0) {
        if (!sale.statementLineId) continue;
        const key = `${load.id}|${sale.customerId || ""}`;
        const so = confirmed.get(key) || { sale, amount: 0, ids: [] };
        confirmed.set(key, { ...so, amount: so.amount + amount, ids: [...so.ids, sale.id] });
      } else if (sale.customerId) {
        const customerPhone = await deliveryCustomerPhone(sale.customerId);
        // One subject per truck and customer.
        const subject = `${load.id}|${sale.customerId}`;
        const base = {
          inventoryId: load.id,
          truckNumber: load.truckNumber,
          customerName: sale.customerName || "",
          customerPhone,
          driverName: load.driverName,
          driverPhone: load.driverPhone,
          allocationCode: load.allocationCode || sale.allocationCode || "",
        };
        if (load.driverPhone) {
          await notifyOnce(subject, "delivery.assigned_driver", { to: { phone: load.driverPhone, name: load.driverName }, data: base });
        }
        if (customerPhone) {
          await notifyOnce(subject, "delivery.assigned_customer", { to: { phone: customerPhone, name: sale.customerName }, data: base });
        }
      }
    }

    for (const { sale, amount, ids } of confirmed.values()) {
      await tellPaymentConfirmed(sale, amount, ids.join(","));
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
 * A truck was sold from the Sell truck dialog. Each customer — one of our own
 * stations included — hears what they bought and where to pay; the driver
 * once, with every drop. Only the lines just sold — a second customer added
 * later is news to them, not to the first.
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
  });

/**
 * A deposit keyed in by hand was marked received: the customer hears. One
 * matched to a statement line was told when it was matched (salesRecorded).
 */
const depositConfirmed = (sale) =>
  later("depositConfirmed", async () => {
    if (!sale || sale.statementLineId || Number(sale.paymentAmount || 0) <= 0) return;
    await tellPaymentConfirmed(sale, sale.paymentAmount, sale.id);
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
