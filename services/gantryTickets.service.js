const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const auditLogRepo = require("../repositories/auditLog.repository");
const register = require("../lib/gantryTicketRegister");
const { scopedPfiIds } = require("../lib/pfiBankScope");
const { generateOrderReference } = require("../utils/helpers");
const { stepToCompleted } = require("./order.service");

/**
 * Gantry tickets — the owner's rule of 12 Oct 2026 for gantry PFIs raised from
 * then on (migration 0075, lib/gantryTicketRegister.js for which PFIs):
 *
 *   Enter     the PFI's paper tickets, each number with its litres, before it
 *             is released to trade. The stock officer on the PFI or an admin.
 *   Sell      orders are placed and paid as on any PFI, but only for litres
 *             the tickets still hold (order.service placeOrder), and a paid
 *             order stops at Released instead of completing on payment.
 *   Issue     the stock officer on the PFI (or an admin) picks the tickets the
 *             order is sold on. Their litres must come to the order's
 *             quantity exactly. That writes the stock movement and completes
 *             the order — the same steps payment used to take on its own.
 *   See       every ticket on the PFI: left, or sold on which order to whom.
 *
 * A ticket entered by mistake is taken off (voided), never deleted, and only
 * while unsold. A ticket given to the wrong order is corrected by changing the
 * order's tickets for others of the same total, with a reason; the ones it
 * gave up are left again. Both are on the order's audit trail.
 */

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);
const httpError = (status, message, details) =>
  Object.assign(new Error(message), { status, statusCode: status, ...(details ? { details } : {}) });
const litres = (n) => `${Number(n || 0).toLocaleString("en-NG")} L`;
const MAX_LITRES_PER_TICKET = 100000;
const MAX_TICKETS_PER_ENTRY = 2000;

/** Admins keep every PFI's tickets; a stock officer keeps the ones they are on. */
const MANAGER_ROLES = ["admin", "super_admin"];
const STOCK_ROLE = "stock_officer";

/**
 * Who may open the Gantry Tickets desk — the owner's instruction of 13 Oct
 * 2026: admins, Muideen Salami, and the stock officers.
 *
 * Admins, super admins and stock officers by role; anybody else only by the
 * per-person page grant Manage Users writes (staff_page_overrides — Muideen's
 * is migration 0077). A grant set to "no" shuts the page even to a role that
 * would open it. The dashboard's menu reads the same rule (soromanfe
 * lib/rbac.ts ROLE_OPENED), and the route string must match it exactly.
 *
 * The desk is the only thing closed. A PFI's ticket list and an order's
 * tickets stay on the PFI and order pages, which everyone opens.
 */
const DESK_ROUTE = "/gantry-tickets";
const DESK_ROLES = ["admin", "super_admin", STOCK_ROLE];
const maySeeDesk = (user) => {
  if (!user) return false;
  const override = (user.pageOverrides || []).find((o) => o.routePath === DESK_ROUTE);
  if (override) return Boolean(override.allowed);
  return (Array.isArray(user.roles) ? user.roles : []).some((r) => DESK_ROLES.includes(r));
};

const unavailable = () =>
  httpError(503, "Gantry tickets are not available yet — the database has not been updated for them (migration 0075).");

/**
 * Whether this person may enter, take off and issue tickets on this PFI.
 * Admins anywhere; a stock officer only on a PFI they are assigned to.
 */
const canWork = async (user, pfiId) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  if (roles.some((r) => MANAGER_ROLES.includes(r))) return true;
  if (!roles.includes(STOCK_ROLE) || !user?.id) return false;
  const rows = rowsOf(await db.execute(sql`
    SELECT 1 FROM pfi_staff WHERE pfi_id = ${Number(pfiId)} AND staff_id = ${Number(user.id)}
  `));
  return rows.length > 0;
};

/** The PFIs among these this person may work on — one query, not one per PFI. */
const workableAmong = async (user, pfiIds) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const ids = (pfiIds || []).map(Number);
  if (roles.some((r) => MANAGER_ROLES.includes(r))) return new Set(ids);
  if (!roles.includes(STOCK_ROLE) || !user?.id || !ids.length) return new Set();
  const rows = rowsOf(await db.execute(sql`
    SELECT pfi_id FROM pfi_staff
     WHERE staff_id = ${Number(user.id)}
       AND pfi_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `));
  return new Set(rows.map((r) => Number(r.pfi_id)));
};

const requireWork = async (user, pfiId) => {
  if (!(await canWork(user, pfiId))) {
    throw httpError(403, "Only the stock officer on this PFI, or an admin, can do this.");
  }
};

const ticketShape = (r) => ({
  id: Number(r.id),
  pfiId: Number(r.pfi_id),
  ticketNumber: r.ticket_number,
  qtyLitres: Number(r.qty_litres),
  status: r.voided_at ? "voided" : r.order_id ? "sold" : "left",
  orderId: r.order_id == null ? null : Number(r.order_id),
  orderRef: r.order_id == null ? null : generateOrderReference(r.company_name, Number(r.order_id)),
  customerName: r.order_id == null ? null : r.customer_name || "",
  issuedAt: r.order_id == null ? null : r.issued_at,
  issuedByName: r.order_id == null ? "" : r.issued_by_name || "",
  enteredByName: r.entered_by_name || "",
  createdAt: r.created_at,
  voidedAt: r.voided_at,
  voidedByName: r.voided_by_name || "",
  voidReason: r.void_reason || "",
});

const TICKET_SELECT = sql`
  SELECT t.*,
         COALESCE(NULLIF(o.company_name, ''), c.company_name) AS company_name,
         COALESCE(NULLIF(o.company_name, ''), NULLIF(c.company_name, ''), NULLIF(c.name, ''), '') AS customer_name
    FROM gantry_tickets t
    LEFT JOIN orders o    ON o.id = t.order_id
    LEFT JOIN customers c ON c.id = o.customer_id`;

/** Counts and litres, left and sold. Voided tickets count for nothing. */
const summarise = (tickets) => {
  const live = tickets.filter((t) => t.status !== "voided");
  const left = live.filter((t) => t.status === "left");
  const sold = live.filter((t) => t.status === "sold");
  const sum = (list) => list.reduce((s, t) => s + t.qtyLitres, 0);
  return {
    entered: live.length,
    enteredLitres: sum(live),
    left: left.length,
    leftLitres: sum(left),
    sold: sold.length,
    soldLitres: sum(sold),
    voided: tickets.length - live.length,
  };
};

/**
 * A PFI's tickets, every one, with what it was sold on. `register` false means
 * the PFI is not sold ticket by ticket (a coastal PFI, or a gantry PFI from
 * before the rule), and the list is empty.
 */
const listForPfi = async (pfiId, user = null) => {
  const id = Number(pfiId);
  if (!(await register.isOn(id))) {
    return { register: false, tickets: [], summary: summarise([]), canWork: false, spokenFor: 0 };
  }
  const tickets = rowsOf(await db.execute(sql`
    ${TICKET_SELECT}
     WHERE t.pfi_id = ${id}
     ORDER BY t.id
  `)).map(ticketShape);
  const { spokenFor } = await register.openLitres(id);
  return {
    register: true,
    tickets,
    summary: summarise(tickets),
    // Orders placed and not yet given tickets — what the left tickets are
    // already spoken for.
    spokenFor,
    canWork: user ? await canWork(user, id) : false,
  };
};

const lockPfi = async (tx, pfiId) => {
  const [pfi] = rowsOf(await tx.execute(sql`
    SELECT id, pfi_number, status, pfi_type FROM pfis WHERE id = ${Number(pfiId)} FOR UPDATE
  `));
  if (!pfi) throw httpError(404, "PFI not found");
  return pfi;
};

/** Trim, check and de-duplicate what was typed. Throws naming every bad line. */
const cleanEntries = (entries) => {
  if (!Array.isArray(entries) || !entries.length) throw httpError(400, "Enter at least one ticket.");
  if (entries.length > MAX_TICKETS_PER_ENTRY) {
    throw httpError(400, `Enter at most ${MAX_TICKETS_PER_ENTRY.toLocaleString()} tickets at a time.`);
  }
  const problems = [];
  const seen = new Map();
  const clean = entries.map((e, i) => {
    const ticketNumber = String(e?.ticketNumber ?? "").trim().replace(/\s+/g, " ");
    const qty = Number(e?.qtyLitres);
    const line = `Line ${i + 1}`;
    if (!ticketNumber) problems.push(`${line}: no ticket number`);
    else if (ticketNumber.length > 100) problems.push(`${line}: the ticket number is too long`);
    if (!Number.isInteger(qty) || qty <= 0) problems.push(`${line} (${ticketNumber || "?"}): litres must be a whole number above 0`);
    else if (qty > MAX_LITRES_PER_TICKET) problems.push(`${line} (${ticketNumber}): ${litres(qty)} is more than one ticket can hold`);
    const key = ticketNumber.toUpperCase();
    if (ticketNumber && seen.has(key)) problems.push(`${ticketNumber} is entered twice (lines ${seen.get(key)} and ${i + 1})`);
    else seen.set(key, i + 1);
    return { ticketNumber, qtyLitres: qty };
  });
  if (problems.length) throw httpError(400, problems.slice(0, 8).join("; ") + (problems.length > 8 ? `; and ${problems.length - 8} more` : ""));
  return clean;
};

/** Enter tickets on a PFI. All of them go on, or none do. */
const addTickets = async ({ pfiId, entries, user, actorName = "" }) => {
  if (!(await register.tablesReady())) throw unavailable();
  if (!(await register.isOn(pfiId))) {
    throw httpError(409, "This PFI is not sold ticket by ticket, so it has no ticket list.");
  }
  await requireWork(user, pfiId);
  const clean = cleanEntries(entries);

  return db.transaction(async (tx) => {
    const pfi = await lockPfi(tx, pfiId);
    if (pfi.status === "finished") throw httpError(409, `${pfi.pfi_number} is closed. Its tickets can no longer change.`);

    const numbers = clean.map((e) => e.ticketNumber.toUpperCase());
    const taken = rowsOf(await tx.execute(sql`
      SELECT ticket_number FROM gantry_tickets
       WHERE pfi_id = ${Number(pfi.id)} AND voided_at IS NULL
         AND upper(ticket_number) IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})
    `)).map((r) => r.ticket_number);
    if (taken.length) {
      throw httpError(
        409,
        `Already on ${pfi.pfi_number}: ${taken.slice(0, 10).join(", ")}${taken.length > 10 ? ` and ${taken.length - 10} more` : ""}.`,
        { code: "TICKETS_ALREADY_ENTERED", numbers: taken },
      );
    }

    const staffId = user?.id == null ? null : Number(user.id);
    const values = clean.map((e) => sql`(${Number(pfi.id)}, ${e.ticketNumber}, ${e.qtyLitres}, ${staffId}, ${actorName})`);
    const inserted = rowsOf(await tx.execute(sql`
      INSERT INTO gantry_tickets (pfi_id, ticket_number, qty_litres, entered_by, entered_by_name)
      VALUES ${sql.join(values, sql`, `)}
      RETURNING id, qty_litres
    `));

    await auditLogRepo.record({
      entityType: "pfi",
      entityId: Number(pfi.id),
      action: "pfi.gantry_tickets_entered",
      actor: { type: "staff", staffId },
      metadata: {
        tickets: clean.length,
        litres: clean.reduce((s, e) => s + e.qtyLitres, 0),
        numbers: clean.map((e) => e.ticketNumber),
      },
    }, tx);

    return { added: inserted.length, litres: inserted.reduce((s, r) => s + Number(r.qty_litres), 0), pfiNumber: pfi.pfi_number };
  });
};

/** Take an unsold ticket off the PFI — it was entered by mistake. */
const voidTicket = async ({ pfiId, ticketId, reason, user, actorName = "" }) => {
  if (!(await register.tablesReady())) throw unavailable();
  await requireWork(user, pfiId);
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "Say why the ticket is being taken off.");

  return db.transaction(async (tx) => {
    const pfi = await lockPfi(tx, pfiId);
    const [t] = rowsOf(await tx.execute(sql`
      SELECT * FROM gantry_tickets WHERE id = ${Number(ticketId)} AND pfi_id = ${Number(pfi.id)} FOR UPDATE
    `));
    if (!t) throw httpError(404, "Ticket not found on this PFI");
    if (t.voided_at) throw httpError(409, `Ticket ${t.ticket_number} has already been taken off.`);
    if (t.order_id) throw httpError(409, `Ticket ${t.ticket_number} has been sold. Change the order's tickets instead.`);

    const staffId = user?.id == null ? null : Number(user.id);
    await tx.execute(sql`
      UPDATE gantry_tickets
         SET voided_at = now(), voided_by = ${staffId}, voided_by_name = ${actorName}, void_reason = ${why}
       WHERE id = ${Number(t.id)}
    `);
    await auditLogRepo.record({
      entityType: "pfi",
      entityId: Number(pfi.id),
      action: "pfi.gantry_ticket_voided",
      actor: { type: "staff", staffId },
      metadata: { ticketId: Number(t.id), ticketNumber: t.ticket_number, litres: Number(t.qty_litres), reason: why },
    }, tx);
    return { ticketNumber: t.ticket_number };
  });
};

/** Lock the picked tickets, and refuse unless every one is on the PFI and left. */
const lockPicked = async (tx, { pfiId, ticketIds, orderId = null }) => {
  const ids = [...new Set((ticketIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw httpError(400, "Pick the tickets the order is sold on.");
  const rows = rowsOf(await tx.execute(sql`
    SELECT * FROM gantry_tickets
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
     ORDER BY id
     FOR UPDATE
  `));
  const found = new Map(rows.map((r) => [Number(r.id), r]));
  const problems = [];
  for (const id of ids) {
    const t = found.get(id);
    if (!t || Number(t.pfi_id) !== Number(pfiId)) problems.push(`ticket #${id} is not on this PFI`);
    else if (t.voided_at) problems.push(`${t.ticket_number} was taken off`);
    else if (t.order_id && Number(t.order_id) !== Number(orderId)) problems.push(`${t.ticket_number} is already sold`);
  }
  if (problems.length) throw httpError(409, `These cannot be used: ${problems.join("; ")}. Refresh and pick again.`);
  return ids.map((id) => found.get(id));
};

const lockOrder = async (tx, orderId) => {
  const [o] = rowsOf(await tx.execute(sql`
    SELECT o.id, o.status, o.quantity, o.pfi_id, o.company_name, o.customer_id,
           p.pfi_number, c.company_name AS customer_company
      FROM orders o
      LEFT JOIN pfis p ON p.id = o.pfi_id
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${Number(orderId)}
     FOR UPDATE OF o
  `));
  if (!o) throw httpError(404, "Order not found");
  return o;
};

const refOf = (o) => generateOrderReference(o.company_name || o.customer_company, Number(o.id));

/** The order's tickets, in the order they were entered. */
const ticketsForOrder = async (orderId) => {
  if (!(await register.tablesReady())) return [];
  return rowsOf(await db.execute(sql`
    ${TICKET_SELECT}
     WHERE t.order_id = ${Number(orderId)}
     ORDER BY t.id
  `)).map(ticketShape);
};

/**
 * An order's tickets, with whether its PFI is on a register and whether this
 * person may issue or change them — what the order page needs.
 */
const forOrder = async (orderId, user = null) => {
  if (!(await register.tablesReady())) return { register: false, tickets: [], canWork: false, stage: null };
  const [o] = rowsOf(await db.execute(sql`SELECT pfi_id, status, quantity FROM orders WHERE id = ${Number(orderId)}`));
  if (!o?.pfi_id || !(await register.isOn(o.pfi_id))) return { register: false, tickets: [], canWork: false, stage: null };
  const tickets = await ticketsForOrder(orderId);
  return {
    register: true,
    pfiId: Number(o.pfi_id),
    quantity: Number(o.quantity),
    tickets,
    stage: stageOf(o.status, tickets.length),
    canWork: user ? await canWork(user, o.pfi_id) : false,
  };
};

const requireRegister = async (tx, order) => {
  if (!order.pfi_id || !(await register.isOn(order.pfi_id, tx))) {
    throw httpError(409, "This order's PFI is not sold ticket by ticket.");
  }
};

const refuseIfIssued = async (tx, order, ref) => {
  const already = rowsOf(await tx.execute(sql`SELECT 1 FROM gantry_tickets WHERE order_id = ${Number(order.id)} LIMIT 1`));
  if (already.length) throw httpError(409, `${ref} already has its tickets. Use Change tickets to correct them.`);
};

/** Lock the picked tickets and refuse unless their litres are the order's. */
const pickExact = async (tx, order, ref, ticketIds) => {
  const picked = await lockPicked(tx, { pfiId: order.pfi_id, ticketIds });
  const total = picked.reduce((s, t) => s + Number(t.qty_litres), 0);
  if (total !== Number(order.quantity)) {
    throw httpError(
      409,
      `The tickets picked come to ${litres(total)}; ${ref} is for ${litres(order.quantity)}. They must match exactly.`,
    );
  }
  return { picked, total };
};

/**
 * Issue a released order's tickets inside the caller's transaction, and
 * complete it.
 *
 * Two desks reach this. The stock desk (issue, below) is the stock officer on
 * the PFI or an admin. The payment desk picks the tickets as it matches the
 * money — the owner's instruction of 16 Oct 2026 — and is whoever may confirm
 * a payment, which the payments route gates itself; `withPayment` says so.
 */
const issueWithin = async (tx, { orderId, ticketIds, user, actorName = "", withPayment = false }) => {
  const order = await lockOrder(tx, orderId);
  await requireRegister(tx, order);
  if (!withPayment) await requireWork(user, order.pfi_id);
  const ref = refOf(order);

  await refuseIfIssued(tx, order, ref);
  if (order.status !== "Released") {
    const why = order.status === "Pending"
      ? "its payment has not been confirmed yet"
      : `it is ${order.status}`;
    throw httpError(409, `${ref} cannot be given tickets — ${why}.`);
  }

  const { picked, total } = await pickExact(tx, order, ref, ticketIds);

  const staffId = user?.id == null ? null : Number(user.id);
  const ids = picked.map((t) => Number(t.id));
  await tx.execute(sql`
    UPDATE gantry_tickets
       SET order_id = ${Number(order.id)}, issued_at = now(), issued_by = ${staffId}, issued_by_name = ${actorName}
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);

  const numbers = picked.map((t) => t.ticket_number);
  const actor = { type: "staff", staffId };
  const via = withPayment ? "payment" : "stock_desk";
  await auditLogRepo.record({
    entityType: "order",
    entityId: Number(order.id),
    action: "order.gantry_tickets_issued",
    actor,
    metadata: { pfiId: Number(order.pfi_id), tickets: numbers, ticketIds: ids, litres: total, via },
  }, tx);

  await stepToCompleted(
    { id: Number(order.id), pfiId: Number(order.pfi_id), quantity: Number(order.quantity) },
    {
      tx,
      actor,
      note: `Gantry tickets ${numbers.join(", ")}`,
      metadata: { trigger: "gantry_tickets", tickets: numbers, via },
    },
  );

  return { ref, numbers, litres: total };
};

/**
 * Issue a paid order's tickets. Their litres must come to the order's
 * quantity; issuing them completes the order.
 */
const issue = async ({ orderId, ticketIds, user, actorName = "" }) => {
  if (!(await register.tablesReady())) throw unavailable();
  const result = await db.transaction((tx) => issueWithin(tx, { orderId, ticketIds, user, actorName }));
  return { ...result, tickets: await ticketsForOrder(orderId) };
};

/**
 * Tickets picked with a payment, checked before the money is written: every
 * check issuing makes except the order's status, which the payment is about
 * to move. A wrong pick then refuses the whole confirmation before any desk is
 * told the order was released.
 */
const checkWithPayment = async (tx, { orderId, ticketIds }) => {
  if (!(await register.tablesReady(tx))) throw unavailable();
  const order = await lockOrder(tx, orderId);
  await requireRegister(tx, order);
  const ref = refOf(order);
  await refuseIfIssued(tx, order, ref);
  await pickExact(tx, order, ref, ticketIds);
  return { ref };
};

/**
 * Correct a completed order's tickets: the ones it gave up are left again,
 * the new ones are sold on it. The total must not change — the stock movement
 * already written is for the order's quantity.
 */
const change = async ({ orderId, ticketIds, reason, user, actorName = "" }) => {
  if (!(await register.tablesReady())) throw unavailable();
  const why = String(reason || "").trim();
  if (!why) throw httpError(400, "Say why the tickets are being changed.");

  const result = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order.pfi_id) throw httpError(409, "This order has no PFI.");
    await requireWork(user, order.pfi_id);
    const ref = refOf(order);

    const current = rowsOf(await tx.execute(sql`
      SELECT * FROM gantry_tickets WHERE order_id = ${Number(order.id)} ORDER BY id FOR UPDATE
    `));
    if (!current.length) throw httpError(409, `${ref} has no tickets to change. Issue them instead.`);

    const picked = await lockPicked(tx, { pfiId: order.pfi_id, ticketIds, orderId: order.id });
    const total = picked.reduce((s, t) => s + Number(t.qty_litres), 0);
    if (total !== Number(order.quantity)) {
      throw httpError(
        409,
        `The tickets picked come to ${litres(total)}; ${ref} is for ${litres(order.quantity)}. They must match exactly.`,
      );
    }

    const keep = new Set(picked.map((t) => Number(t.id)));
    const was = new Set(current.map((t) => Number(t.id)));
    const released = current.filter((t) => !keep.has(Number(t.id)));
    const added = picked.filter((t) => !was.has(Number(t.id)));
    if (!released.length && !added.length) throw httpError(409, "Those are already the order's tickets.");

    const staffId = user?.id == null ? null : Number(user.id);
    if (released.length) {
      await tx.execute(sql`
        UPDATE gantry_tickets
           SET order_id = NULL, issued_at = NULL, issued_by = NULL, issued_by_name = ''
         WHERE id IN (${sql.join(released.map((t) => sql`${Number(t.id)}`), sql`, `)})
      `);
    }
    if (added.length) {
      await tx.execute(sql`
        UPDATE gantry_tickets
           SET order_id = ${Number(order.id)}, issued_at = now(), issued_by = ${staffId}, issued_by_name = ${actorName}
         WHERE id IN (${sql.join(added.map((t) => sql`${Number(t.id)}`), sql`, `)})
      `);
    }

    const before = current.map((t) => t.ticket_number);
    const after = picked.map((t) => t.ticket_number);
    await auditLogRepo.record({
      entityType: "order",
      entityId: Number(order.id),
      action: "order.gantry_tickets_changed",
      actor: { type: "staff", staffId },
      metadata: { pfiId: Number(order.pfi_id), before, after, reason: why },
    }, tx);

    return { ref, before, after };
  });

  return { ...result, tickets: await ticketsForOrder(orderId) };
};

/** Where an order stands on the stock desk. */
const stageOf = (status, ticketCount) => {
  if (ticketCount > 0) return "issued";
  if (status === "Pending") return "awaiting_payment";
  if (status === "Paid" || status === "Released") return "awaiting_tickets";
  return "closed"; // Cancelled or Expired, never ticketed
};

/**
 * The stock desk: every order on a PFI sold ticket by ticket, newest first,
 * with its tickets. A person assigned to PFIs sees only those PFIs' orders.
 */
const deskOrders = async (user) => {
  if (!(await register.tablesReady())) return { orders: [], pfis: [] };
  const scoped = scopedPfiIds(user);
  const scope = scoped ? sql`AND o.pfi_id IN (${sql.join(scoped.map((id) => sql`${id}`), sql`, `)})` : sql``;

  const rows = rowsOf(await db.execute(sql`
    SELECT o.id, o.created_at, o.status, o.payment_status, o.quantity, o.total_amount,
           o.payment_confirmed_at, o.released_at, o.completed_at,
           o.pfi_id, p.pfi_number, d.name AS depot_name, pr.name AS product_name,
           COALESCE(NULLIF(o.company_name, ''), c.company_name) AS company_name,
           COALESCE(NULLIF(o.company_name, ''), NULLIF(c.company_name, ''), NULLIF(c.name, ''), '') AS customer_name,
           COALESCE(tk.tickets, '[]'::json) AS tickets
      FROM orders o
      JOIN gantry_ticket_registers r ON r.pfi_id = o.pfi_id
      JOIN pfis p ON p.id = o.pfi_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN depots d ON d.id = o.depot_id
      LEFT JOIN products pr ON pr.id = o.product_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', t.id, 'ticketNumber', t.ticket_number, 'qtyLitres', t.qty_litres,
                 'issuedAt', t.issued_at, 'issuedByName', t.issued_by_name
               ) ORDER BY t.id) AS tickets
          FROM gantry_tickets t WHERE t.order_id = o.id
      ) tk ON true
     WHERE true ${scope}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT 5000
  `));

  const orders = rows.map((r) => {
    const tickets = Array.isArray(r.tickets) ? r.tickets : JSON.parse(r.tickets || "[]");
    const last = tickets.reduce((m, t) => (!m || String(t.issuedAt) > String(m.issuedAt) ? t : m), null);
    return {
      id: Number(r.id),
      reference: generateOrderReference(r.company_name, Number(r.id)),
      createdAt: r.created_at,
      status: r.status,
      paymentStatus: r.payment_status,
      quantity: Number(r.quantity),
      totalAmount: Number(r.total_amount),
      paymentConfirmedAt: r.payment_confirmed_at,
      completedAt: r.completed_at,
      pfiId: Number(r.pfi_id),
      pfiNumber: r.pfi_number,
      depotName: r.depot_name || "",
      productName: r.product_name || "",
      customerName: r.customer_name || "",
      stage: stageOf(r.status, tickets.length),
      tickets: tickets.map((t) => ({ ...t, id: Number(t.id), qtyLitres: Number(t.qtyLitres) })),
      issuedAt: last?.issuedAt ?? null,
      issuedByName: last?.issuedByName ?? "",
    };
  });

  // The PFIs on the desk, with their tickets left, for the filter and the strip.
  const pfiRows = rowsOf(await db.execute(sql`
    SELECT p.id, p.pfi_number, p.status,
           COUNT(t.id) FILTER (WHERE t.voided_at IS NULL AND t.order_id IS NULL)::int AS left_count,
           COALESCE(SUM(t.qty_litres) FILTER (WHERE t.voided_at IS NULL AND t.order_id IS NULL), 0)::bigint AS left_litres
      FROM gantry_ticket_registers r
      JOIN pfis p ON p.id = r.pfi_id
      LEFT JOIN gantry_tickets t ON t.pfi_id = p.id
     WHERE true ${scoped ? sql`AND p.id IN (${sql.join(scoped.map((id) => sql`${id}`), sql`, `)})` : sql``}
     GROUP BY p.id
     ORDER BY p.id DESC
  `));
  const workable = await workableAmong(user, pfiRows.map((p) => p.id));
  const pfis = pfiRows.map((p) => ({
    id: Number(p.id),
    pfiNumber: p.pfi_number,
    status: p.status,
    ticketsLeft: Number(p.left_count) || 0,
    litresLeft: Number(p.left_litres) || 0,
    // Whether this person may issue tickets on it — the server checks again.
    canWork: workable.has(Number(p.id)),
  }));

  return { orders, pfis };
};

module.exports = {
  canWork,
  listForPfi,
  addTickets,
  voidTicket,
  issue,
  issueWithin,
  checkWithPayment,
  change,
  ticketsForOrder,
  forOrder,
  deskOrders,
  stageOf,
  maySeeDesk,
  STOCK_ROLE,
};
